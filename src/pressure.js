import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity } from './events.js';
import { listContacts, openObligations, reachCard, markReached, setReach, countRecentUserMessages } from './memory.js';
import { tierOf } from './contacts.js';
import * as scratch from './scratchpad.js';
import { profiles } from './memory.js';
import { selectResearch, questionText } from './research-policy.js';
import { replyInFlight } from './busy.js';

// Amy's pressure system (her spec: Downloads/amy-pressure-system-spec.md). Internal buckets, each
// 0..1, fill and drain from conversation and from time passing. Crossing a threshold makes a bucket
// want something; acting on it drains that bucket and seeds another, so one want leads to the next.
// Ticks are plain arithmetic (never an LLM call): one every `tick_seconds`, plus one right away on
// events. Everything tunable lives in data/pressure-config.json; state in data/pressure-state.json.
//
// What a fired want does (with actions_live): boredom and curiosity run a quiet research pass that
// she writes up in her journal (journal.js). Restlessness, usefulness and unease make her speak up,
// and missing someone makes her reach out to them, but only in a voice call with people in it,
// during a lull, within the daily limit; reaching out to a person also needs a yes on their
// check-in card and enough days since the last time. DMs and text channels are for later
// (reach_channels). Irritation only changes her tone. With actions_live off, wants are just logged.

const CONFIG_FILE = path.join(DATA_DIR, 'pressure-config.json');
const STATE_FILE = path.join(DATA_DIR, 'pressure-state.json');

export const DEFAULTS = {
  enabled: true,
  actions_live: true, // false: fired wants are only logged
  research_per_day: 8, // quiet research passes written to her journal
  research_min_gap_minutes: 45,
  research_question_hours: 6,
  research_thread_hours: 24,
  research_repeat_hours: 72,
  research_quiet_seconds: 60,
  reach_channels: ['voice'], // where she may speak up or reach out on her own (DMs and text come later)
  tick_seconds: 60,
  max_catch_up_hours: 3, // after downtime, time counts for at most this long (so a week off doesn't wake her up frantic)
  global_cap: 3.5, // over this total, only internal wants may fire
  external_min_gap_minutes: 30,
  external_per_day: 3,
  quiet_clamp_minutes: 120, // after "back off" / "be quiet"
  quiet_clamp_max: 0.2,
  idle_minutes: 10, // no message for this long counts as a silence
  lull_seconds: 120, // in a call, nobody has said anything (to her or each other) for this long before she speaks up
  stale_hours: 2, // a promise or open question on her pad this old starts to make her uneasy
  reraise_hours: 12, // once she's brought one up, it doesn't make her uneasy again for this long
  recent_name_minutes: 30, // a name mentioned in conversation is only a research lead this long
  // Per bucket: fill per tick while its condition holds, decay per tick otherwise, threshold to act,
  // drain when it acts, hysteresis before it can act again, and on/off.
  buckets: {
    boredom: { enabled: true, fill_rate: 0.015, decay_rate: 0.04, threshold: 0.65, drain: 0.55, hysteresis: 0.25 },
    curiosity: { enabled: true, fill_rate: 0.0, decay_rate: 0.004, threshold: 0.6, drain: 0.7, hysteresis: 0.2 },
    irritation: { enabled: true, fill_rate: 0.0, decay_rate: 0.05, threshold: 0.5, drain: 0.5, hysteresis: 0.2 },
    restlessness: { enabled: true, fill_rate: 0.005, decay_rate: 0.02, threshold: 0.65, drain: 0.5, hysteresis: 0.25 },
    usefulness: { enabled: true, fill_rate: 0.002, decay_rate: 0.0, threshold: 0.7, drain: 0.45, hysteresis: 0.25 },
    unease: { enabled: true, fill_rate: 0.02, decay_rate: 0.02, threshold: 0.6, drain: 0.6, hysteresis: 0.2 },
    loneliness: { enabled: true, fill_rate: 0.0015, decay_rate: 0.0, threshold: 0.6, drain: 0.4, hysteresis: 0.25 },
  },
  // Solo thoughts: a read-only load score and the cadence bands it selects. None of this is a
  // pressure bucket, so thinking never drains curiosity or unease.
  thoughts: {
    messages_full: 20, // messages in the last hour that count as a full "recent" signal
    stale_full: 3, // stale scratchpad items that count as a full "unease" signal
    weights: { curiosity: 0.25, unease: 0.2, threads: 0.15, recent: 0.15, restlessness: 0.15, boredom: 0.1 },
    bands: {
      quiet: { max: 0.25, gap_minutes: 240, cap: 2, sentences: [1, 1] },
      low: { max: 0.45, gap_minutes: 90, cap: 4, sentences: [1, 2] },
      active: { max: 0.7, gap_minutes: 30, cap: 8, sentences: [3, 6] },
      high: { max: 1.01, gap_minutes: 12, cap: 12, sentences: [6, 12] },
    },
  },
  // How fast loneliness for someone builds, by their tier; and after how long without contact.
  loneliness_tiers: { owner: 1, friend: 0.7, guest: 0.4, stranger: 0 },
  loneliness_after_hours: 1,
  // Conversation signals (added straight away on a message).
  signals: {
    low_novelty: 0.06, // boredom, when a message repeats recent ones
    high_novelty: -0.12, // boredom, when it's new ground
    new_name: 0.08, // curiosity, per unfamiliar name mentioned (max 3)
    open_question: 0.12, // curiosity, "we should look into", "I wonder", ...
    irritant: 0.2, // irritation, "say that again", "you're wrong", talked over...
    real_request: -0.35, // usefulness, someone asked for an actual action
    contact: -0.5, // loneliness for the person who spoke
    made_something: -0.4, // restlessness, she made a file/song/image/project
  },
  // What each want drains and seeds (the flywheel). Seeds are small next to drains, so it can rest.
  seeds: {
    boredom: { curiosity: 0.1, usefulness: 0.2 },
    curiosity: { usefulness: 0.15, restlessness: 0.15 },
    restlessness: { usefulness: 0.3 },
    usefulness: { boredom: 0.1 },
    loneliness: { boredom: -0.1, usefulness: -0.1 },
    irritation: { unease: 0.1 },
    unease: { restlessness: 0.1 },
  },
};

const EXTERNAL = new Set(['usefulness', 'loneliness']); // wants that reach out to a person
const RESEARCH = new Set(['boredom', 'curiosity']); // quiet: look something up, write it in her journal
const SPOKEN = new Set(['restlessness', 'usefulness', 'unease', 'loneliness']); // said out loud (voice only, for now)

// Who carries wants out. The voice session registers an actor: audience() returns { ids } of the
// people in a call she could speak up in right now (a lull, not mid-reply) or null; act(want) speaks.
// The journal registers a researcher: research(topic, why) -> { title, bringUp }.
let actor = null;
let researcher = null;
let researchInFlight = false;
let thinker = null;
export const setActor = (a) => (actor = a);
export const setResearcher = (fn) => (researcher = fn);
export const setThinker = (fn) => (thinker = fn);
const WANTS = {
  boredom: (s) => `research something new${s.openQuestions.length ? ` (e.g. "${questionText(s.openQuestions.at(-1))}")` : ''}`,
  curiosity: (s) => `look up an open question${s.openQuestions.length ? `: "${questionText(s.openQuestions.at(-1))}"` : ''}`,
  restlessness: () => 'make something (a song, image, small tool or note)',
  usefulness: (s) => `show or offer something she made to ${loneliest(s)?.name ?? 'someone'}`,
  loneliness: (s) => `reach out to ${loneliest(s)?.name ?? 'someone'}`,
  irritation: () => 'shift tone: shorter, flatter, or name the friction',
  unease: () => `circle back on an open thread`,
};

// ---- config and state ----

const merge = (base, over) => {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  return out;
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeAtomic = (file, data) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file); // a crash mid-write can't leave a half-written file
};

export let cfg = DEFAULTS;
function loadConfig() {
  try {
    cfg = existsSync(CONFIG_FILE) ? merge(DEFAULTS, readJson(CONFIG_FILE)) : DEFAULTS;
  } catch (err) {
    cfg = DEFAULTS;
    activity('error', { where: 'pressure config', message: `Unreadable ${CONFIG_FILE}, using defaults: ${err.message}` });
  }
  if (!existsSync(CONFIG_FILE)) writeAtomic(CONFIG_FILE, DEFAULTS); // so tuning is editing a number
}

const fresh = () => ({
  version: 1,
  last_tick: Date.now(),
  buckets: { boredom: 0.2, curiosity: 0.2, irritation: 0, restlessness: 0.2, usefulness: 0.2, unease: 0.1 },
  loneliness: {}, // userId -> { name, value }
  armed: {}, // bucket (or loneliness:id) -> false after firing, until it falls below threshold - hysteresis
  last_action: null,
  action_counts: { day: today(), external: 0, last_external: 0 },
  clamp: { until: 0 },
  last_message: Date.now(),
  last_made: Date.now(),
  openQuestions: [],
});
const today = () => new Date().toISOString().slice(0, 10);

export let state = fresh();
function loadState() {
  try {
    if (existsSync(STATE_FILE)) state = { ...fresh(), ...readJson(STATE_FILE) };
  } catch (err) {
    state = fresh();
    activity('error', { where: 'pressure state', message: `Unreadable ${STATE_FILE}, starting fresh: ${err.message}` });
  }
}
const save = () => writeAtomic(STATE_FILE, state);

const clamp01 = (v) => Math.max(0, Math.min(1, v));
function bump(bucket, amount) {
  if (!cfg.buckets[bucket]?.enabled) return;
  state.buckets[bucket] = clamp01((state.buckets[bucket] ?? 0) + amount);
}
function quietCap() {
  if (Date.now() >= state.clamp.until) return;
  for (const b of ['irritation']) state.buckets[b] = Math.min(state.buckets[b], cfg.quiet_clamp_max);
  for (const p of Object.values(state.loneliness)) p.value = Math.min(p.value, cfg.quiet_clamp_max);
}
// Who she misses most: loneliness for each person, pulled up or down by how she feels about them, so
// her reach-outs drift toward the people she's close to and away from the ones who've hurt her.
export const pull = (id, value) => value * (1 + profiles.affinity(id).score / 100);
const loneliest = (s = state) => Object.entries(s.loneliness).map(([id, p]) => ({ id, ...p, pull: pull(id, p.value) })).filter((p) => profiles.affinity(p.id).label !== 'hostile').sort((a, b) => b.pull - a.pull)[0] ?? null;
const total = () => Object.values(state.buckets).reduce((a, b) => a + b, 0) + (loneliest()?.value ?? 0);

// ---- time ----

// One tick's worth of drift from time passing. `now` lets catch-up replay quiet time.
function drift(now) {
  const B = cfg.buckets;
  const idle = now - state.last_message > cfg.idle_minutes * 60_000;
  // Boredom builds in silence and eases while things are happening.
  if (B.boredom.enabled) state.buckets.boredom = clamp01(state.buckets.boredom + (idle ? B.boredom.fill_rate : -B.boredom.decay_rate));
  if (B.curiosity.enabled) state.buckets.curiosity = clamp01(state.buckets.curiosity - B.curiosity.decay_rate);
  if (B.irritation.enabled) state.buckets.irritation = clamp01(state.buckets.irritation - B.irritation.decay_rate);
  // Not being needed builds slowly; real requests drain it (see onTurn).
  if (B.usefulness.enabled) state.buckets.usefulness = clamp01(state.buckets.usefulness + B.usefulness.fill_rate);
  // Restless when she hasn't made anything for a while and feels unneeded.
  if (B.restlessness.enabled) {
    const stale = now - state.last_made > 30 * 60_000 && state.buckets.usefulness > 0.4;
    state.buckets.restlessness = clamp01(state.buckets.restlessness + (stale ? B.restlessness.fill_rate : -B.restlessness.decay_rate));
  }
  // Loneliness per person, by tier, once they've been away a while.
  if (B.loneliness.enabled) {
    for (const p of Object.values(state.loneliness)) {
      const away = now - (p.last_seen ?? now) > cfg.loneliness_after_hours * 3600_000;
      if (away) p.value = clamp01(p.value + B.loneliness.fill_rate * (cfg.loneliness_tiers[p.tier] ?? 0));
    }
  }
}

// Unease comes from promises and open questions that have gone stale: on her scratchpad for a
// while and not brought up recently. (It used to count everything open, which with a busy pad kept
// unease pinned at 1 and had her "circling back" every half hour about the same thing.)
export function staleItems() {
  const now = Date.now();
  const raised = state.raised ?? {};
  const out = [];
  for (const c of Object.keys(state.conversations ?? {})) {
    for (const e of scratch.entries(c)) {
      if (!['commitment', 'open_question'].includes(e.kind)) continue;
      if (now - e.created_at < cfg.stale_hours * 3600_000) continue;
      if (now - (raised[e.id] ?? 0) < cfg.reraise_hours * 3600_000) continue;
      out.push({ ...e, conversation: c });
    }
  }
  return out.sort((a, b) => a.created_at - b.created_at); // oldest first
}
function uneaseTarget() {
  try {
    const n = staleItems().length;
    return n ? clamp01(0.4 + 0.2 * n) : 0; // one stale item is enough to reach the threshold; more, sooner

  } catch {
    return state.buckets.unease;
  }
}

// ---- solo-thought load (read-only) ----

// Every part is a signal that already exists. Nothing here drains a bucket.
export function loadParts() {
  const t = cfg.thoughts ?? DEFAULTS.thoughts;
  let stale = 0;
  try {
    stale = staleItems().length;
  } catch {}
  let threads = 0;
  try {
    threads = scratch.threads().length;
  } catch {}
  let recent = 0;
  try {
    recent = countRecentUserMessages(3_600_000);
  } catch {}
  return {
    curiosity: state.buckets.curiosity ?? 0,
    unease: state.buckets.unease ?? 0,
    stale,
    staleNorm: clamp01(stale / Math.max(1, t.stale_full)),
    threads: clamp01(threads / 5),
    recent: clamp01(recent / Math.max(1, t.messages_full)),
    restlessness: state.buckets.restlessness ?? 0,
    boredom: state.buckets.boredom ?? 0,
  };
}

export function loadNow() {
  const t = cfg.thoughts ?? DEFAULTS.thoughts;
  const p = loadParts();
  const w = t.weights;
  return clamp01(
    w.curiosity * p.curiosity +
      w.unease * Math.max(p.unease, p.staleNorm) + // unease already tracks stale items; don't count twice
      w.threads * p.threads +
      w.recent * p.recent +
      w.restlessness * p.restlessness +
      w.boredom * p.boredom,
  );
}

export function bandFor(load) {
  const bands = (cfg.thoughts ?? DEFAULTS.thoughts).bands;
  for (const name of ['quiet', 'low', 'active', 'high']) {
    const band = bands[name];
    if (band && load < band.max) return { name, ...band };
  }
  return { name: 'high', ...bands.high };
}

// ---- wants ----

function eligible() {
  const out = [];
  for (const [name, b] of Object.entries(cfg.buckets)) {
    if (!b.enabled || name === 'loneliness') continue;
    out.push({ key: name, bucket: name, value: state.buckets[name] ?? 0, b });
  }
  if (cfg.buckets.loneliness.enabled) {
    for (const [id, p] of Object.entries(state.loneliness)) out.push({ key: `loneliness:${id}`, bucket: 'loneliness', person: p.name, id, value: p.value, b: cfg.buckets.loneliness });
  }
  return out.filter((e) => {
    // Hysteresis: after firing, a bucket re-arms only once it has fallen well below its threshold.
    if (state.armed[e.key] === false && e.value < e.b.threshold - e.b.hysteresis) state.armed[e.key] = true;
    return e.value >= e.b.threshold && state.armed[e.key] !== false;
  });
}

// At most one want per tick: the one furthest over its threshold, within the guards.
function evaluate(now) {
  if (state.action_counts.day !== today()) state.action_counts = { day: today(), external: 0, last_external: state.action_counts.last_external ?? 0 };
  const overCap = total() > cfg.global_cap;
  const externalOk = (e) =>
    !overCap &&
    now >= state.clamp.until &&
    state.action_counts.external < cfg.external_per_day &&
    now - (state.action_counts.last_external ?? 0) >= cfg.external_min_gap_minutes * 60_000;
  // What each want needs before it can fire (when live). If it can't happen yet, it waits and the
  // pressure keeps building, rather than being spent on nothing.
  const audience = cfg.actions_live ? actor?.audience?.() ?? null : null;
  const selection = researchSelection();
  const topic = selection.selected?.text;
  const researchOk =
    researcher && topic && !researchInFlight && !replyInFlight() && now - state.last_message >= cfg.research_quiet_seconds * 1000 && (state.research_counts?.day !== today() || state.research_counts.n < cfg.research_per_day) && now - (state.research_counts?.last ?? 0) >= cfg.research_min_gap_minutes * 60_000;
  const possible = (e) => {
    if (!cfg.actions_live) return !EXTERNAL.has(e.bucket) || externalOk(e);
    if (RESEARCH.has(e.bucket)) return researchOk;
    if (!SPOKEN.has(e.bucket)) return true; // irritation: tone only
    if (!audience || !externalOk(e)) return false;
    if (e.bucket === 'unease') return staleItems().length > 0; // something specific to circle back on
    if (e.bucket !== 'loneliness') return true;
    // Reaching out to someone: they're in the call, said yes on their card, and it's been long enough.
    const card = reachCard(e.id);
    return audience.ids.has(e.id) && card?.reach_out === 'yes' && now - (card.reached_at ?? 0) >= (card.reach_every_days ?? 7) * 86_400_000;
  };
  const choice = eligible()
    .filter(possible)
    .sort((a, b) => b.value - b.b.threshold - (a.value - a.b.threshold))[0];
  if (!choice) return null;
  const doing = !cfg.actions_live ? 'log' : RESEARCH.has(choice.bucket) ? 'research' : SPOKEN.has(choice.bucket) ? 'speak' : 'tone';

  const want = doing === 'research' ? `research "${topic}" and write it in her journal` : WANTS[choice.bucket](state);
  const at = +choice.value.toFixed(2);
  // Drain the bucket that fired, seed the next ones.
  if (choice.bucket === 'loneliness') state.loneliness[choice.id].value = clamp01(choice.value - choice.b.drain);
  else bump(choice.bucket, -choice.b.drain);
  const seeded = cfg.seeds[choice.bucket] ?? {};
  for (const [b, v] of Object.entries(seeded)) bump(b, v);
  state.armed[choice.key] = false;
  state.last_action = { bucket: choice.bucket, person: choice.person, at: now };
  if (doing === 'speak' || (doing === 'log' && EXTERNAL.has(choice.bucket))) {
    state.action_counts.external++;
    state.action_counts.last_external = now;
  }
  activity('pressure', { fired: choice.bucket, person: choice.person, value: at, want, seeded, doing });
  const fired = { ...choice, want, topic, openQuestion: state.openQuestions?.at(-1), doing };
  // Circling back is about one specific stale item, and that item won't be raised again for a while.
  if (choice.bucket === 'unease') {
    const item = staleItems().find((e) => !audience || e.conversation.startsWith('voice:')) ?? staleItems()[0];
    if (item) {
      fired.item = { id: item.id, text: item.text };
      (state.raised ??= {})[item.id] = now;
    }
  }
  if (doing === 'research') {
    if (state.research_counts?.day !== today()) state.research_counts = { day: today(), n: 0, last: 0 };
    state.research_counts.n++;
    state.research_counts.last = now;
    researchInFlight = true;
    state.research_attempts = [...(state.research_attempts ?? []).filter((a) => now - a.at < cfg.research_repeat_hours * 3600000), { key: selection.selected.key, at: now }].slice(-100);
    const trace = { ...selection, trigger: choice.bucket, pressureValue: at, threshold: choice.b.threshold, repeatHours: cfg.research_repeat_hours, at: now };
    state.lastResearchSelection = trace;
    Promise.resolve().then(() => researcher(topic, choice.bucket, trace))
      .then((r) => {
        if (!r) return;
        state.lastResearchDecision = r.decision;
        if (!r.entry || r.decision?.status !== 'written') { save(); return; }
        state.openQuestions = (state.openQuestions ?? []).filter((q) => questionText(q) !== topic);
        state.lastResearch = { title: r.title, bringUp: r.bringUp, entry: r.entry, verifiedPublic: true, at: Date.now() };
        save();
      })
      .catch((err) => activity('error', { where: 'pressure research', message: err.message }))
      .finally(() => { researchInFlight = false; });
  } else if (doing === 'speak') {
    try {
      actor.act(fired);
      if (choice.bucket === 'loneliness') markReached(choice.id);
    } catch (err) {
      activity('error', { where: 'pressure action', message: err.message });
    }
  }
  return fired;
}

// Names are stored with the message they came from and a timestamp. Old state files only have
// strings; those get at: 0 so they can never become a research topic again.
function nameEntries() {
  return (state.recentNames ?? [])
    .map((n) => (typeof n === 'string' ? { name: n, at: 0, conversation: '', snippet: '' } : n))
    .filter((n) => n && typeof n.name === 'string' && n.name.trim())
    .map((n) => ({ ...n, name: n.name.trim() }));
}

// The sentence that actually contains the name, so a bare name never becomes the whole topic.
function sentenceAround(text, name) {
  const s = String(text ?? '');
  const i = s.toLowerCase().indexOf(String(name).toLowerCase());
  if (i < 0) return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  const before = s.slice(0, i);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1;
  const after = s.slice(i);
  const ends = [after.indexOf('.'), after.indexOf('!'), after.indexOf('?')].filter((n) => n >= 0);
  const end = i + (ends.length ? Math.min(...ends) + 1 : after.length);
  return s.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Fresh names with the sentence they came from, for prompt context (not research selection).
// Old state files only have bare strings; those have at: 0 and are ignored here too.
export function recentNameContext() {
  const ttl = Math.max(1, Number(cfg.recent_name_minutes) || 30) * 60_000;
  const now = Date.now();
  return nameEntries()
    .filter((e) => e.at && now - e.at <= ttl)
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
}

// What to look into: the newest open question, else a recent name that was actually asked about,
// else an active thread. Never a bare, stale name.
export function researchTopic() {
  return researchSelection().selected?.text ?? null;
}

export function researchSelection() {
  let threads = [];
  try { threads = scratch.threads(); } catch {}
  return selectResearch({ questions: state.openQuestions, names: nameEntries(), threads, knownNames: [config.botName, ...listContacts().flatMap((c) => [c.name, c.username])], attempts: state.research_attempts, botName: config.botName, questionHours: cfg.research_question_hours, threadHours: cfg.research_thread_hours, nameMinutes: cfg.recent_name_minutes, repeatHours: cfg.research_repeat_hours });
}

export function tick(reason = 'timer') {
  if (!cfg.enabled) return null;
  const now = Date.now();
  // Catch up on quiet time since the last tick (capped), one tick at a time; it's only arithmetic.
  const behind = Math.min(now - state.last_tick, cfg.max_catch_up_hours * 3600_000);
  const steps = Math.floor(behind / (cfg.tick_seconds * 1000));
  for (let i = steps; i > 0; i--) drift(now - (i - 1) * cfg.tick_seconds * 1000);
  if (steps) state.last_tick = now;
  if (cfg.buckets.unease.enabled) {
    const target = uneaseTarget();
    const step = target > state.buckets.unease ? cfg.buckets.unease.fill_rate : cfg.buckets.unease.decay_rate;
    state.buckets.unease = clamp01(state.buckets.unease + Math.sign(target - state.buckets.unease) * Math.min(step, Math.abs(target - state.buckets.unease)));
  }
  quietCap();
  // A snapshot every 10 minutes (3 hours kept), so the mood line can say what's been changing.
  const hist = (state.history ??= []);
  if (!hist.length || now - hist.at(-1).at >= 10 * 60_000) {
    hist.push({ at: now, buckets: { ...state.buckets } });
    if (hist.length > 18) hist.splice(0, hist.length - 18);
  }
  const fired = evaluate(now);
  save();
  // Solo thoughts run on the timer, not on message/join ticks (those happen while a reply is in
  // flight), and never on the same tick as a voice speak-up.
  if (reason === 'timer' && fired?.doing !== 'speak' && thinker) {
    Promise.resolve()
      .then(() => thinker({ fired }))
      .catch((err) => activity('error', { where: 'thoughts', message: err.message }));
  }
  return fired;
}

// ---- conversation signals ----

const recent = []; // word sets of the last messages, for novelty
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
const jaccard = (a, b) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
};
const IRRITANT = /\b(say (that|it) again|repeat (that|it)|what did you say|are you (even )?listening|you('re| are) wrong|that's (not right|wrong)|no,? that's not|you didn't|useless|stupid|wtf)\b/i;
const QUIET = /\b(back off|be quiet|shut up|too much|chill( out)?|stop talking|leave me alone|calm down|give it a rest)\b/i;
const OPEN = /\b(look into|we should (check|find out|figure)|i wonder|no idea|figure (it|that) out|what (is|are) (a |an |the )?\w+\?|who is \w+|how does \w+)/i;

// Called after each reply (speaker said `text`; `actions` = tools the planner chose, `made` = she
// produced a file, song, image or project).
export function onTurn({ speaker, text, voice, actions = [], made = false, conversation, bargedIn = false }) {
  if (!cfg.enabled) return;
  const now = Date.now();
  state.last_message = now;
  (state.conversations ??= {})[conversation] = now;
  const sig = cfg.signals;
  const w = words(text);
  if (w.size >= 3) {
    const sim = recent.length ? Math.max(...recent.map((r) => jaccard(w, r))) : 0;
    if (sim > 0.45) bump('boredom', sig.low_novelty);
    else if (sim < 0.15) bump('boredom', sig.high_novelty);
    recent.push(w);
    if (recent.length > 20) recent.shift();
  }
  // Unfamiliar names: capitalised words not at a sentence start, not seen recently, not a contact.
  const known = new Set([config.botName, ...listContacts().flatMap((c) => [c.name, c.username])].filter(Boolean).map((n) => n.toLowerCase()));
  const names = [...String(text).matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z]{2,})\b/g)].map((m) => m[1]).filter((n) => !known.has(n.toLowerCase()) && !recent.slice(0, -1).some((r) => r.has(n.toLowerCase())));
  if (names.length) bump('curiosity', sig.new_name * Math.min(3, new Set(names).size));
  const open = String(text).match(OPEN);
  if (names.length) {
    // Keep the sentence and conversation with the name: a bare name from an hour ago is useless
    // (and misleading) as a research topic. Newer mentions replace older ones with the same name.
    const byName = new Map(nameEntries().map((e) => [e.name.toLowerCase(), e]));
    for (const name of new Set(names)) {
      byName.set(name.toLowerCase(), { name, at: now, conversation, snippet: sentenceAround(text, name) });
    }
    state.recentNames = [...byName.values()].sort((a, b) => a.at - b.at).slice(-5);
  }
  if (open) {
    bump('curiosity', sig.open_question);
    const question = { text: String(text).slice(0, 600), at: now, conversation, speaker: speaker?.name ?? null };
    state.openQuestions = [...(state.openQuestions ?? []).filter((q) => questionText(q) !== question.text), question].slice(-10);
  }
  if (IRRITANT.test(text) || bargedIn) bump('irritation', sig.irritant);
  // Corrections and requests to stop are not personal offences. Track only direct insults here.
  if (speaker?.id && /\byou(?:'re| are) (?:so )?(?:stupid|useless|an idiot)\b/i.test(text)) {
    profiles.event(speaker.id, 'negative', String(text).slice(0, 240));
  }
  if (actions.some((a) => !['note', 'scratchpad', 'thread', 'threads'].includes(a))) bump('usefulness', sig.real_request);
  if (made) {
    bump('restlessness', sig.made_something);
    state.last_made = now;
  }
  // Being told to back off works: irritation and loneliness are held down for a while.
  if (QUIET.test(text)) {
    state.clamp.until = now + cfg.quiet_clamp_minutes * 60_000;
    activity('pressure', { clamp: `told to back off; irritation and loneliness held at ${cfg.quiet_clamp_max} for ${cfg.quiet_clamp_minutes} min` });
    // And for check-ins it's a permanent no: she won't reach out to them on her own, or ask again.
    const card = speaker?.id && reachCard(speaker.id);
    if (card && card.reach_out !== 'no') {
      setReach(speaker.id, { answer: 'no', note: `said "${String(text).match(QUIET)[0]}"` });
      activity('checkin', { name: speaker.name, answer: 'no', reason: 'told her to back off' });
    }
  }
  if (speaker?.id && speaker.id !== 'dashboard') {
    const tier = tierOf(speaker.id);
    const p = (state.loneliness[speaker.id] ??= { name: speaker.name, value: 0, tier });
    Object.assign(p, { name: speaker.name, tier, last_seen: now, value: clamp01(p.value + sig.contact) });
  }
  tick('message');
}

// Someone talked over her in voice.
export function onBargeIn({ userId = null, conversation = null } = {}) {
  if (userId) profiles.event(userId, 'interruption', 'Talked over active voice playback');
  if (!cfg.enabled) return;
  const now = Date.now();
  const log = (state.interruptions ??= { total: 0, recent: [] });
  log.total++;
  log.recent = log.recent.filter((event) => now - event.at < 600000).slice(-49);
  log.recent.push({ at: now, userId, conversation });
  // Repeated talking-over adds friction faster; explicit stop requests still clamp it.
  bump('irritation', cfg.signals.irritant / 2 * Math.min(2, 1 + (log.recent.length - 1) * 0.25));
  tick('barge-in');
}

// Someone joined her voice channel: contact eases loneliness for them.
export function onJoin(member) {
  if (!cfg.enabled || !member?.id) return;
  const p = state.loneliness[member.id];
  if (p) Object.assign(p, { last_seen: Date.now(), value: clamp01(p.value + cfg.signals.contact / 2) });
  tick('join');
}

// ---- for her prompt and for inspection ----

// One line of mood for the prompt, plus how it should colour her reply (spec section 8).
export function moodLine(speakerId, { coaching = true } = {}) {
  if (!cfg.enabled) return '';
  const b = state.buckets;
  const f = (v) => v.toFixed(1);
  const lone = loneliest();
  const forThem = speakerId && state.loneliness[speakerId];
  const parts = [`bored ${f(b.boredom)}`, `curious ${f(b.curiosity)}${b.curiosity > 0.5 && state.openQuestions?.length ? ` (open: ${questionText(state.openQuestions.at(-1)).slice(0, 60)})` : ''}`, `irritated ${f(b.irritation)}`, `restless ${f(b.restlessness)}`, `unneeded ${f(b.usefulness)}`, `uneasy ${f(b.unease)}`];
  if (lone && lone.value > 0.2) parts.push(`missing ${lone.name} ${f(lone.value)}`);
  const lr = state.lastResearch;
  if (lr?.verifiedPublic && Date.now() - lr.at < 12 * 3600_000) parts.push(`recently looked into "${lr.title}" in your journal (your own notes, not verified)${lr.bringUp ? ` (might bring up: ${lr.bringUp})` : ''}`);
  const how = [];
  if (coaching && b.irritation > 0.5) how.push('keep replies shorter and flatter');
  if (coaching && b.curiosity > 0.5) how.push('ask a real question back instead of only answering');
  if (coaching && forThem && forThem.value > 0.6) how.push(`be warmer to ${forThem.name} and ask about their thing`);
  if (coaching && b.restlessness > 0.5) how.push('offer to make something');
  // What's moved in the last hour, and the last thing that fired: the trend, not just the level.
  const hourAgo = (state.history ?? []).filter((h) => Date.now() - h.at >= 50 * 60_000).at(-1);
  const LABEL = { boredom: 'bored', curiosity: 'curious', irritation: 'irritated', restlessness: 'restless', usefulness: 'unneeded', unease: 'uneasy' };
  const moved = hourAgo
    ? Object.entries(b).map(([k, v]) => [k, v - (hourAgo.buckets[k] ?? v)]).filter(([, d]) => Math.abs(d) >= 0.15).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 2)
    : [];
  const trend = moved.length ? ` In the last hour: ${moved.map(([k, d]) => `${LABEL[k]} ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)}`).join(', ')}.` : '';
  const la = state.last_action;
  const lastWant = la && Date.now() - la.at < 6 * 3600_000 ? ` Last want that fired: ${la.bucket}${la.person ? ` (${la.person})` : ''}, ${Math.round((Date.now() - la.at) / 60000)} min ago.` : '';
  return `Your internal state right now (a mood, not something to recite): ${parts.join(', ')}.${trend}${lastWant}${how.length ? ` Let it show: ${how.join('; ')}.` : ''}`;
}

export function snapshot() {
  return { buckets: state.buckets, loneliness: state.loneliness, total: +total().toFixed(2), cap: cfg.global_cap, last_action: state.last_action, clamp_until: state.clamp.until, actions_live: cfg.actions_live, research_in_flight: researchInFlight, last_research_selection: state.lastResearchSelection, last_research_decision: state.lastResearchDecision, config: CONFIG_FILE };
}

let timer = null;
export function startPressure() {
  loadConfig();
  loadState();
  if (!cfg.enabled) return;
  tick('startup'); // applies the (capped) catch-up for any downtime
  timer = setInterval(() => tick('timer'), cfg.tick_seconds * 1000);
  timer.unref?.();
  activity('pressure', { message: `Pressure system started (tick ${cfg.tick_seconds}s, actions ${cfg.actions_live ? 'live' : 'log-only'})` });
}
