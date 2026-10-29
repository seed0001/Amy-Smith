import { config } from '../config.js';
import { listContacts, listMemories, promptMessages, reachCard } from '../memory.js';

// A private read of the room for the voice-join greeting: who is here, who she already knows,
// what she remembers about them, and the last things said in this call. It is prompt context only;
// it is never spoken or saved as a message.

const clean = (text, max = 220) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function ownerName() {
  const owner = listContacts().find((c) => config.ownerIds.includes(c.user_id));
  return owner?.name ?? 'the owner';
}

export function roomContext({ humans = [], conversation, newPeople = [], now = Date.now() } = {}) {
  if (!humans.length) return '';
  const contacts = listContacts();
  const byId = new Map(contacts.map((c) => [c.user_id, c]));
  const newIds = new Set(newPeople.map((p) => p.id));
  const lines = [];

  for (const m of humans) {
    const c = byId.get(m.id);
    const isNew = newIds.has(m.id) || !c;
    const tags = [];
    if (config.ownerIds.includes(m.id)) tags.push('owner');
    else if (c?.tier && c.tier !== 'stranger') tags.push(c.tier);
    tags.push(isNew ? 'new to you in voice' : 'you know them');
    const last = c?.last_seen ? `last spoke ${ago(now - c.last_seen)}` : '';
    const memories = listMemories(m.id)
      .slice(-4)
      .map((x) => clean(x.content, 200))
      .filter(Boolean);
    const card = reachCard(m.id);
    const note = card?.reach_note ? `They said they'd like to talk about: ${clean(card.reach_note, 160)}` : '';
    lines.push(
      `- ${m.displayName} (${tags.join(', ')}${last ? `, ${last}` : ''}).` +
        (memories.length ? ` Things you remember: ${memories.join(' | ')}.` : '') +
        (note ? ` ${note}.` : ''),
    );
  }

  const recent = conversation
    ? promptMessages(conversation)
        .slice(-8)
        .map((m) => `- ${m.role === 'assistant' ? config.botName : m.name ?? 'Someone'}: ${clean(m.content, 180)}`)
    : [];

  return [
    `Who is in the voice call right now (your private read of the room; never read this out loud or mention that you have notes):`,
    ...lines,
    recent.length ? `The last things said in this call:\n${recent.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function roomGreetingCue({ newPeople = [] } = {}) {
  const wake = config.voice.wakeWord ? ` They can talk to you by saying "${config.voice.wakeWord}".` : '';
  const intro = newPeople.length
    ? `Some people here haven't met you in voice. Introduce yourself briefly: your name, that you're an AI on this server listening in, that you remember what people tell you and get to know them over time, and that they can take any concerns to ${ownerName()}.${wake}`
    : `You already know everyone here in voice.`;
  return [
    `You just joined the voice call. Read the room from your private notes and greet everyone like a person joining a call.`,
    intro,
    `Say hi to anyone you know by name and pick up where you left off with one or two of them: ask about something you remember or the last thing you talked about.`,
    `If anyone new or unfamiliar is here, keep what you say about other people general, and don't share details they haven't said themselves in this call.`,
    `Don't list everyone mechanically, don't recite the notes, and don't mention that you have notes or a memory system.`,
    `Just say the greeting directly; don't narrate your thinking first.`,
    `Keep it casual and relaxed: 2-4 short spoken sentences, not formal or creepy. Never reveal private, sensitive, or embarrassing details (health, money, relationships, family, anything they would not want said in front of others); use those only to choose a safe topic, or leave them out.`,
    `If you don't know anyone, just introduce yourself and ask what's up.`,
  ].join(' ');
}
