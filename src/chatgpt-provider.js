import { chatgptAuth, openAIError, ChatGPTError } from './chatgpt-auth.js';

export function buildChatGPTRequest(messages, { model, tools = [], json = false, effort = '' } = {}) {
  if (!model) throw new Error('Select a ChatGPT model in dashboard Settings → Brain');
  const instructions = [], input = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') { instructions.push(String(m.content || '')); continue; }
    if (m.role === 'tool') {
      if (!m.tool_call_id) throw new Error('A ChatGPT tool result is missing its call ID');
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '') });
    } else if (m._responsesOutput) {
      // Preserve reasoning/tool items exactly across tool rounds with store:false.
      input.push(...m._responsesOutput);
    } else {
      if (m.content || !m.tool_calls?.length) input.push({ role: m.role, content: m.images?.length
        ? [{ type: 'input_text', text: String(m.content || '') }, ...m.images.map((b64, i) => ({ type: 'input_image', image_url: `data:${m.imageTypes?.[i] || 'image/png'};base64,${b64}` }))]
        : String(m.content ?? '') });
      for (const c of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.function.name, namespace: 'amy', arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) });
    }
  }
  const request = { model, instructions: instructions.join('\n\n'), input, store: false, stream: true, include: ['reasoning.encrypted_content'] };
  // Quick structured calls and spoken replies think briefly; the model's default effort cost seconds.
  if (effort) request.reasoning = { effort };
  if (tools?.length) request.tools = [{ type: 'namespace', name: 'amy', description: 'Amy companion tools. Execute locally through existing owner and contact permissions.', tools: tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })) }];
  if (json) {
    request.instructions += '\nReturn only one valid JSON object, with no Markdown fences.';
    // JSON mode validates input separately from instructions. Planning/extraction prompts may
    // put every mention of JSON in system instructions, so include an explicit input directive.
    input.push({ role: 'user', content: 'Return only a valid JSON object for the task above. Do not include Markdown fences.' });
    request.text = { format: { type: 'json_object' } };
  }
  return request;
}

// SSE frames may be split anywhere, use CRLF, carry multiline data, or end without a blank line.
export async function* sseEvents(body) {
  const decoder = new TextDecoder(); let buffer = '', lines = [];
  const parse = () => { const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'); lines = []; return data && data !== '[DONE]' ? JSON.parse(data) : null; };
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
      if (!line) { const value = parse(); if (value) yield value; } else lines.push(line);
    }
  }
  buffer += decoder.decode(); if (buffer.trim()) lines.push(buffer.replace(/\r$/, ''));
  if (lines.length) { const value = parse(); if (value) yield value; }
}

export async function* streamChatGPT(messages, options, { auth = chatgptAuth, fetchImpl = fetch } = {}) {
  const body = buildChatGPTRequest(messages, options);
  const token = await auth.getAccessToken();
  const send = () => fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000), redirect: 'error' });
  let res = await send();
  // A model that doesn't take a reasoning effort: ask again with its default.
  if (!res.ok && body.reasoning && res.status === 400) {
    const err = await openAIError(res);
    if (!/reasoning|effort/i.test(err.message)) throw err;
    delete body.reasoning;
    res = await send();
  }
  if (!res.ok) throw await openAIError(res);
  if (!res.body) throw new Error('ChatGPT returned no response stream');
  let completed = false, textSeen = false;
  for await (const event of sseEvents(res.body)) {
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') { textSeen = true; yield { message: { content: event.delta || '' } }; }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const error = event.response?.error || event.error || event;
      const code = error.code || event.response?.incomplete_details?.reason || '';
      const detail = typeof error.message === 'string' ? error.message.replace(/[\r\n\x00-\x1f]+/g, ' ').slice(0, 500) : '';
      throw new ChatGPTError(`ChatGPT response did not complete${code ? ` (${code})` : ''}${detail ? `: ${detail}` : '.'}`, { code, status: error.type === 'invalid_request_error' ? 400 : 502, requestId: res.headers.get('x-request-id') || '' });
    }
    if (event.type === 'response.completed') {
      if (event.response?.status && event.response.status !== 'completed') throw new Error('ChatGPT response was not completed');
      completed = true;
      const output = event.response?.output ?? [];
      if (!textSeen) {
        const text = output.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).map((p) => p.text || p.refusal || '').join('');
        if (text) yield { message: { content: text } };
      }
      const calls = output.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id, function: { name: String(o.name).replace(/^amy\./, ''), arguments: o.arguments || '{}' } }));
      const usage = event.response?.usage;
      yield { message: { content: '', ...(calls.length ? { tool_calls: calls } : {}) }, responseOutput: output, ...(usage ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } } : {}) };
    }
  }
  if (!completed) throw new Error('ChatGPT stream ended before completion. The request was not retried or billed through another provider');
}

export async function chatGPTJson(messages, model, deps) {
  let text = '';
  for await (const part of streamChatGPT(messages, { model, json: true, effort: 'low' }, deps)) text += part.message.content || '';
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new Error('ChatGPT returned invalid JSON'); }
}

export async function verifyChatGPTModel(model, deps) {
  let result = '';
  for await (const part of streamChatGPT([{ role: 'user', content: 'Reply with the single word OK.' }], { model }, deps)) result += part.message.content || '';
  if (!result.trim()) throw new Error('ChatGPT access check completed without a text answer');
  return { verified: true, model };
}
