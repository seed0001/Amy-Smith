import { Ollama } from 'ollama';
import { config } from './config.js';
import { streamChatGPT, chatGPTJson } from './chatgpt-provider.js';
import { chatgptAuth } from './chatgpt-auth.js';
import { providerRequestError } from './provider-failover.js';
import { generateFluxImage } from './flux.js';
import { generateKontextImage } from './kontext.js';

const ollama = new Ollama({ host: config.ollama.host });
const KEEP_ALIVE = '30m';

// Tool rounds per reply (TOOL_ROUNDS in .env): enough to look something up and then act on it. The
// classifier is advisory; file and code work can earn a bounded multistep allowance.
const MAX_TOOL_ROUNDS = Math.max(1, Number(process.env.TOOL_ROUNDS) || 4);
// A tool result that failed or came back incomplete (see runTool's result header in tools.js).
const SETBACK = /^\[[\w-]+: error|^Error|TRUNCATED|NOT READ/;
const LOOKUP_FILLERS = ['Hang on, let me look that up.', 'One sec, checking.', 'Let me look into that real quick.'];

// Streams a chat reply, calling onSentence for each complete sentence as it arrives
// (so voice can start speaking before the whole reply is generated). Returns the full text.
// If tools are given, the model may call them; results are fed back and it keeps going.
// maxRounds: how many times the model may call tools before it must answer. repeatable: tools it
// may call more than once (working on files takes read, edit, read again); every other tool runs
// at most once per reply.
// free: bookkeeping tools (her notes); a round that only uses those doesn't count against
// maxRounds, up to two such rounds, so taking a note never costs her the reply.
export async function chat(messages, { onSentence, tools = [], runTool, maxRounds = MAX_TOOL_ROUNDS, repeatable = [], expandOnTools = [], free = [], voice = false, onUsage, streamFactory = startChat } = {}) {
  messages = [...messages];
  maxRounds = Math.max(1, Math.min(12, Number(maxRounds) || MAX_TOOL_ROUNDS));
  let full = '';
  let spoke = false;
  const used = new Set();
  let paid = 0, freeRounds = 0, nudged = false, retried = false;
  const outcomes = []; // "files read: ok", for the notice when rounds run out
  const say = async (sentence) => {
    spoke = true;
    await onSentence(sentence);
  };

  for (let round = 0; ; round++) {
    const offerTools = tools.length > 0 && paid < maxRounds;
    const stream = await streamFactory(messages, offerTools ? tools : null, voice);

    let content = '';
    let pending = '';
    let calls = [];
    let usage = null;
    let responseOutput;
    let roundProvider, roundModel;
    for await (const part of stream) {
      if (part.provider) { roundProvider = part.provider; roundModel = part.model; }
      if (part.responseOutput) responseOutput = part.responseOutput;
      if (part.usage) {
        usage = {
          prompt: part.usage.prompt_tokens,
          completion: part.usage.completion_tokens,
          total: part.usage.total_tokens,
          cost: part.usage.cost,
        };
      } else if (part.prompt_eval_count != null) {
        usage = {
          prompt: part.prompt_eval_count,
          completion: part.eval_count ?? 0,
          total: (part.prompt_eval_count ?? 0) + (part.eval_count ?? 0),
        };
      }
      if (part.message?.tool_calls?.length) calls.push(...part.message.tool_calls);
      const chunk = part.message?.content ?? '';
      content += chunk;
      if (!onSentence) continue;
      pending += chunk;
      let cut;
      // The first piece she says can end at a comma or dash, so speech starts on a short phrase.
      while ((cut = findSentenceEnd(pending, !spoke)) !== -1) {
        const sentence = pending.slice(0, cut).trim();
        pending = pending.slice(cut);
        if (sentence) await say(sentence);
      }
    }
    if (onSentence && pending.trim()) await say(pending.trim());
    if (usage) onUsage?.({ ...usage, round, ...(roundProvider ? { provider: roundProvider, model: roundModel } : {}) });
    if (content.trim()) full += (full ? ' ' : '') + content.trim();
    // Even a provider that invents calls after tools are withdrawn cannot run indefinitely.
    if (!offerTools && calls.length) return full || 'I reached the action limit for this reply. The remaining work needs another turn.';
    if (calls.some((c) => expandOnTools.includes(c.function.name) && tools.some((t) => t.function.name === c.function.name))) maxRounds = 12;
    // Each tool at most once per reply (unless repeatable), even if the model asks for it again.
    calls = calls.map((call, index) => ({ ...call, id: call.id || `amy_call_${round}_${index}` }));
    const blockedCalls = new Set();
    for (const call of calls) {
      if (!repeatable.includes(call.function.name) && used.has(call.function.name)) blockedCalls.add(call);
      else used.add(call.function.name);
    }
    if (!calls.length) {
      // Tools ran but nothing was said: ask once more, without tools, for the actual reply.
      if (!full.trim() && round > 0 && !nudged) {
        nudged = true;
        paid = maxRounds;
        messages.push({ role: 'user', content: '(Now reply to them. Say your answer out loud; no tools.)' });
        continue;
      }
      return full;
    }
    if (calls.every((c) => free.includes(c.function.name)) && freeRounds < 2) freeRounds++;
    else paid++;

    // Avoid dead air in voice while a tool runs.
    if (onSentence && !spoke && calls.some((c) => c.function.name === 'web_search')) await say(LOOKUP_FILLERS[Math.floor(Math.random() * LOOKUP_FILLERS.length)]);
    messages.push({ role: 'assistant', content, tool_calls: calls, ...(responseOutput ? { _responsesOutput: responseOutput } : {}) });
    let setback = false;
    for (const call of calls) {
      const result = blockedCalls.has(call)
        ? `[${call.function.name}: error conflict] This tool already ran in this reply. Use its existing result instead of repeating it.`
        : await runTool(call.function.name, call.function.arguments);
      const bad = SETBACK.test(result);
      if (bad) {
        setback = true;
        if (!blockedCalls.has(call)) used.delete(call.function.name); // a failed call may be retried
      }
      if (!free.includes(call.function.name)) {
        let action = '';
        try { action = JSON.parse(call.function.arguments || '{}').action ?? ''; } catch {}
        outcomes.push(`${call.function.name}${action ? ` ${action}` : ''}: ${bad ? (/TRUNCATED|NOT READ/.test(result) ? 'incomplete' : 'failed') : 'ok'}`);
      }
      messages.push({ role: 'tool', content: result, tool_name: call.function.name, tool_call_id: call.id });
    }
    // An error or a cut-short read gets one more round to fix the call or read on, even when the
    // turn's rounds are used up, instead of answering on half the facts. Once per reply.
    if (setback && paid >= maxRounds && !retried) {
      retried = true;
      paid = maxRounds - 1;
    }
    // Out of rounds: say so, with what was done, so the answer is honest about what isn't.
    if (paid >= maxRounds && tools.length) {
      messages.push({
        role: 'user',
        content: `(No more tool rounds this reply. Calls made: ${outcomes.join('; ') || 'none'}. Answer now; be clear about anything that failed or isn't finished, and that it can be continued next message.)`,
      });
    }
  }
}

async function startChat(messages, tools, voice = false) {
  const { providerRouter } = await import('./provider-router.js');
  return providerRouter.stream(messages, (provider, history) => startChatDirect(history, tools, voice, provider));
}

async function startChatDirect(messages, tools, voice = false, provider = config.brain) {
  if (provider === 'chatgpt') return voice ? chatGPTFast(messages, tools) : streamChatGPT(messages, { model: config.chatgpt.model, tools });
  if (provider === 'openrouter') return openRouterChat(messages, tools, voice);
  if (provider === 'mistral') return mistralChat(messages, tools);
  const localMessages = messages.map(({ _responsesOutput, ...message }) => ({ ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments } })) } : {}) }));
  const request = {
    model: config.ollama.model,
    messages: localMessages,
    stream: true,
    think: config.ollama.think,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: config.ollama.numCtx },
  };
  if (!tools) return ollama.chat(request);
  try {
    return await ollama.chat({ ...request, tools });
  } catch (err) {
    // Models without tool support: just answer without tools.
    if (/does not support tools/i.test(err.message)) return ollama.chat(request);
    throw err;
  }
}

// Voice on ChatGPT: the fast model, low effort. If that model isn't on this account (or is
// retired), the main model answers instead, so a missing fast model never breaks voice.
const isModelError = (err) => /model/i.test(err?.message || '') && [400, 403, 404].includes(Number(err?.status) || 400);
async function* chatGPTFast(messages, tools) {
  const fast = config.chatgpt.fastModel || config.chatgpt.model;
  let started = false;
  try {
    for await (const part of streamChatGPT(messages, { model: fast, tools, effort: 'low' })) { started = true; yield part; }
  } catch (err) {
    if (started || fast === config.chatgpt.model || !isModelError(err)) throw err;
    yield* streamChatGPT(messages, { model: config.chatgpt.model, tools, effort: 'low' });
  }
}

// ---- OpenRouter: OpenAI-style chat completions, streamed as server-sent events ----

const OPENROUTER = 'https://openrouter.ai/api/v1';
export const openRouterHeaders = () => ({
  Authorization: `Bearer ${config.openrouter.apiKey}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'http://127.0.0.1', // shows up as the app in OpenRouter's activity log
  'X-Title': config.botName,
});

// Yields the same shape as Ollama's stream ({ message: { content, tool_calls } }) so chat()
// handles both. Reasoning tokens are dropped: only the answer is spoken.
async function* openRouterChat(messages, tools, voice = false) {
  // Spoken replies use their own (default: no) reasoning: on Grok 4.20 medium reasoning alone added
  // about 10 seconds before the first word. Text and tool work keep the main setting.
  const effort = voice ? config.openrouter.voiceReasoning : config.openrouter.reasoning;
  if (!config.openrouter.apiKey) throw new Error('OpenRouter is the brain, but OPENROUTER_API_KEY is empty in .env');
  const body = {
    model: config.openrouter.model,
    stream: true,
    messages: messages.map(toOpenAI),
    ...(effort === 'none' ? { reasoning: { enabled: false } } : { reasoning: { effort, exclude: true } }),
  };
  if (tools) body.tools = tools;
  const res = await fetch(`${OPENROUTER}/chat/completions`, { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'openrouter', res.status);
  yield* readOpenAIStream(res, 'openrouter');
}

// ---- Mistral: the same OpenAI-style API, on Mistral's own cloud ----

const MISTRAL = 'https://api.mistral.ai/v1';
const mistralHeaders = () => ({ Authorization: `Bearer ${config.mistral.apiKey}`, 'Content-Type': 'application/json' });
// Mistral only accepts tool call ids of exactly 9 letters/digits, so ids from other providers (or
// none) are mapped to a stable 9-character one. A call and its result map the same way, so they still pair.
const mistralId = (id) => {
  const raw = String(id ?? '');
  if (/^[a-zA-Z0-9]{9}$/.test(raw)) return raw;
  let h = 5381;
  for (const ch of raw) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return (h.toString(36) + 'mistral00').slice(0, 9);
};
const toMistral = (m) => {
  const o = toOpenAI(m);
  if (o.role === 'tool') return { ...o, tool_call_id: mistralId(o.tool_call_id) };
  if (o.tool_calls) return { ...o, content: o.content ?? '', tool_calls: o.tool_calls.map((c) => ({ ...c, id: mistralId(c.id) })) };
  return o;
};

async function* mistralChat(messages, tools) {
  if (!config.mistral.apiKey) throw new Error('Mistral is the brain, but MISTRAL_API_KEY is empty in .env');
  const body = { model: config.mistral.model, stream: true, messages: messages.map(toMistral), ...(tools && { tools }) };
  const res = await fetch(`${MISTRAL}/chat/completions`, { method: 'POST', headers: mistralHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'mistral', res.status);
  yield* readOpenAIStream(res, 'mistral');
}

// Server-sent chat completion chunks, yielded in Ollama's shape ({ message: { content, tool_calls } }).
async function* readOpenAIStream(res, provider) {
  const calls = []; // tool calls arrive in pieces, keyed by index
  const dec = new TextDecoder();
  let buf = '';
  for await (const bytes of res.body) {
    buf += dec.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // blank lines and ": OPENROUTER PROCESSING" keep-alives
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const chunk = JSON.parse(data);
      if (chunk.error) throw providerRequestError(chunk, provider);
      const delta = chunk.choices?.[0]?.delta ?? {};
      for (const tc of delta.tool_calls ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
      if (delta.content) yield { message: { content: delta.content } };
      // OpenRouter includes usage on the final chunk (choices is empty there).
      if (chunk.usage) yield { message: { content: '' }, usage: chunk.usage };
    }
  }
  if (calls.length) yield { message: { content: '', tool_calls: calls.filter(Boolean) } };
}

// Ollama-style history to OpenAI style: tool calls need ids and string arguments.
function toOpenAI(m) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id ?? m.tool_name, content: m.content };
  // Pictures someone sent: Ollama takes raw base64 in `images`; OpenAI style wants content parts.
  if (m.images?.length) {
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content }, ...m.images.map((b64, i) => ({ type: 'image_url', image_url: { url: `data:${m.imageTypes?.[i] ?? 'image/png'};base64,${b64}` } }))],
    };
  }
  if (!m.tool_calls) return { role: m.role, content: m.content };
  return {
    role: 'assistant',
    content: m.content || null,
    tool_calls: m.tool_calls.map((c) => ({
      id: c.id ?? c.function.name,
      type: 'function',
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) },
    })),
  };
}

async function mistralJson(messages) {
  if (!config.mistral.apiKey) throw new Error('Mistral is the brain, but MISTRAL_API_KEY is empty in .env');
  const res = await fetch(`${MISTRAL}/chat/completions`, {
    method: 'POST',
    headers: mistralHeaders(),
    body: JSON.stringify({ model: config.mistral.model, messages: messages.map(toMistral), response_format: { type: 'json_object' }, temperature: 0 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'mistral', res.status);
  const text = (await res.json()).choices?.[0]?.message?.content ?? '';
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

// Whether her current brain can look at pictures itself (else describeImages() looks for her).
let visionCache = { key: '', can: false };
export async function canSee() {
  const { activeReplyProvider } = await import('./provider-router.js');
  const provider = activeReplyProvider();
  if (provider === 'chatgpt') {
    const model = (await chatgptAuth.models()).find((m) => m.id === config.chatgpt.model);
    // Explicitly false means route to the existing vision fallback; absent capability is unknown.
    return model?.vision !== false;
  }
  // Mistral: the vision fallback describes pictures for her (not every Mistral model takes images).
  if (provider === 'mistral') return false;
  const key = provider === 'openrouter' ? `or:${config.openrouter.model}` : `ol:${config.ollama.model}`;
  if (visionCache.key === key) return visionCache.can;
  let can = false;
  try {
    if (provider === 'openrouter') {
      const res = await fetch(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
      const { data } = await res.json();
      can = data.find((m) => m.id === config.openrouter.model)?.architecture?.input_modalities?.includes('image') ?? false;
    } else {
      can = (await ollama.show({ model: config.ollama.model })).capabilities?.includes('vision') ?? false;
    }
  } catch {
    return false; // couldn't check: describe them, and ask again next time
  }
  visionCache = { key, can };
  return can;
}

// For a brain that can't see: a vision model on OpenRouter describes the pictures in detail, and
// she gets the description as text.
export async function describeImages(images, question) {
  if (!config.openrouter.apiKey) throw new Error("this brain can't see images and there's no OpenRouter key for a vision model");
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: config.openrouter.visionModel,
      messages: [toOpenAI({
        role: 'user',
        content: `Describe ${images.length > 1 ? 'each of these images' : 'this image'} thoroughly for someone who can't see it: what's in it, any people and what they're doing, the setting, colors and mood, and every bit of text exactly as written (signs, screenshots, documents, code, captions). If it's a screenshot of an app, chat, error or code, transcribe it. The person who sent it said: "${question || '(nothing)'}"`,
        images: images.map((i) => i.base64),
        imageTypes: images.map((i) => i.mime),
      })],
    }),
  });
  if (!res.ok) throw new Error(`vision model (${config.openrouter.visionModel}) failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
}

// OpenRouter's catalogue, for the dashboard's model pickers.
export async function openRouterModels() {
  const res = await fetch(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter model list failed (${res.status})`);
  const { data } = await res.json();
  return data.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.supported_parameters?.includes('reasoning') ?? false,
    tools: m.supported_parameters?.includes('tools') ?? false,
    image: m.architecture?.output_modalities?.includes('image') ?? false,
    price: Number(m.pricing?.prompt) * 1e6, // dollars per million input tokens
    outPrice: Number(m.pricing?.completion) * 1e6,
    context: m.context_length ?? 0,
    created: m.created ?? 0,
  }));
}

// The strongest families for each kind of work, best first. OpenRouter doesn't rate models, so this
// is the judgment; within a family the newest model wins. Only models that can use tools qualify.
const FAMILIES = {
  coding: [/anthropic\/claude-opus/, /anthropic\/claude-sonnet/, /openai\/gpt-[\d.]+-?(sol|codex)?(-pro)?$/, /google\/gemini-[\d.]+-(argon|pro)/, /moonshotai\/kimi/, /deepseek\/deepseek/, /qwen\/qwen[\d.]*-coder/, /z-ai\/glm/, /mistralai\/(devstral|codestral)/, /minimax\/minimax/],
  reasoning: [/openai\/gpt-[\d.]+-?(sol)?-pro/, /anthropic\/claude-opus/, /google\/gemini-[\d.]+-(pro|argon)/, /openai\/gpt-[\d.]+/, /deepseek\/deepseek/, /moonshotai\/kimi/, /qwen\/qwen/, /x-ai\/grok/],
  general: [/anthropic\/claude-(sonnet|opus)/, /openai\/gpt-[\d.]+/, /google\/gemini-[\d.]+-(pro|flash)/, /deepseek\/deepseek/, /moonshotai\/kimi/, /meta\/muse/, /mistralai\/mistral-large/],
  cheap: [/deepseek\/deepseek.*flash/, /google\/gemini-[\d.]+-flash/, /anthropic\/claude-haiku/, /minimax\/minimax.*flash/, /qwen\/qwen/, /mistralai\/mistral/, /inception\/mercury/],
};

// Up to `count` models for a purpose, best first, one per family (its newest).
export async function rankModels(purpose = 'coding', count = 5) {
  const families = FAMILIES[purpose] ?? FAMILIES.general;
  // Skip aliases ("~…-latest"), previews, dated snapshots, and free/batch variants.
  const usable = (await openRouterModels()).filter(
    (m) => m.tools && !m.image && !/^~|preview|customtools|:(free|batch|beta)$|-\d{4}$/.test(m.id) && m.price >= 0 && (purpose !== 'cheap' || m.price <= 0.5),
  );
  const picks = [];
  for (const family of families) {
    const best = usable.filter((m) => family.test(m.id) && !picks.includes(m)).sort((a, b) => b.created - a.created)[0];
    if (best) picks.push(best);
    if (picks.length >= count) break;
  }
  return picks;
}

// Music with Google's Lyria 3: a 30-second clip or a full-length song, as MP3 bytes. OpenRouter
// only returns audio when streamed; it arrives as base64 pieces in delta.audio.data.
export async function generateMusic(prompt, length = 'clip') {
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY is empty in .env');
  const model = length === 'full' ? config.openrouter.songModel : config.openrouter.clipModel;
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({ model, stream: true, modalities: ['text', 'audio'], audio: { format: 'mp3' }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Music generation (${model}) failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const dec = new TextDecoder();
  let buf = '', audio = '', text = '';
  for await (const bytes of res.body) {
    buf += dec.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
      const chunk = JSON.parse(line.slice(5));
      if (chunk.error) throw new Error(`Music generation: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.audio?.data) audio += delta.audio.data;
      if (delta.content) text += delta.content;
    }
  }
  if (!audio) throw new Error(`${model} returned no audio${text ? `: ${text.slice(0, 200)}` : ''}`);
  // Lyria times its lyrics ("[12.5:] line"); the timestamps aren't for reading.
  return { bytes: Buffer.from(audio, 'base64'), lyrics: text.replace(/\[\d+(\.\d+)?:?\]\s*/g, '').trim() };
}

// One-shot image generation. Returns PNG/JPEG bytes and any text the model added.
// references = [{ mime, bytes }] (or a data URL in `url`): identity images the model must keep,
// used for her reference sheet so new outfits keep the same face and body. The Image API takes
// them as input_references; older/custom image models fall back to chat completions.
export async function generateImage(prompt, references = []) {
  if (config.imageProvider === 'flux') return generateFluxImage(prompt, references);
  if (config.imageProvider === 'kontext') return generateKontextImage(prompt, references);
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY is empty in .env');
  const refs = (Array.isArray(references) ? references : [references])
    .filter(Boolean)
    .map((r) => ({
      type: 'image_url',
      image_url: {
        url: r.url ?? `data:${r.mime || 'image/png'};base64,${r.base64 ?? Buffer.from(r.bytes).toString('base64')}`,
      },
    }));
  const res = await fetch(`${OPENROUTER}/images`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouter.imageModel,
      prompt,
      n: 1,
      ...(refs.length ? { input_references: refs } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.ok) {
    const data = await res.json();
    const item = data.data?.[0] ?? {};
    const fromUrl = item.url?.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    const base64 = item.b64_json ?? fromUrl?.[2];
    if (!base64) {
      throw new Error(
        `${config.openrouter.imageModel} returned no image${data.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : ''}`,
      );
    }
    return { mime: item.media_type || fromUrl?.[1] || 'image/png', bytes: Buffer.from(base64, 'base64'), text: item.revised_prompt || '' };
  }
  const firstError = await res.text().catch(() => '');
  // A custom image model may only implement the chat-completions route.
  if (![400, 404, 405, 422].includes(res.status)) {
    throw new Error(`Image generation (${config.openrouter.imageModel}) failed (${res.status}): ${firstError.slice(0, 300)}`);
  }
  return generateImageChat(prompt, refs, firstError);
}

async function generateImageChat(prompt, refs, firstError) {
  const content = refs.length ? [{ type: 'text', text: prompt }, ...refs] : prompt;
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouter.imageModel,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')) || firstError;
    throw new Error(`Image generation (${config.openrouter.imageModel}) failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const message = (await res.json()).choices?.[0]?.message ?? {};
  const url = message.images?.[0]?.image_url?.url;
  const m = url?.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) throw new Error(`${config.openrouter.imageModel} returned no image${message.content ? `: ${String(message.content).slice(0, 200)}` : ''}`);
  return { mime: m[1], bytes: Buffer.from(m[2], 'base64'), text: message.content || '' };
}

// One non-streamed step for a background helper: the model's message, with any tool calls.
export async function agentStep(messages, tools, model) {
  if (!config.openrouter.apiKey) throw new Error('Background helpers need OPENROUTER_API_KEY in .env');
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({ model, messages: messages.map(toOpenAI), tools, reasoning: { effort: 'medium', exclude: true } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`OpenRouter (${model}) failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.error) throw new Error(`OpenRouter: ${data.error.message ?? JSON.stringify(data.error)}`);
  const m = data.choices?.[0]?.message ?? {};
  return { content: m.content ?? '', tool_calls: m.tool_calls ?? [] };
}

// A fast JSON answer from whichever brain is on (no reasoning), for planning each reply.
export async function quickJson(messages) {
  const { providerRouter } = await import('./provider-router.js');
  return providerRouter.execute((provider) => quickJsonDirect(messages, provider));
}

async function quickJsonDirect(messages, provider) {
  if (provider === 'chatgpt') {
    const fast = config.chatgpt.fastModel;
    if (!fast || fast === config.chatgpt.model) return chatGPTJson(messages, config.chatgpt.model);
    return chatGPTJson(messages, fast).catch((err) => (isModelError(err) ? chatGPTJson(messages, config.chatgpt.model) : Promise.reject(err)));
  }
  if (provider === 'mistral') return mistralJson(messages);
  if (provider !== 'openrouter') return json(messages);
  if (!config.openrouter.apiKey) throw new Error('OpenRouter is the brain, but OPENROUTER_API_KEY is empty in .env');
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({ model: config.openrouter.model, messages, response_format: { type: 'json_object' }, reasoning: { enabled: false }, temperature: 0 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'openrouter', res.status);
  const data = await res.json();
  if (data.error) throw providerRequestError(data, 'openrouter');
  const text = data.choices?.[0]?.message?.content ?? '';
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
}

// One-shot JSON completion on local Ollama, used for background memory extraction.
export async function json(messages) {
  const res = await ollama.chat({
    model: config.ollama.model,
    messages,
    format: 'json',
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: config.ollama.numCtx }, // same as chat, or Ollama reloads the model
  });
  try {
    return JSON.parse(res.message.content);
  } catch {
    return null;
  }
}

// Plain local completion, never OpenRouter and never with tools. Solo thoughts use this so they
// stay free and private even when config.brain is 'openrouter'. Pass { format: 'json' } for a
// constrained JSON answer.
export async function localChat(messages, { format } = {}) {
  const res = await ollama.chat({
    model: config.ollama.model,
    messages,
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: config.ollama.numCtx },
    ...(format ? { format } : {}),
  });
  return res.message?.content ?? '';
}

export async function embed(texts) {
  const res = await ollama.embed({ model: config.ollama.embedModel, input: texts, keep_alive: KEEP_ALIVE });
  return res.embeddings;
}

export async function listModels() {
  const { models } = await ollama.list();
  return models.map((m) => ({ name: m.name, size: m.size, family: m.details?.family, capabilities: m.capabilities ?? [] }));
}

export async function checkOllama() {
  const { models } = await ollama.list();
  const names = new Set(models.map((m) => m.name));
  const has = (n) => names.has(n) || names.has(`${n}:latest`);
  for (const m of [config.ollama.model, config.ollama.embedModel]) {
    if (!has(m)) throw new Error(`Ollama model "${m}" not found. Run: ollama pull ${m}`);
  }
}

// Index just past the first sentence terminator followed by whitespace, or -1.
// Requires a few characters so "Mr." or "1." at the very start don't split.
function findSentenceEnd(text, early = false) {
  const re = /[.!?…]+["')\]]*\s|\n+/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index >= 12 || m[0].startsWith('\n')) return m.index + m[0].length;
  }
  if (early) {
    const pause = /[,;:—–]\s/g;
    while ((m = pause.exec(text))) if (m.index >= 20) return m.index + m[0].length;
  }
  return -1;
}
