// Two Fish Audio voices in a call: her normal one and a stronger one for serious moments.
// She picks with the voice_tone tool; the rules here keep it conservative:
// - strong needs a reason (a serious situation, or frustration that has lasted several messages);
// - once she switches, she holds that voice at least HOLD_MS before switching again (no flip-flopping);
// - strong wears off by itself after STRONG_MS unless she renews it, so she never gets stuck in it;
// - the owner can force either voice ("override"), which skips the hold and pins it for PIN_MS,
//   during which her own choices are refused; "auto" hands the choice back to her.
// State is per conversation and in memory: a restart always starts in the normal voice.

export const HOLD_MS = 3 * 60_000;
export const STRONG_MS = 15 * 60_000;
export const PIN_MS = 30 * 60_000;

const state = new Map(); // conversation -> { tone, since, until, pinnedUntil, reason }

const mins = (ms) => Math.max(1, Math.round(ms / 60_000));

export function strongVoiceReady(config) {
  if (config.tts !== 'fish') return 'Your second voice is a Fish Audio voice; you are speaking with a local engine right now.';
  if (!config.fish.strongVoiceId) return 'No stronger voice is set up yet. Your owner can add its Fish Audio voice ID in the dashboard under Settings > Voice.';
  return '';
}

// The current tone, after letting an expired strong voice wear off.
export function currentTone(conversation, now = Date.now()) {
  const s = state.get(conversation);
  if (!s) return { tone: 'normal' };
  if (s.tone === 'strong' && s.until <= now) {
    state.set(conversation, { tone: 'normal', since: now, until: 0, pinnedUntil: 0, reason: 'wore off' });
    return state.get(conversation);
  }
  return s;
}

// The Fish voice to speak with in this conversation (the normal voice unless strong is on and set up).
export function voiceIdFor(conversation, config, now = Date.now()) {
  return currentTone(conversation, now).tone === 'strong' && !strongVoiceReady(config) ? config.fish.strongVoiceId : config.fish.voiceId;
}

export function describeTone(conversation, config, now = Date.now()) {
  const s = currentTone(conversation, now);
  const missing = strongVoiceReady(config);
  let text = `You are using your ${s.tone} voice${s.reason ? ` (${s.reason})` : ''}.`;
  if (s.tone === 'strong') text += ` It goes back to normal by itself in about ${mins(s.until - now)} min unless you renew it.`;
  if (s.pinnedUntil > now) text += ` Your owner pinned it for about ${mins(s.pinnedUntil - now)} more min; don't change it unless they ask.`;
  if (missing) text += ` ${missing}`;
  return text;
}

// action: status | strong | normal | auto. override only counts when the owner asked for it.
export function setTone(conversation, { action = 'status', reason = '', override = false } = {}, { config, owner = false, now = Date.now(), activity = () => {} }) {
  if (!['status', 'strong', 'normal', 'auto'].includes(action)) throw new Error('Unknown voice tone action');
  const s = currentTone(conversation, now);
  if (action === 'status') return describeTone(conversation, config, now);
  if (override && !owner) throw new Error('Only your owner can force a voice. Choose for yourself, without override');
  if (action === 'auto') {
    if (!owner) throw new Error('Only your owner can hand the voice choice back');
    state.set(conversation, { ...s, pinnedUntil: 0 });
    return `Voice choice is yours again. ${describeTone(conversation, config, now)}`;
  }
  if (action === 'strong') {
    const missing = strongVoiceReady(config);
    if (missing) throw new Error(missing);
  }
  reason = String(reason ?? '').trim().slice(0, 120);
  if (!override) {
    if (s.pinnedUntil > now) throw new Error(`Your owner pinned your ${s.tone} voice; keep it for now (about ${mins(s.pinnedUntil - now)} more min) unless they ask`);
    if (action === 'strong' && !reason) throw new Error('Say why: the stronger voice is only for a serious situation or frustration that has lasted several messages');
    if (action === 'strong' && s.tone === 'strong') {
      // Renewing keeps it going without counting as a switch.
      state.set(conversation, { ...s, until: now + STRONG_MS, reason });
      return describeTone(conversation, config, now);
    }
    if (action === s.tone) return describeTone(conversation, config, now);
    if (s.since && now - s.since < HOLD_MS) throw new Error(`You switched voices under ${mins(HOLD_MS)} min ago; keep your ${s.tone} voice a little longer`);
  }
  state.set(conversation, {
    tone: action,
    since: now,
    until: action === 'strong' ? now + (override ? PIN_MS : STRONG_MS) : 0,
    pinnedUntil: override ? now + PIN_MS : 0,
    reason: reason || (override ? 'owner asked' : ''),
  });
  activity('voice-tone', { conversation, tone: action, override, reason });
  return describeTone(conversation, config, now);
}
