import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';
import { sessions, joinChannel } from './voice/session.js';
import { lastVisit, visitResult } from './doctor.js';

// Restarting on the owner's say-so (usually after a doctor visit). start.bat runs her in a loop, so
// exiting is a restart. Before exiting she writes down where she was, so she comes back to the same
// voice channel without the room greeting and says one short line about how she's doing.
const MARKER = path.join(DATA_DIR, 'restart.json');

export function canRestart() { return process.env.CHAMP_SUPERVISED === '1'; }

export async function requestRestart({ reason = '', guild, channel, by }) {
  if (!canRestart()) return "Error: I can't restart myself here: I wasn't started by start.bat, so nothing would bring me back. Restart me by hand.";
  const session = guild && sessions.get(guild.id);
  const visit = lastVisit();
  const marker = {
    at: Date.now(), by, reason: String(reason).slice(0, 300),
    guildId: guild?.id ?? null,
    voiceChannelId: session?.channelId ?? null,
    textChannelId: session?.textChannel?.id ?? channel?.id ?? null,
    doctor: visit && Date.now() - visit.at < 6 * 3600_000 ? visit : null,
  };
  writeFileSync(MARKER, JSON.stringify(marker, null, 2));
  activity('restart', { by, reason: marker.reason, doctor: Boolean(marker.doctor) });
  // Let her finish saying she's restarting (up to 15s), then go.
  const started = Date.now();
  const timer = setInterval(() => {
    const busy = [...sessions.values()].some((s) => s.speaking || s.speech?.length || s.pending);
    if (busy && Date.now() - started < 15000) return;
    clearInterval(timer);
    for (const s of sessions.values()) s.destroy();
    setTimeout(() => process.exit(0), 500);
  }, 500);
  setTimeout(() => {}, 1500); // the reply goes out before the first check
  return `Restarting in a moment${marker.voiceChannelId ? '; I will rejoin this voice channel' : ''}. Tell your owner briefly that you're restarting and will be right back.`;
}

// On startup: if she restarted on purpose a few minutes ago, go back to where she was.
export async function resumeAfterRestart(client) {
  if (!existsSync(MARKER)) return;
  let marker;
  try { marker = JSON.parse(readFileSync(MARKER, 'utf8')); } catch { marker = null; }
  rmSync(MARKER, { force: true });
  if (!marker || Date.now() - marker.at > 5 * 60000) return;
  const guild = marker.guildId && (await client.guilds.fetch(marker.guildId).catch(() => null));
  if (!guild) return;
  const text = marker.textChannelId && (await guild.channels.fetch(marker.textChannelId).catch(() => null));
  const voice = marker.voiceChannelId && (await guild.channels.fetch(marker.voiceChannelId).catch(() => null));
  const cue = backCue(marker);
  // Saved with her line, so the next turn knows the doctor's result is real and doesn't retract it.
  const evidence = marker.doctor ? visitResult(marker.doctor) : null;
  if (voice?.isVoiceBased() && voice.members.some((m) => !m.user.bot)) {
    const session = await joinChannel(voice, text ?? null, { greet: false }).catch((err) => {
      activity('error', { where: 'rejoin after restart', message: err.message });
      return null;
    });
    if (session) { setTimeout(() => session.announce(cue, evidence), 2500); return; }
  }
  if (text?.isTextBased?.()) {
    const { respond } = await import('./companion.js');
    const owner = { id: marker.by?.id ?? 'owner', name: marker.by?.name ?? 'owner' };
    const line = await respond({ conversation: `text:${text.id}`, speaker: owner, text: '', cue, evidence }).catch(() => null);
    if (line) text.send({ content: line.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
  }
}

function backCue({ doctor, reason }) {
  const what = doctor
    ? `You just came back from a restart after a doctor visit about "${doctor.title}". What the doctor reported: ${doctor.report}${doctor.changed ? ` Files changed: ${doctor.changed}.` : ' No files were changed.'} Tests: ${doctor.tests}.`
    : `You just came back from a restart your owner asked for${reason ? ` (${reason})` : ''}.`;
  return `(Stage direction, not something anyone said: ${what} Say one or two short, natural lines to the room that you're back and how you feel, in your own voice: e.g. that the fix seems to have taken, or that something still feels off if the tests failed. Don't greet everyone individually or list names. Don't read out file names.)`;
}
