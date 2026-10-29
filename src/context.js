import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { bus } from './events.js';
import { openRouterModels } from './llm.js';
import { chatgptAuth } from './chatgpt-auth.js';
import { activeReplyProvider, activeReplyModel } from './provider-router.js';
import { PARAGRAPHS_PER_ROLLUP, ROLLUP_AGE_MS } from './summaries.js';

// How much of her context window each reply is using, and what it's made of. A snapshot is taken
// just before the reply prompt is sent; the provider's own token counts are attached afterwards
// when the model reports them. The estimates are about 4 characters per token.
const FILE = path.join(DATA_DIR, 'context.jsonl');
const MAX = 200;
const KEEP_RECENT = 30;

const estimate = (text) => Math.ceil(String(text ?? '').length / 4);
const number = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

function load() {
  try {
    if (!existsSync(FILE)) return [];
    const lines = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const rows = lines.slice(-MAX).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    if (lines.length > MAX) writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return rows;
  } catch (err) {
    console.warn('Ignoring unreadable data/context.jsonl:', err.message);
    return [];
  }
}

let recent = load();
let appended = recent.length;

function persist(snapshot) {
  try {
    appendFileSync(FILE, JSON.stringify(snapshot) + '\n');
    appended++;
    if (appended >= MAX) {
      appended = 0;
      writeFileSync(FILE, recent.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  } catch (err) {
    console.warn('Could not write data/context.jsonl:', err.message);
  }
}

// ---- The model's context window ----

let capKey = '';
let cap = { tokens: 0, source: 'unknown' };
let lookingUp = null;
let lookingUpKey = null;

function syncCap() {
  const provider = activeReplyProvider();
  const key = provider === 'chatgpt' ? `chatgpt:${config.chatgpt.model}` : provider === 'openrouter'
    ? `openrouter:${config.openrouter.model}`
    : `ollama:${config.ollama.model}:${config.ollama.numCtx}`;
  if (key === capKey) return cap;
  capKey = key;
  if (provider === 'openrouter' || provider === 'chatgpt') {
    cap = { tokens: 0, source: `${provider === 'chatgpt' ? 'ChatGPT' : 'OpenRouter'} model context (looking up…)` };
    startLookup().catch(() => {});
  } else {
    cap = { tokens: config.ollama.numCtx, source: 'OLLAMA_NUM_CTX' };
  }
  return cap;
}

// OpenRouter's catalogue has each model's context_length. Cache it; the first lookup runs in the
// background so a reply never waits on it.
function startLookup() {
  const wanted = capKey;
  if (lookingUp) {
    // The brain or model changed while a lookup was in flight: queue one for the new key.
    if (lookingUpKey === wanted) return lookingUp;
    return lookingUp.finally(() => startLookup());
  }
  lookingUpKey = wanted;
  lookingUp = (async () => {
    try {
      const isChatGPT = wanted.startsWith('chatgpt:');
      const models = isChatGPT ? await chatgptAuth.models() : await openRouterModels();
      const found = models.find((m) => m.id === (isChatGPT ? config.chatgpt.model : config.openrouter.model));
      if (capKey !== wanted) return cap;
      if (found?.context) {
        cap = { tokens: found.context, source: `${isChatGPT ? 'ChatGPT' : 'OpenRouter'} model context (${found.id})` };
        for (const snapshot of recent) {
          snapshot.capTokens = cap.tokens;
          snapshot.percent = snapshot.capTokens ? (snapshot.totalTokens / snapshot.capTokens) * 100 : null;
          snapshot.headroom = snapshot.capTokens ? snapshot.capTokens - snapshot.totalTokens : null;
          if (snapshot.actual?.prompt) snapshot.actualPercent = (snapshot.actual.prompt / snapshot.capTokens) * 100;
        }
        bus.emit('context', last());
      } else if (capKey === wanted) {
        cap = { tokens: 0, source: `${isChatGPT ? 'ChatGPT' : 'OpenRouter'} model context unknown` };
      }
    } catch {
      if (capKey === wanted) cap = { tokens: 0, source: 'Cloud model context lookup failed' };
    } finally {
      lookingUp = null;
      lookingUpKey = null;
    }
    return cap;
  })();
  return lookingUp;
}

export async function refreshLimit() {
  syncCap();
  if (!['openrouter', 'chatgpt'].includes(activeReplyProvider())) return cap;
  return startLookup();
}

export function limits() {
  syncCap();
  return {
    contextTokens: cap.tokens,
    contextSource: cap.source,
    brain: activeReplyProvider(),
    model: activeReplyModel(),
    historyLimit: config.historyLimit,
    historyOverlap: 10,
    summaryEvery: config.historyLimit,
    paragraphsPerRollup: PARAGRAPHS_PER_ROLLUP,
    rollupAgeHours: Math.round(ROLLUP_AGE_MS / 3_600_000),
    memoryTopK: config.memory.topK,
    memoryMinScore: config.memory.minScore,
  };
}

// ---- Snapshots ----

const section = (label, text, extra = {}) => {
  const chars = String(text ?? '').length;
  return { label, chars, tokens: estimate(text), ...extra };
};

export function record({
  conversation,
  voice = false,
  character,
  speaker,
  system,
  history = [],
  current = '',
  tools = [],
  images = [],
  summary = {},
  memories = {},
  limits: given = {},
}) {
  const lim = { ...limits(), ...given };
  const systemSections = (system?.sections ?? []).map((s) => section(s.label, s.text));
  const historyText = history.map((m) => m.content ?? '').join('\n');
  const toolText = JSON.stringify(tools ?? []);
  const sections = [
    ...systemSections,
    section('History', historyText, { messages: history.length }),
    section('Current message', current),
    section('Tool schemas', toolText, { tools: tools.length }),
  ];
  if (images.length) {
    // Vision models price images by resolution, not characters. Rough only.
    sections.push({ label: 'Images', chars: 0, tokens: images.length * 1000, images: images.length, rough: true });
  }

  const totalTokens = sections.reduce((n, s) => n + s.tokens, 0);
  const systemTokens = systemSections.reduce((n, s) => n + s.tokens, 0);
  const capTokens = number(lim.contextTokens);
  const snapshot = {
    id: `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    conversation,
    voice: Boolean(voice),
    character: character?.name ?? null,
    speaker: speaker?.name ?? null,
    brain: activeReplyProvider(),
    model: lim.model,
    sections,
    systemTokens,
    systemChars: system?.content?.length ?? 0,
    totalTokens,
    totalChars: sections.reduce((n, s) => n + s.chars, 0),
    approx: true,
    capTokens,
    percent: capTokens ? (totalTokens / capTokens) * 100 : null,
    headroom: capTokens ? capTokens - totalTokens : null,
    history: { messages: history.length, tokens: sections.find((s) => s.label === 'History')?.tokens ?? 0 },
    current: { tokens: sections.find((s) => s.label === 'Current message')?.tokens ?? 0 },
    tools: { count: tools.length, tokens: sections.find((s) => s.label === 'Tool schemas')?.tokens ?? 0 },
    images: { count: images.length, tokens: images.length * 1000 },
    summary: { major: Boolean(summary.major), paragraphs: number(summary.paragraphs) },
    memories: { speaker: number(memories.speaker), others: number(memories.others) },
    limits: {
      historyLimit: lim.historyLimit,
      contextSource: lim.contextSource,
      contextTokens: lim.contextTokens,
    },
    actual: null,
    rounds: 0,
  };

  recent.push(snapshot);
  if (recent.length > MAX) recent.shift();
  persist(snapshot);
  bus.emit('context', snapshot);
  return snapshot;
}

// The provider's own count for a round: OpenRouter sends usage in its final stream chunk, Ollama
// sends prompt_eval_count/eval_count on the last part. Keep the first round (the base prompt) and
// the largest round (which includes tool results) for the dashboard.
export function attachUsage(snapshot, usage) {
  if (!snapshot || !usage) return snapshot;
  if (usage.provider) {
    snapshot.brain = usage.provider; snapshot.model = usage.model;
    syncCap(); snapshot.capTokens = cap.tokens;
    snapshot.percent = cap.tokens ? snapshot.totalTokens / cap.tokens * 100 : null;
    snapshot.limits.contextTokens = cap.tokens; snapshot.limits.contextSource = cap.source;
  }
  const prompt = number(usage.prompt ?? usage.prompt_tokens);
  const completion = number(usage.completion ?? usage.completion_tokens);
  const total = number(usage.total ?? usage.total_tokens) || prompt + completion;
  if (!prompt && !completion) return snapshot;
  snapshot.rounds = number(snapshot.rounds) + 1;
  if (!snapshot.actual) {
    snapshot.actual = { prompt, completion, total, cost: usage.cost ?? null, at: Date.now() };
  }
  snapshot.maxPrompt = Math.max(number(snapshot.maxPrompt), prompt);
  if (snapshot.capTokens && prompt) snapshot.actualPercent = (prompt / snapshot.capTokens) * 100;
  bus.emit('context', snapshot);
  return snapshot;
}

export function last() {
  return recent.at(-1) ?? null;
}

export function recentSnapshots(limit = KEEP_RECENT) {
  return recent.slice(-Math.max(1, Math.min(MAX, Number(limit) || KEEP_RECENT)));
}

// The small summary the overview card and /api/status carry.
export function brief() {
  const snapshot = last();
  if (!snapshot) return null;
  syncCap();
  return {
    at: snapshot.at,
    tokens: snapshot.totalTokens,
    cap: snapshot.capTokens || cap.tokens,
    percent: snapshot.capTokens ? snapshot.percent : cap.tokens ? (snapshot.totalTokens / cap.tokens) * 100 : null,
    actual: snapshot.actual?.prompt ?? null,
    history: snapshot.history?.messages ?? 0,
    historyLimit: snapshot.limits?.historyLimit ?? config.historyLimit,
    conversation: snapshot.conversation,
  };
}

export function stateForApi() {
  syncCap();
  return {
    last: last(),
    // The chart only needs the totals; dropping the section lists keeps the poll small.
    recent: recentSnapshots(KEEP_RECENT).map(({ sections, ...rest }) => ({ ...rest, sectionCount: sections.length })),
    limits: limits(),
  };
}

// ---- The last full prompts (data/turn-log.jsonl, written by companion.js) ----

const TURN_LOG = path.join(DATA_DIR, 'turn-log.jsonl');

function readTurns() {
  try {
    if (!existsSync(TURN_LOG)) return [];
    return readFileSync(TURN_LOG, 'utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const cleanMessage = (m) => {
  const { images, imageTypes, ...rest } = m ?? {};
  return { ...rest, ...(images?.length ? { images: images.length } : {}) };
};

export function recentTurns(limit = 10) {
  const n = Math.max(1, Math.min(30, Number(limit) || 10));
  return readTurns().slice(-n).map((turn) => {
    const messages = Array.isArray(turn.messages) ? turn.messages : [];
    return {
      ts: turn.ts,
      conversation: turn.conversation,
      speaker: turn.speaker,
      voice: Boolean(turn.voice),
      messages: messages.length,
      chars: messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0),
      tools: turn.tools ?? [],
      calls: (turn.calls ?? []).map((c) => c.name),
      replyChars: String(turn.reply ?? '').length,
    };
  });
}

export function lastTurn() {
  const turns = readTurns();
  const turn = turns.at(-1);
  if (!turn) return null;
  return {
    ...turn,
    messages: (turn.messages ?? []).map(cleanMessage),
    calls: (turn.calls ?? []).map((c) => ({ ...c, result: String(c.result ?? '').slice(0, 2000) })),
    reply: String(turn.reply ?? ''),
  };
}

// ---- A spoken/printed report for her self tool ----

const fmt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString() : '—');
const pct = (n) => (Number.isFinite(Number(n)) ? `${Number(n).toFixed(Number(n) < 10 ? 1 : 0)}%` : '—');

export function report({ last: turns = 8 } = {}) {
  syncCap();
  const snapshot = last();
  const lim = limits();
  if (!snapshot) {
    return [
      'No reply prompt has been measured yet since this process started.',
      `Context window: ${lim.contextTokens ? `~${fmt(lim.contextTokens)} tokens (${lim.contextSource})` : `unknown (${lim.contextSource})`}.`,
      `Raw history cap: ${fmt(lim.historyLimit)} messages; older messages are summarized every ${fmt(lim.summaryEvery)} messages.`,
      'Send one message and ask again to see the breakdown.',
    ].join('\n');
  }

  const cap = snapshot.capTokens || lim.contextTokens;
  const percent = cap ? (snapshot.totalTokens / cap) * 100 : null;
  const biggest = [...snapshot.sections].sort((a, b) => b.tokens - a.tokens);
  const lines = [
    `Context on the last reply prompt (${snapshot.conversation}${snapshot.voice ? ', voice' : ''}, ${new Date(snapshot.at).toLocaleTimeString()}):`,
    `- Estimated: ~${fmt(snapshot.totalTokens)} tokens${cap ? ` of ~${fmt(cap)} (${pct(percent)}; ~${fmt(cap - snapshot.totalTokens)} left)` : ''}. The estimate is about 4 characters per token.`,
    snapshot.actual
      ? `- The model reported ${fmt(snapshot.actual.prompt)} prompt tokens and ${fmt(snapshot.actual.completion)} completion tokens on the first round${snapshot.maxPrompt > snapshot.actual.prompt ? `; the largest round was ${fmt(snapshot.maxPrompt)} prompt tokens` : ''}.`
      : '- The model did not report usage this turn, so only the estimate is available.',
    `- System prompt: ~${fmt(snapshot.systemTokens)} tokens. Raw history: ${snapshot.history.messages} message${snapshot.history.messages === 1 ? '' : 's'} (~${fmt(snapshot.history.tokens)}), cap ${fmt(lim.historyLimit)}. Current message: ~${fmt(snapshot.current.tokens)}. Tool schemas: ${snapshot.tools.count} (~${fmt(snapshot.tools.tokens)}).`,
    `- Summaries: ${snapshot.summary.paragraphs} paragraph${snapshot.summary.paragraphs === 1 ? '' : 's'}${snapshot.summary.major ? ' plus a long-term summary' : ''}. Memories recalled: ${snapshot.memories.speaker} about ${snapshot.speaker ?? 'the speaker'}, ${snapshot.memories.others} about other people.`,
    `- Breakdown: ${biggest.map((s) => `${s.label} ~${fmt(s.tokens)}`).join(', ')}.`,
    `- Limits: ${lim.contextTokens ? `${fmt(lim.contextTokens)} tokens (${lim.contextSource})` : `context window unknown (${lim.contextSource})`}; ${fmt(lim.historyLimit)} raw history messages, plus the last ${lim.historyOverlap} before the summary cutoff kept for overlap; summaries every ${fmt(lim.summaryEvery)} messages; ${lim.paragraphsPerRollup} paragraphs or ${lim.rollupAgeHours}h roll up into one long-term summary; top ${lim.memoryTopK} memories per person at score ≥ ${lim.memoryMinScore}.`,
  ];

  const count = Math.max(1, Math.min(20, Number(turns) || 8));
  if (count > 1) {
    const rows = recentSnapshots(count);
    lines.push('', 'Recent turns (oldest first):');
    for (const row of rows) {
      lines.push(`- ${new Date(row.at).toLocaleTimeString()} ${row.conversation}${row.voice ? ' (voice)' : ''}: ~${fmt(row.totalTokens)} estimated${row.actual ? `, ${fmt(row.actual.prompt)} reported` : ''}${row.capTokens ? ` (${pct((row.totalTokens / row.capTokens) * 100)})` : ''}, ${row.history.messages} history messages.`);
    }
  }
  return lines.join('\n');
}
