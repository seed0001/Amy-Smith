import test from 'node:test';
import assert from 'node:assert/strict';
import { selectResearch, localResearchTopic, validateResearchPlan, researchKey } from './research-policy.js';

const now = 1000000000;
const question = (text, age = 0) => ({ text, at: now - age, conversation: 'voice:test', speaker: 'Travis' });

test('local provider and private cron threads never become public searches', () => {
  const result = selectResearch({ now, botName: 'Amy', questions: [question('Amy, what is your TTS provider?')], threads: [{ id: 1, label: 'Amy autonomous cron cycle', state: 'Consent flow for her profile cards', last_touched: now }] });
  assert.equal(result.selected, null);
  assert.ok(result.candidates.every((c) => /local\/private/.test(c.rejected)));
  assert.equal(localResearchTopic('Fish Audio TTS streaming latency benchmarks', 'Amy'), false);
});

test('questions need timestamps and expire rather than lingering indefinitely', () => {
  const result = selectResearch({ now, questions: ['What is this unknown provider?', question('How does SQLite WAL recovery work?', 7 * 3600000)] });
  assert.equal(result.selected, null);
  assert.ok(result.candidates.every((c) => /timestamp/.test(c.rejected)));
});

test('fresh grounded questions outrank names and threads and carry source context', () => {
  const result = selectResearch({ now, questions: [question('How does SQLite WAL recovery work?', 60000)], names: [{ name: 'SQLite', snippet: 'What is SQLite WAL recovery?', at: now, conversation: 'text:test' }], threads: [{ label: 'Audio', state: 'Compare public TTS streaming architectures', last_touched: now }] });
  assert.equal(result.selected.kind, 'question');
  assert.equal(result.selected.speaker, 'Travis');
  assert.equal(result.selected.conversation, 'voice:test');
});

test('passing names, contacts and stale threads do not become research', () => {
  const result = selectResearch({ now, knownNames: ['Brandon'], names: [{ name: 'Brandon', snippet: 'Who is Brandon meeting later?', at: now }, { name: 'SQLite', snippet: 'SQLite looks useful today.', at: now }], threads: [{ label: 'Old project', state: 'Something to discuss again', last_touched: now - 25 * 3600000 }] });
  assert.equal(result.selected, null);
});

test('repeat cooldown advances to another candidate', () => {
  const first = question('How does SQLite WAL recovery work?');
  const second = question('How does Opus encode voice audio?', 1000);
  const result = selectResearch({ now, questions: [first, second], attempts: [{ key: researchKey(first.text), at: now - 5000 }] });
  assert.equal(result.selected.text, second.text);
});

test('pre-search gate requires relevance, source evidence, confidence and a nonrepeated public query', () => {
  const source = question('How does SQLite WAL recovery work?');
  const plan = { search: true, query: 'SQLite WAL crash recovery documentation', reason: 'A clear public technical question remains unanswered', evidence: 'SQLite WAL recovery', confidence: 0.95 };
  assert.equal(validateResearchPlan(plan, source).search, true);
  for (const bad of [null, { ...plan, search: false }, { ...plan, confidence: 0.5 }, { ...plan, evidence: 'unrelated invented topic' }, { ...plan, query: 'who is my provider' }]) assert.equal(validateResearchPlan(bad, source).search, false);
  assert.equal(validateResearchPlan(plan, source, [plan.query]).search, false);
});
