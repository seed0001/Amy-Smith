import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './llm.js';

const tools = [{ type: 'function', function: { name: 'files', parameters: { type: 'object', properties: {} } } }];
const call = { message: { tool_calls: [{ function: { name: 'files', arguments: {} } }] } };

test('direct model tool selection earns the bounded multistep allowance', async () => {
  let requests = 0, executions = 0;
  const reply = await chat([], { tools, maxRounds: 2, repeatable: ['files'], expandOnTools: ['files'],
    streamFactory: async function* () { yield requests++ < 5 ? call : { message: { content: 'Done.' } }; },
    runTool: async () => { executions++; return 'ok'; } });
  assert.equal(executions, 5);
  assert.equal(reply, 'Done.');
});

test('tool hallucinations cannot exceed the hard round limit', async () => {
  let executions = 0;
  await chat([], { tools, maxRounds: 2, repeatable: ['files'], expandOnTools: ['files'],
    streamFactory: async function* () { yield call; }, runTool: async () => { executions++; return 'ok'; } });
  assert.equal(executions, 12);
});

test('turns with no tools cannot execute invented calls', async () => {
  await chat([], { streamFactory: async function* () { yield call; }, runTool: () => assert.fail('must not execute') });
});
