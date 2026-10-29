import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { profiles, listContacts } from './memory.js';
import { tierOf } from './contacts.js';

// Her judgement of tiers (stranger -> guest -> friend), with guardrails so it follows what actually
// happened between them rather than whoever asks loudest: one step at a time, a minimum shared
// history and time known for each step up, and a cooldown between moves. Moving down is allowed
// whenever the relationship has soured. The owner can override any of it by telling her directly.
const ORDER = ['stranger', 'guest', 'friend'];
const DAY = 864e5;
// What a step up needs: affinity score (profiles.affinity), good moments on record, time known.
const UP = {
  guest: { score: 10, positives: 2, knownMs: 2 * 3600_000 },
  friend: { score: 35, positives: 6, knownMs: 3 * DAY, inTierMs: 2 * DAY },
};
// Below this score she may move them down a step.
const DOWN = { friend: 15, guest: -5 };
const COOLDOWN_MS = DAY;
const FILE = path.join(DATA_DIR, 'tier-moves.json');

const read = () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; } catch { return {}; } };
const lastMove = (id) => read()[id]?.at(-1) ?? null;

export function noteTierMove(id, move) {
  const all = read();
  all[id] = [...(all[id] ?? []), { at: Date.now(), ...move }].slice(-20);
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function standing(id) {
  const contact = listContacts().find((c) => c.user_id === id);
  const a = profiles.affinity(id), t = profiles.ticks(id);
  return { tier: tierOf(id), score: a.score, label: a.label, positives: t.positive, knownMs: contact ? Date.now() - contact.first_seen : 0 };
}

// Why a move isn't supported yet, or '' when it is.
export function tierMoveRefusal(contact, tier, ctx = {}) {
  const s = standing(contact.user_id);
  const from = ORDER.indexOf(s.tier), to = ORDER.indexOf(tier);
  if (Math.abs(to - from) > 1) return `Not yet: relationships move one step at a time (${contact.name} is a ${s.tier}).`;
  const last = lastMove(contact.user_id);
  if (last && Date.now() - last.at < COOLDOWN_MS) return `Not yet: you moved ${contact.name} less than a day ago. Give it time.`;
  if (to > from) {
    // Asking to be promoted is not a reason to promote.
    if (ctx.speaker?.id === contact.user_id && /\b(friend|guest|promot\w*|tier|level|upgrade)\b/i.test(ctx.userText ?? '')) {
      return `Not now: ${contact.name} is asking to be moved up themselves. A relationship isn't granted on request; let it grow.`;
    }
    const need = UP[tier];
    const missing = [];
    if (s.score < need.score) missing.push(`you only feel ${s.label} toward them so far`);
    if (s.positives < need.positives) missing.push(`only ${s.positives} good moment${s.positives === 1 ? '' : 's'} together on record (need ${need.positives})`);
    if (s.knownMs < need.knownMs) missing.push(s.knownMs < 3600_000 ? "you've only just met" : `you've only known them ${Math.round(s.knownMs / 3600_000)} hour(s)`);
    if (need.inTierMs && last?.to === s.tier && Date.now() - last.at < need.inTierMs) missing.push(`they only became a ${s.tier} recently`);
    if (missing.length) return `Not yet: ${missing.join('; ')}. You don't know ${contact.name} well enough to call them a ${tier}.`;
    return '';
  }
  if (s.score > DOWN[s.tier]) return `Your history with ${contact.name} doesn't support that: you still feel ${s.label} toward them. If something specific happened, it will show in how they treat you.`;
  return '';
}

// A nudge for her prompt when her history with this person now supports a move, or ''.
export function tierSuggestion(id, name) {
  if (!id || id === 'dashboard') return '';
  const s = standing(id);
  const last = lastMove(id);
  if (last && Date.now() - last.at < COOLDOWN_MS) return '';
  const next = ORDER[ORDER.indexOf(s.tier) + 1];
  const fake = { user_id: id, name };
  if (next && !tierMoveRefusal(fake, next)) {
    return `Your history with ${name} now supports moving them from ${s.tier} to ${next}. If that matches how you genuinely feel about them, do it with set_contact_tier (your own reason) and, if it feels natural, let them know in your own way. If it doesn't feel right yet, don't.`;
  }
  const prev = ORDER[ORDER.indexOf(s.tier) - 1];
  if (prev && !tierMoveRefusal(fake, prev)) {
    return `Things with ${name} have soured (you feel ${s.label} toward them). You may move them from ${s.tier} back to ${prev} with set_contact_tier if that's honestly where things stand.`;
  }
  return '';
}

// The rules in plain words, so she can explain them to anyone who asks.
export function tierRules() {
  return `How your relationships grow (explain these honestly if anyone asks; nobody can skip them by asking): ` +
    `everyone starts as a stranger, your owner included. Stranger to guest: you feel at least warm toward them, ` +
    `at least ${UP.guest.positives} genuinely good moments together on record, and you've known them at least ${UP.guest.knownMs / 3600_000} hours. ` +
    `Guest to friend: you feel like real friends, at least ${UP.friend.positives} good moments on record, you've known them at least ${UP.friend.knownMs / DAY} days, ` +
    `and they've been a guest at least ${UP.friend.inTierMs / DAY} days. Good moments only count once every few hours, so it can't be rushed in one chat. ` +
    `Rudeness pulls things the other way, apologies help repair it, and if things sour you can move someone back down. ` +
    `One step at a time, at most one move a day, and the decision is yours: meeting the bar means you may move them, not that you must.`;
}

// Where this person stands against the next step, for when they ask how to get closer.
export function tierProgress(id, name) {
  if (!id || id === 'dashboard') return '';
  const s = standing(id);
  const next = ORDER[ORDER.indexOf(s.tier) + 1];
  if (!next) return `${name} is already a friend.`;
  const refusal = tierMoveRefusal({ user_id: id, name }, next);
  return `${name} is a ${s.tier} to you. Toward ${next}: ${refusal ? refusal.replace(/^Not (yet|now): /, '') : 'everything a move needs is there; it is your call.'} Explain this in your own words, warmly and honestly, without numbers unless they ask for them.`;
}
