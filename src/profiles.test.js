import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProfileStore } from './profiles.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  let now = 1000000;
  t.after(() => db.close());
  return { store: createProfileStore(db, () => now), advance: (hours) => now += hours * 3600000 };
}

test('frustration belongs to one person and decays without reads extending its life', (t) => {
  const { store, advance } = fixture(t);
  store.event('alice', 'interruption');
  store.event('alice', 'interruption');
  assert.equal(store.read('alice').frustration, 20);
  assert.equal(store.read('bob').frustration, 0);
  advance(12);
  assert.ok(Math.abs(store.read('alice').frustration - 20 / Math.sqrt(2)) < 1e-8);
  advance(12);
  assert.equal(store.read('alice').frustration, 10);
  store.event('alice', 'interruption');
  assert.equal(store.read('alice').frustration, 20);
});

test('apology and amends repair frustration, repeated repair is rate limited', (t) => {
  const { store, advance } = fixture(t);
  for (let i = 0; i < 5; i++) store.event('alice', 'interruption');
  store.event('alice', 'positive', 'Thank you');
  store.event('alice', 'apology', 'Sorry I interrupted');
  assert.equal(store.read('alice').frustration, 36);
  store.event('alice', 'apology', 'Sorry again');
  store.event('alice', 'amends', 'I will wait my turn');
  assert.equal(store.read('alice').frustration, 36);
  advance(0.5);
  const before = store.read('alice').frustration;
  store.event('alice', 'amends');
  assert.equal(store.read('alice').frustration, before - 18);
  assert.equal(store.read('bob').apologies, 0);
  assert.equal(store.read('alice').apologies, 2);
});

test('preferences deduplicate, changes replace opposite preferences, and reset clears everything', (t) => {
  const { store } = fixture(t);
  store.preferences('alice', [{ kind: 'like', topic: 'Coffee' }, { kind: 'like', topic: 'coffee' }, { kind: 'other', topic: 'ignored' }]);
  assert.equal(store.read('alice').likes.length, 1);
  store.preferences('alice', [{ kind: 'dislike', topic: 'COFFEE', evidence: 'I dislike coffee now' }]);
  assert.equal(store.read('alice').likes.length, 0);
  assert.equal(store.read('alice').dislikes.length, 1);
  assert.equal(store.read('bob').dislikes.length, 0);
  store.clear('alice');
  assert.equal(store.read('alice').dislikes.length, 0);
});

test('decay can be tuned and invalid rates cannot corrupt state', (t) => {
  const { store, advance } = fixture(t);
  store.event('alice', 'negative');
  store.decay('alice', 2);
  for (const invalid of [0, -1, NaN, Infinity, 721, '24']) assert.throws(() => store.decay('alice', invalid));
  advance(2);
  assert.equal(store.read('alice').frustration, 6);
});

test('scores are bounded and history stays bounded', (t) => {
  const { store, advance } = fixture(t);
  for (let i = 0; i < 120; i++) store.event('alice', 'interruption');
  assert.equal(store.read('alice').frustration, 100);
  assert.equal(store.read('alice').events.length, 40);
  for (let i = 0; i < 20; i++) { advance(1); store.event('alice', 'amends'); }
  assert.equal(store.read('alice').frustration, 0);
});

test('explicit stop keeps interruption tracking but removes its frustration penalty', (t) => {
  const { store } = fixture(t);
  store.event('alice', 'negative');
  store.event('alice', 'interruption');
  store.dismissStopInterruption('alice');
  assert.equal(store.read('alice').frustration, 12);
  assert.equal(store.read('alice').interruptions, 1);
  store.dismissStopInterruption('alice');
  assert.equal(store.read('alice').frustration, 12);
});

test('evidence retrieves the moments driving a feeling, for that person only', (t) => {
  const { store, advance } = fixture(t);
  store.event('ultra', 'positive', 'thanks for the help');
  advance(5);
  store.event('ultra', 'negative', 'you are useless');
  store.event('chris', 'positive', 'you are great');
  const [top] = store.evidence('ultra');
  assert.equal(top.kind, 'negative');
  assert.equal(top.detail, 'you are useless');
  assert.ok(top.pull < 0);
  assert.equal(store.evidence('ultra').length, 2);
  assert.ok(store.evidence('chris').every((m) => m.detail !== 'you are useless'));
  assert.equal(store.affinity('ultra').label, 'wary');
});

test('reasons attribute a feeling to dated quotes, and can leave the words out', (t) => {
  const { store } = fixture(t);
  store.event('ultra', 'negative', 'you are useless');
  const day = new Date(1000000).toISOString().slice(0, 10);
  assert.equal(store.reasons('ultra'), `rude/hostile to you on ${day}: "you are useless"`);
  assert.equal(store.reasons('ultra', { quotes: false }), `rude/hostile to you on ${day}`);
});

test('missing evidence is reported, never invented', (t) => {
  const { store } = fixture(t);
  assert.equal(store.reasons('nobody'), '');
  assert.deepEqual(store.evidence('nobody'), []);
  store.event('alice', 'negative');
  assert.match(store.reasons('alice'), /their words weren't recorded/);
  // Frustration from interruptions has no quote: the prompt says so rather than giving a bare number.
  store.event('bob', 'interruption');
  assert.match(store.prompt('bob'), /what raised it: interruption on/);
  assert.match(store.prompt('bob'), /can't trace it to anything specific/);
  assert.doesNotMatch(store.prompt('carol'), /what raised it/);
});

test('impressions change: an apology shows up as a reason and old hurts fade toward a floor', (t) => {
  const { store, advance } = fixture(t);
  store.event('ultra', 'negative', 'shut up');
  const hurt = store.affinity('ultra').score;
  advance(1);
  store.event('ultra', 'apology', 'sorry, that was rude');
  assert.ok(store.affinity('ultra').score > hurt);
  assert.match(store.reasons('ultra'), /apologised on .*sorry, that was rude/);
  assert.equal(store.marks('ultra').length, 2); // the hurt is still remembered
  advance(24 * 365);
  for (let i = 0; i < 3; i++) { store.event('ultra', 'positive', `thank you ${i}`); advance(5); }
  assert.ok(store.affinity('ultra').score > 0);
  assert.equal(store.evidence('ultra', 1)[0].kind, 'positive');
});

test('profile survives database reopening and offline time still decays', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'champ-profiles-'));
  let db;
  try {
    const file = path.join(folder, 'test.db');
    db = new DatabaseSync(file);
    createProfileStore(db, () => 1000).event('alice', 'interruption');
    db.close();
    db = new DatabaseSync(file);
    const p = createProfileStore(db, () => 1000 + 24 * 3600000).read('alice');
    assert.equal(p.frustration, 5);
    assert.equal(p.interruptions, 1);
  } finally { db?.close(); rmSync(folder, { recursive: true, force: true }); }
});
