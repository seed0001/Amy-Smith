import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatGPTRequest, streamChatGPT, sseEvents, chatGPTJson } from './chatgpt-provider.js';
import { chat } from './llm.js';

const tool = { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
const completed = (output = [], extra = {}) => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 }, ...extra } });
const streamResponse = (events, tail = true) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('').trimEnd() + (tail ? '\r\n\r\n' : ''), { headers: { 'Content-Type': 'text/event-stream' } });
const auth = { getAccessToken: async () => 'test-access' };

test('subscription request uses Responses-compatible history and namespaced local tools', () => {
  const request = buildChatGPTRequest([{ role: 'system', content: 'persona' }, { role: 'user', content: 'hello', images: ['abc'], imageTypes: ['image/jpeg'] }], { model: 'test-model', tools: [tool] });
  assert.equal(request.instructions, 'persona');
  assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.equal(request.tools[0].type, 'namespace');
  assert.equal(request.tools[0].tools[0].name, 'get_weather');
  for (const key of ['temperature', 'max_output_tokens', 'previous_response_id', 'conversation', 'background']) assert.equal(key in request, false);
  assert.equal(request.input.some((i) => i.role === 'system'), false);
});

test('SSE parser handles byte fragmentation, UTF-8 and final frame without blank line', async () => {
  const raw = new TextEncoder().encode('data: {"type":"text","value":"héllo"}\r\n\r\ndata: {"type":"end"}');
  async function* bytes() { for (const byte of raw) yield Uint8Array.of(byte); }
  const events = []; for await (const e of sseEvents(bytes())) events.push(e);
  assert.deepEqual(events, [{ type: 'text', value: 'héllo' }, { type: 'end' }]);
});

test('stream normalizes text, tool call IDs and usage and requires completion', async () => {
  const events = [{ type: 'response.output_text.delta', delta: 'Hello.' }, completed([{ type: 'function_call', call_id: 'call_1', name: 'get_weather', namespace: 'amy', arguments: '{"city":"Chicago"}' }])];
  const parts = [];
  for await (const p of streamChatGPT([{ role: 'user', content: 'weather' }], { model: 'test-model', tools: [tool] }, { auth, fetchImpl: async () => streamResponse(events, false) })) parts.push(p);
  assert.equal(parts[0].message.content, 'Hello.');
  assert.equal(parts[1].message.tool_calls[0].id, 'call_1');
  assert.equal(parts[1].usage.prompt_tokens, 15);
  await assert.rejects(async () => { for await (const _ of streamChatGPT([], { model: 'test-model' }, { auth, fetchImpl: async () => streamResponse(events.slice(0, 1)) })) {} }, /before completion/);
});

test('tool round trip preserves reasoning and pairs every tool result with its call', async () => {
  const bodies = [];
  let round = 0, executed = 0;
  const deps = { auth, fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (round++ === 0) return streamResponse([completed([{ type: 'reasoning', id: 'reason_1', summary: [], encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call_1', namespace: 'amy', name: 'get_weather', arguments: '{"city":"Chicago"}' }])]);
    return streamResponse([{ type: 'response.output_text.delta', delta: 'Chicago is sunny.' }, completed()]);
  } };
  const text = await chat([{ role: 'system', content: 'persona' }, { role: 'user', content: 'weather?' }], { tools: [tool], runTool: async (name, args) => { executed++; assert.equal(name, 'get_weather'); assert.equal(JSON.parse(args).city, 'Chicago'); return 'Sunny'; }, streamFactory: (messages, tools) => streamChatGPT(messages, { model: 'test-model', tools }, deps) });
  assert.equal(text, 'Chicago is sunny.'); assert.equal(executed, 1);
  assert.ok(bodies[1].input.some((i) => i.type === 'reasoning' && i.encrypted_content === 'opaque'));
  assert.ok(bodies[1].input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_1' && i.output === 'Sunny'));
});

test('subscription errors and failed completion never switch to API-key billing', async () => {
  let calls = 0;
  await assert.rejects(async () => { for await (const _ of streamChatGPT([], { model: 'test-model' }, { auth, fetchImpl: async (url) => { calls++; assert.equal(url, 'https://api.openai.com/v1/responses'); return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 }); } })) {} }, /usage limit/);
  assert.equal(calls, 1);
  await assert.rejects(async () => { for await (const _ of streamChatGPT([], { model: 'test-model' }, { auth, fetchImpl: async () => streamResponse([{ type: 'response.failed', response: { error: { code: 'failure' } } }]) })) {} }, /did not complete/);
});

test('repeated tools are not executed twice but every provider call gets a matching result', async () => {
  const bodies = []; let round = 0, executed = 0;
  const deps = { auth, fetchImpl: async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    round++;
    return streamResponse(round <= 2 ? [completed([{ type: 'function_call', call_id: `call_${round}`, name: 'get_weather', namespace: 'amy', arguments: '{}' }])] : [{ type: 'response.output_text.delta', delta: 'Done.' }, completed()]);
  } };
  assert.equal(await chat([{ role: 'user', content: 'weather' }], { tools: [tool], runTool: async () => { executed++; return 'Sunny'; }, streamFactory: (messages, tools) => streamChatGPT(messages, { model: 'test-model', tools }, deps) }), 'Done.');
  assert.equal(executed, 1);
  assert.ok(bodies[2].input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_2' && /conflict/.test(i.output)));
});

test('planning JSON is streamed through the same subscription connection', async () => {
  let body;
  const value = await chatGPTJson([{ role: 'system', content: 'Classify' }], 'test-model', { auth, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return streamResponse([{ type: 'response.output_text.delta', delta: '{"ok":true}' }, completed()]); } });
  assert.deepEqual(value, { ok: true });
  assert.equal(body.text.format.type, 'json_object');
  assert.ok(body.input.some((m) => /json/i.test(typeof m.content === 'string' ? m.content : '')));
});

test('JSON mode includes its directive in input when the original input never mentions JSON', () => {
  const body = buildChatGPTRequest([{ role: 'system', content: 'Extract facts and return JSON.' }, { role: 'user', content: 'I like coffee.' }], { model: 'test-model', json: true });
  assert.equal(body.input[0].content, 'I like coffee.');
  assert.match(body.input.at(-1).content, /JSON object/);
  assert.equal(body.text.format.type, 'json_object');
});

test('nested streaming validation errors preserve OpenAI explanation and request reference', async () => {
  const explanation = "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.";
  await assert.rejects(async () => {
    for await (const _ of streamChatGPT([], { model: 'test-model' }, { auth, fetchImpl: async () => {
      const response = streamResponse([{ type: 'error', error: { message: explanation, type: 'invalid_request_error', param: 'input', code: null } }]);
      response.headers.set('x-request-id', 'test-request-reference');
      return response;
    } })) {}
  }, (err) => err.message.includes(explanation) && err.status === 400 && err.requestId === 'test-request-reference');
});
