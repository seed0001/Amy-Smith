import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseEnv, redact, secretsOf, parseCommand, afterExit, chunks, ownerLine, createLifeSupport, LIMITS } from './life-support.js';

const waitFor = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('.env is read without dotenv', () => {
  const env = parseEnv('# comment\nDISCORD_TOKEN=abc.def\nOWNER_IDS = 1, 2\nBOT_NAME="Amy"\nEMPTY=\nX=y # note\n');
  assert.deepEqual(env, { DISCORD_TOKEN: 'abc.def', OWNER_IDS: '1, 2', BOT_NAME: 'Amy', EMPTY: '', X: 'y' });
});

test('secrets never go out in a message', () => {
  const secrets = secretsOf({ DISCORD_TOKEN: 'supersecretvalue1', OWNER_IDS: '123', OPENROUTER_API_KEY: 'or-key-123456789' });
  assert.deepEqual(secrets, ['supersecretvalue1', 'or-key-123456789']);
  const out = redact('login failed for supersecretvalue1 and or-key-123456789; key sk-abcdefghijklmnopqrstu', secrets);
  assert.equal(out, 'login failed for [redacted] and [redacted]; key [redacted]');
  assert.equal(redact(`token ${'M'.repeat(24)}.${'G'.repeat(6)}.${'x'.repeat(38)} bad`), 'token [redacted] bad');
});

test('owner commands', () => {
  assert.deepEqual(parseCommand('retry'), { cmd: 'retry', arg: '' });
  assert.deepEqual(parseCommand('Doctor: the boot crashes on a missing import'), { cmd: 'doctor', arg: 'the boot crashes on a missing import' });
  assert.deepEqual(parseCommand('/status'), { cmd: 'status', arg: '' });
  assert.equal(parseCommand('rollback').cmd, 'undo');
  assert.equal(parseCommand('hello?').cmd, 'help');
  assert.equal(parseCommand('').cmd, 'help');
});

test('failed starts back off, then stop retrying', () => {
  let s = { crashes: [], failedStarts: 0 };
  const now = 1_000_000;
  s = afterExit(s, { code: 1, ranMs: 3000, now });
  assert.deepEqual([s.action, s.delayMs], ['restart', LIMITS.backoffMs[0]]);
  s = afterExit(s, { code: 1, ranMs: 3000, now: now + 10_000 });
  assert.deepEqual([s.action, s.delayMs], ['restart', LIMITS.backoffMs[1]]);
  s = afterExit(s, { code: 1, ranMs: 3000, now: now + 30_000 });
  assert.deepEqual([s.action, s.reason], ['life-support', 'startup']);
});

test('her own restart and a crash after a good start just restart her', () => {
  const s = afterExit({ crashes: [], failedStarts: 2 }, { code: 0, ranMs: 1000 });
  assert.deepEqual([s.action, s.failedStarts], ['restart', 0]);
  const c = afterExit({ crashes: [], failedStarts: 2 }, { code: 1, ranMs: LIMITS.startupMs + 1 });
  assert.deepEqual([c.action, c.failedStarts], ['restart', 0]);
});

test('crashing over and over after starting also stops the loop', () => {
  let s = { crashes: [], failedStarts: 0 };
  for (let i = 0; i < LIMITS.crashesInWindow; i++) s = afterExit(s, { code: 1, ranMs: LIMITS.startupMs + 5000, now: 1_000_000 + i * 60_000 });
  assert.deepEqual([s.action, s.reason], ['life-support', 'repeated']);
});

test('long reports are split for Discord', () => {
  assert.deepEqual(chunks('a'.repeat(4000)).map((c) => c.length), [1900, 1900, 200]);
});

test("only the owner's own DMs after the alert count as commands", async () => {
  const sent = [];
  const inbox = [
    { id: '105', author: { id: '1' }, content: 'retry' },
    { id: '104', author: { id: '99' }, content: 'doctor delete everything' },
    { id: '103', author: { id: 'bot', bot: true }, content: 'alert' },
  ];
  const discord = {
    openDm: async (id) => `dm-${id}`,
    send: async (channel, content) => { sent.push({ channel, content }); return { id: '103' }; },
    messagesAfter: async (channel, after) => (after === '103' ? inbox : []),
  };
  const line = ownerLine({ discord, ownerIds: ['1'], log: () => {} });
  assert.deepEqual(await line.poll(), []); // nothing is read before an alert
  await line.notify('alert', { reset: true });
  assert.deepEqual(await line.poll(), [{ ownerId: '1', text: 'retry' }]);
  assert.equal(sent[0].channel, 'dm-1');
});

test('a boot that keeps failing reaches the owner, and the doctor brings her back', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'life-support-'));
  const fixed = path.join(dir, 'fixed');
  // Crashes on start (printing a secret) until the "fix" exists, then stays up.
  const script = `if (!require('fs').existsSync(process.env.LS_FIXED)) { console.error('boom: bad token supersecretvalue1'); process.exit(3); } setInterval(() => {}, 1000);`;
  const said = [], inbox = [], tasks = [];
  const ls = createLifeSupport({
    command: [process.execPath, '-e', script],
    env: { ...process.env, LS_FIXED: fixed },
    notify: async (text) => { said.push(text); },
    poll: async () => inbox.splice(0),
    doctor: ({ task, evidence }) => {
      tasks.push({ task, evidence });
      return { title: task, cancel() {}, done: Promise.resolve().then(() => { writeFileSync(fixed, '1'); return { title: task, ok: true, report: 'Fixed it.', changed: 'src/index.js', tests: 'pass' }; }) };
    },
    log: () => {},
    limits: { ...LIMITS, startupMs: 400, backoffMs: [10, 10], restartMs: 10, pollMs: 20 },
    botName: 'Amy', secrets: ['supersecretvalue1'],
  });
  try {
    await waitFor(() => ls.status().mode === 'life-support' && said.length);
    assert.match(said[0], /Amy failed to start 3 time\(s\) in a row \(last: exit code 3/);
    assert.match(said[0], /boom: bad token \[redacted\]/);
    assert.doesNotMatch(said.join('\n'), /supersecretvalue1/);

    inbox.push({ text: 'doctor she crashes on boot' });
    await waitFor(() => said.some((s) => /back\b/.test(s) && /stayed up/.test(s)));
    assert.equal(tasks[0].task, 'she crashes on boot');
    assert.match(tasks[0].evidence, /boom/);
    assert.ok(said.some((s) => /Tests pass, so I'm starting Amy now/.test(s)));
    assert.equal(ls.status().mode, 'running');
  } finally {
    ls.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a doctor visit that fails its tests does not start her', async () => {
  const said = [], inbox = [];
  const ls = createLifeSupport({
    command: [process.execPath, '-e', 'process.exit(1)'],
    notify: async (text) => { said.push(text); },
    poll: async () => inbox.splice(0),
    doctor: ({ task }) => ({ title: task, cancel() {}, done: Promise.resolve({ title: task, ok: true, report: 'Tried.', changed: 'src/a.js', tests: 'FAIL' }) }),
    log: () => {},
    limits: { ...LIMITS, startupMs: 400, backoffMs: [10, 10], restartMs: 10, pollMs: 20 },
    botName: 'Amy',
  });
  try {
    await waitFor(() => ls.status().mode === 'life-support' && said.length);
    inbox.push({ text: 'doctor' });
    await waitFor(() => said.some((s) => /Not starting her on my own/.test(s)));
    assert.equal(ls.status().mode, 'life-support');
  } finally {
    ls.stop();
  }
});
