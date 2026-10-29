import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity } from './events.js';
import { localChat } from './llm.js';
import { promptMessages } from './memory.js';
import * as scratch from './scratchpad.js';
import * as pressure from './pressure.js';
import { replyInFlight } from './busy.js';

// Solo thoughts: what she thinks to herself between conversations. This is deliberately separate
// from the per-reply inner monologue and from respond({ cue }): no user message, no memory
// extraction, no assistant turn in a channel's history, and always local Ollama. A thought is
// scored from pressure/scratchpad signals, generated locally, stored in SQLite, and only then
// maybe posted to the one configured channel.

const db = new DatabaseSync(path.join(DATA_DIR, 'companion.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS thoughts (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    load REAL NOT NULL,
    depth TEXT NOT NULL,
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    posted INTEGER NOT NULL DEFAULT 0,
    channel TEXT
  );
  CREATE INDEX IF NOT EXISTS thoughts_at ON thoughts (at);
`);

const MAX_ROWS = 200;
const KEEP_MS = 14 * 86_400_000;
const PROMPT_THOUGHTS = 3;
const HUMAN_QUIET_MS = 30_000;

const q = {
  insert: db.prepare('INSERT INTO thoughts (at, load, depth, topic, content, posted, channel) VALUES (?, ?, ?, ?, ?, 0, NULL)'),
  recent: db.prepare('SELECT * FROM thoughts ORDER BY id DESC LIMIT ?'),
  recentPosted: db.prepare('SELECT * FROM thoughts WHERE posted = 1 ORDER BY id DESC LIMIT ?'),
  search: db.prepare('SELECT * FROM thoughts WHERE content LIKE ? OR topic LIKE ? ORDER BY id DESC LIMIT ?'),
  searchPosted: db.prepare('SELECT * FROM thoughts WHERE posted = 1 AND (content LIKE ? OR topic LIKE ?) ORDER BY id DESC LIMIT ?'),
  last: db.prepare('SELECT at FROM thoughts ORDER BY id DESC LIMIT 1'),
  countToday: db.prepare('SELECT COUNT(*) AS n FROM thoughts WHERE at >= ?'),
  markPosted: db.prepare('UPDATE thoughts SET posted = 1, channel = ? WHERE id = ?'),
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function tidy() {
  const now = Date.now();
  db.prepare('DELETE FROM thoughts WHERE at < ?').run(now - KEEP_MS);
  db.prepare('DELETE FROM thoughts WHERE id NOT IN (SELECT id FROM thoughts ORDER BY id DESC LIMIT ?)').run(MAX_ROWS);
}

// The poster is registered by bot.js (it owns the Discord client). Keeping it a callback means
// thoughts.js never imports the bot, and the channel is resolved at post time, not startup.
let poster = null;
export const setPoster = (p) => (poster = p);

// When anyone last spoke in a channel. bot.js records every human message it sees, including
// channels it does not reply in, so a thought never lands on top of live traffic.
const lastHuman = new Map();
export function noteChannelActivity(channelId) {
  const id = String(channelId ?? '');
  if (!id) return;
  lastHuman.set(id, Date.now());
  if (lastHuman.size > 200) {
    const cutoff = Date.now() - 3_600_000;
    for (const [key, at] of lastHuman) if (at < cutoff) lastHuman.delete(key);
  }
}
export const lastHumanAt = (channelId) => lastHuman.get(String(channelId ?? '')) ?? 0;

// ---- retrieval ----

export function recent(limit = 5) {
  return q.recent.all(clamp(Math.round(Number(limit) || 5), 1, 50));
}

export function search(query, limit = 5) {
  const n = clamp(Math.round(Number(limit) || 5), 1, 50);
  const like = `%${String(query ?? '').trim()}%`;
  return q.search.all(like, like, n);
}

// Owner sees everything. Friends only see thoughts that were actually posted somewhere, since an
// unposted thought can quote an overheard conversation from a channel they cannot see.
export function recentFor(ctx = {}, limit = 5, query = '') {
  const n = clamp(Math.round(Number(limit) || 5), 1, 10);
  const owner = Boolean(ctx.perms?.owner);
  if (!owner && ctx.perms?.tier !== 'friend') return [];
  const needle = String(query ?? '').trim();
  if (needle) {
    const like = `%${needle}%`;
    return owner ? q.search.all(like, like, n) : q.searchPosted.all(like, like, n);
  }
  return owner ? recent(n) : q.recentPosted.all(n);
}

export function countToday() {
  return q.countToday.get(startOfToday()).n;
}

export function lastAt() {
  return q.last.get()?.at ?? 0;
}

export function formatRows(rows) {
  return rows
    .map((r) => {
      const when = new Date(r.at).toLocaleString();
      const where = r.posted ? `posted in ${r.channel ? `<#${r.channel}>` : 'Discord'}` : 'private';
      return `${when} · ${r.depth} · ${r.topic} · ${where}\n${r.content}`;
    })
    .join('\n\n');
}

// The last few thoughts, as private context in the reply prompt. Not something to recite. For
// anyone but the owner only posted thoughts are included, matching what they could retrieve with
// recent_thoughts; an unposted thought may quote a conversation they were never part of.
export function promptBlock({ postedOnly = false } = {}) {
  const rows = (postedOnly ? q.recentPosted.all(PROMPT_THOUGHTS) : recent(PROMPT_THOUGHTS)).filter(
    (r) => Date.now() - r.at < 86_400_000,
  );
  if (!rows.length) return '';
  return `Your own recent thoughts (not messages from anyone; don't recite them unless asked):\n${rows
    .map((r) => `- ${r.content}`)
    .join('\n')}`;
}

// ---- generation ----

const splitSentences = (text) =>
  (String(text ?? '').match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);

function clean(text) {
  return String(text ?? '')
    .replace(/^\s*(thought|inner monologue|solo thought)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/@(everyone|here)\b/gi, '')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

function cleanTopic(text, fallback) {
  const topic = String(text ?? '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  if (topic) return topic;
  return String(fallback ?? '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'something on my mind';
}

function lengthLine(band) {
  const [min, max] = band.sentences;
  if (band.name === 'quiet') return 'Exactly one short sentence: an idle musing, nothing more.';
  if (band.name === 'low') return 'One or two sentences.';
  if (band.name === 'active') return 'Three to six sentences.';
  return 'One short paragraph, six to twelve sentences. No lists or headings.';
}

function buildMessages(load, band) {
  const st = pressure.state;
  const fuel = [];
  try {
    const threads = scratch.threads();
    if (threads.length) fuel.push(`Threads you are following:\n${threads.map((t) => `- ${t.label}: ${t.state}`).join('\n')}`);
  } catch {}
  try {
    const stale = pressure.staleItems().slice(0, 4);
    if (stale.length) fuel.push(`Open things on your scratchpad:\n${stale.map((e) => `- [${e.kind}] ${e.text}`).join('\n')}`);
  } catch {}
  if (st.lastResearch && Date.now() - st.lastResearch.at < 12 * 3_600_000) {
    const r = st.lastResearch;
    fuel.push(
      `You recently looked into "${r.title}" in your journal.` +
        `${r.entry ? ` What you wrote: "${String(r.entry).slice(0, 600)}"` : ''}` +
        `${r.bringUp ? ` You thought about bringing up: ${r.bringUp}` : ''}` +
        ` (This was your own research, not a verified fact.)`,
    );
  }
  const recentNames = pressure.recentNameContext();
  if (recentNames.length) {
    fuel.push(
      `Names that came up recently (with what was said):\n${recentNames.map((n) => `- ${n.name}: "${String(n.snippet).slice(0, 160)}"`).join('\n')}`,
    );
  }

  const own = recent(3);
  if (own.length) {
    fuel.push(`Your last thoughts (do not repeat them, and do not continue them as if you were talking to someone):\n${own.map((r) => `- ${r.content}`).join('\n')}`);
  }

  try {
    const conversation = Object.entries(st.conversations ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (conversation) {
      const lines = promptMessages(conversation)
        .slice(-8)
        .map((m) => `${m.role === 'assistant' ? m.name ?? config.botName : m.name ?? 'Someone'}: ${String(m.content).slice(0, 300)}`);
      if (lines.length) fuel.push(`What you overheard recently (context, not a message to answer):\n${lines.join('\n')}`);
    }
  } catch {}

  return [
    {
      role: 'system',
      content: [
        `You are ${config.botName}. You are thinking to yourself, not talking to anyone. There is no one to greet and nothing to answer.`,
        config.persona,
        pressure.moodLine(undefined, { coaching: false }),
        fuel.length ? `What is on your mind:\n${fuel.join('\n\n')}` : '',
        `Your thought load is ${load.toFixed(2)} (${band.name}).`,
        `Write one private thought, first person, interior, in your own voice. ${lengthLine(band)} No greeting, no @mentions, no offer to help, no plan to use tools, and no question to anyone.`,
        `Reply as JSON only: {"topic": "three to eight words", "thought": "the thought itself"}.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    { role: 'user', content: 'Think now.' },
  ];
}

async function generate(load, band) {
  const messages = buildMessages(load, band);
  const raw = await localChat(messages, { format: 'json' });
  let data = null;
  try {
    data = JSON.parse(String(raw ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    data = { thought: raw, topic: '' };
  }

  let thought = clean(data?.thought);
  if (!thought) return null;
  let topic = cleanTopic(data?.topic, thought);
  let sentences = splitSentences(thought);
  const [min, max] = band.sentences;

  // One more go if it came back far too short for the band. Max length is handled by cutting.
  if (sentences.length < min && band.name !== 'quiet') {
    const retry = await localChat(
      [
        ...messages,
        { role: 'assistant', content: String(raw ?? '') },
        { role: 'user', content: `(Too short. ${lengthLine(band)} Think again, same JSON shape.)` },
      ],
      { format: 'json' },
    );
    try {
      const again = JSON.parse(String(retry ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      const retryThought = clean(again?.thought);
      if (retryThought) {
        thought = retryThought;
        topic = cleanTopic(again?.topic, retryThought);
        sentences = splitSentences(thought);
      }
    } catch {}
  }

  if (sentences.length > max) thought = sentences.slice(0, max).join(' ').trim();
  if (!thought) return null;

  // The next thought must not rehash the last few topics. One retry with a different angle.
  const lastTopics = recent(3).map((r) => normalize(r.topic));
  if (lastTopics.includes(normalize(topic))) {
    const retry = await localChat(
      [
        ...messages,
        { role: 'assistant', content: String(raw ?? '') },
        { role: 'user', content: `(You already thought about "${topic}". Pick a different angle or subject, and do not continue the old thought. Same JSON shape.)` },
      ],
      { format: 'json' },
    );
    try {
      const again = JSON.parse(String(retry ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      const retryThought = clean(again?.thought);
      if (retryThought) {
        thought = retryThought;
        topic = cleanTopic(again?.topic, retryThought);
        const retrySentences = splitSentences(thought);
        if (retrySentences.length > max) thought = retrySentences.slice(0, max).join(' ').trim();
      }
    } catch {}
  }

  return { thought, topic };
}

// ---- the loop ----

let thinking = false;
let localDownUntil = 0;

export async function think({ fired } = {}) {
  if (!config.soloMonologue || thinking) return null;
  if (fired?.doing === 'speak') return null; // voice speak-up owns this tick
  const now = Date.now();
  if (now < localDownUntil) return null;
  if (replyInFlight()) return null;

  const load = pressure.loadNow();
  const band = pressure.bandFor(load);
  const last = lastAt();
  if (last && now - last < band.gap_minutes * 60_000) return null;
  if (countToday() >= band.cap) return null;

  const channelId = String(config.thoughtChannelId ?? '').trim();
  if (channelId && now - lastHumanAt(channelId) < HUMAN_QUIET_MS) return null;
  if (poster?.busy?.()) return null;

  thinking = true;
  try {
    const generated = await generate(load, band);
    if (!generated) return null;

    const id = Number(q.insert.run(now, +load.toFixed(3), band.name, generated.topic, generated.thought).lastInsertRowid);
    tidy();

    const clamped = Number(pressure.state?.clamp?.until ?? 0) > now;
    let posted = false;
    let channel = null;
    let postReason = null;
    if (channelId && !clamped && poster?.post) {
      try {
        const italic = generated.thought
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => `*${p}*`)
          .join('\n');
        const result = await poster.post({ channelId, content: italic });
        if (result?.posted) {
          channel = result.channel ?? channelId;
          q.markPosted.run(channel, id);
          posted = true;
        } else if (result?.reason) {
          postReason = result.reason;
        }
      } catch (err) {
        postReason = 'post_failed';
        activity('error', { where: 'thought post', message: err.message });
      }
    } else if (channelId && clamped) {
      postReason = 'quiet_clamp';
    } else if (!channelId) {
      postReason = 'no_channel';
    } else if (!poster?.post) {
      postReason = 'no_poster';
    }

    activity('thought', {
      id,
      load: +load.toFixed(2),
      band: band.name,
      topic: generated.topic,
      posted,
      channel,
      post_reason: postReason || undefined,
    });
    return { id, ...generated, load, band: band.name, posted, channel };
  } catch (err) {
    // Ollama down or the model failed: skip and don't hammer it every tick.
    localDownUntil = Date.now() + 60_000;
    activity('error', { where: 'thoughts', message: err.message });
    return null;
  } finally {
    thinking = false;
  }
}

// A read-only snapshot for self/tools and the dashboard.
export function status() {
  const load = pressure.loadNow();
  const band = pressure.bandFor(load);
  const last = recent(1)[0] ?? null;
  return {
    enabled: config.soloMonologue,
    channel: config.thoughtChannelId || '',
    load: +load.toFixed(2),
    band: band.name,
    gap_minutes: band.gap_minutes,
    cap: band.cap,
    today: countToday(),
    last,
  };
}

// Keep the table tidy at startup too, not only after the next thought.
tidy();
