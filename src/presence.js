import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Who's in the voice call with her and since when. Every join and leave is one line in
// data/presence.jsonl ({ ts, conversation, userId, name, event: 'join' | 'leave' }), which survives
// restarts; the timeline tool reads it to answer "what were we talking about before Ultra joined?".
// `here` is the live picture: conversation -> Map(userId -> { name, since }).

const LOG = path.join(DATA_DIR, 'presence.jsonl');
const here = new Map();

function log(entry) {
  try {
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch {}
}

// `alreadyThere`: she just arrived and they were in the call before her, so the real join time is unknown.
export function joined(conversation, userId, name, { alreadyThere = false } = {}) {
  const room = here.get(conversation) ?? new Map();
  here.set(conversation, room);
  if (room.has(userId)) return;
  room.set(userId, { name, since: Date.now(), alreadyThere });
  log({ conversation, userId, name, event: alreadyThere ? 'present' : 'join' });
}

export function left(conversation, userId) {
  const room = here.get(conversation);
  const who = room?.get(userId);
  if (!who) return;
  room.delete(userId);
  log({ conversation, userId, name: who.name, event: 'leave' });
}

// She left the call: everyone's presence ends there.
export function cleared(conversation) {
  for (const userId of [...(here.get(conversation)?.keys() ?? [])]) left(conversation, userId);
  here.delete(conversation);
}

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

// For her voice prompt: who's in the call and for how long.
export function presenceBlock(conversation) {
  const room = here.get(conversation);
  if (!room?.size) return '';
  const now = Date.now();
  const people = [...room.values()].map((p) =>
    p.alreadyThere ? `${p.name} (was already here when you joined${now - p.since < 60000 ? '' : `, so here at least ${ago(now - p.since)}`})` : now - p.since < 120000 ? `${p.name} (just joined)` : `${p.name} (here for ${ago(now - p.since)})`,
  );
  return `In the voice call right now (use it naturally, e.g. "you've been here 40 minutes", "Ultra just hopped in"; don't recite it): ${people.join(', ')}.`;
}

// Past joins and leaves, newest last. Optional filters: conversation, person (name, case-insensitive).
export function presenceEvents({ conversation, person } = {}) {
  if (!existsSync(LOG)) return [];
  const want = person?.toLowerCase();
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((e) => e && (!conversation || e.conversation === conversation) && (!want || e.name?.toLowerCase().includes(want)));
}
