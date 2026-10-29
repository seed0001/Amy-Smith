import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Action claims, and the tool that has to have succeeded for each to be true. Override or extend
// in data/phantom-claims.json ({"tool": "regex"}); false alarms are cheaper than misses.
const CLAIMS = {
  send_file: /\b(i('ve| have)? sent|sent (it|that|you)|it'?s attached|attached (it|the file)|here'?s the file)\b/i,
  send_project: /\b(zipped (it|them|up)|sent (you )?the (project|zip))\b/i,
  post_message: /\b(i('ve| have)? posted|posted (it|that) (in|to)|dropped (it|that|the message) in)\b/i,
  files: /\b(i('ve| have)? (saved|written|wrote|created|edited|updated|changed|moved|renamed|copied)\b.{0,40}\b(file|folder|line|script|code|config)|(file|folder|script)\b.{0,25}\b(is |has been )?(saved|created|updated|edited))\b/i,
  obligations: /\b(on (my|the) (list|to-?do)|added (it|that|this) to (my|the) list|it'?s on my list|i'?ve (set|added) (a |the )?reminder)\b/i,
  checkin_consent: /\b(saved (it )?(to|on) your card|on your card|got it saved|noted (it )?on your (card|profile))\b/i,
  music: /\b(it'?s playing|now playing|playing (it )?now|started playing|i'?ve stopped|stopped (the )?(song|music|it)|paused (it|the song|the music))\b/i,
  generate_image: /\b(here'?s (your|the) (picture|image|drawing)|(image|picture) is ready|i drew)\b/i,
  generate_self_image: /\b(here'?s (me|my (picture|image|selfie|portrait))|(selfie|portrait|picture|image) is ready)\b/i,
  generate_music: /\b(song('s| is) (done|ready|finished)|i (made|wrote) (you )?a (song|track))\b/i,
  look: /\b(here'?s (me|my (new )?(look|outfit|picture|selfie))|(new )?(look|outfit|picture|selfie) is (ready|saved)|changed my profile (picture|image)|(saved|updated) (it|that) (as|to) my profile)\b/i,
  switch_brain: /\b(switched (over )?to|i'?m now (on|running)|now running on)\b/i,
  git: /\b(i('ve| have)? (pushed|committed)|(pushed|committed) (it|them|the changes))\b/i,
  avatar_mode: /\bavatar mode (is )?(now )?(on|off)\b/i,
  inner_monologue: /\b(inner monologue|thinking out loud)\b.{0,20}\b(on|off)\b/i,
  solo_monologue: /\b(solo thoughts?|private thoughts?)\b.{0,30}\b(on|off|in #)\b|\bi'?ll think in #/i,
  voice_engine: /\b(switched|changed) (my|the) (voice|tts)\b|\bnow (speaking|talking) (with|on) (kokoro|fish)\b/i,
  voice_tone: /\b(switched|changed|switching|changing) (back )?to my (stronger|strong|powerful|normal|regular|usual) voice\b/i,
  rebuild_memories: /\b(started|kicked off) (the )?(memory )?rebuild\b/i,
};
let claimOverrides = null;

// Not a claim of her own: negated ("I haven't sent you", "didn't go through, nothing posted"), someone
// else did it ("Travis sent you"), or it's the doctor's work and the doctor's ok result is on record.
// Without this, honestly reporting an error got a canned "correction: that didn't go through" tacked on.
const NEGATED = /\b(not|never|cannot|can['’]?t|won['’]?t|(have|has|had|did|do|does|could|was|were|is|are)n['’]?t)\b[^.!?\n]{0,30}$/i;
const SELF = /(^|[.!?\n]\s*|\b(i|i['’]?ve|just|already|and|then|so|ok|okay|done|yep|yes|alright)[,\s]+)$/i;
function notHers(text, m, doctorOk) {
  const before = text.slice(0, m.index);
  const sentence = before.slice(before.search(/[^.!?\n]*$/));
  if (NEGATED.test(sentence)) return true;
  if (doctorOk && /\bdoctor\b/i.test(sentence + m[0])) return true;
  // A bare past-tense claim ("sent you", "posted it in") needs her as the subject.
  return /^(sent|posted|dropped|zipped|pushed|committed|switched|stopped|paused|started|saved|added|changed)\b/i.test(m[0]) && !SELF.test(before);
}

// The first action she claimed in `reply` whose tool didn't succeed this turn (succeeded: Map of
// tool -> true), or null. doctorOk: a successful doctor visit is on record in this conversation.
export function phantomClaim(reply, succeeded, { doctorOk = false } = {}) {
  if (claimOverrides === null) {
    try {
      claimOverrides = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(DATA_DIR, 'phantom-claims.json'), 'utf8'))).map(([k, v]) => [k, new RegExp(v, 'i')]));
    } catch {
      claimOverrides = {};
    }
  }
  const text = String(reply);
  for (const [tool, re] of Object.entries({ ...CLAIMS, ...claimOverrides })) {
    if (succeeded.get(tool) || (tool === 'voice_engine' && succeeded.get('voice_tone'))) continue; // "switched my voice" also fits a tone switch
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(all)) {
      if (!notHers(text, m, doctorOk)) return { tool, claim: m[0].trim() };
    }
  }
  return null;
}
