import { spawn, execFile } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { ROOT, config } from './config.js';
import { activity } from './events.js';

// The doctor: Claude Code, run headless on her own project with the owner's own Claude login, to
// fix or adjust her code when the owner asks (never on her own, never for anyone else, and never
// as a way to chat). Every visit is bracketed by git commits so it can be undone, and tests run
// after. She never restarts herself to apply a fix: the owner decides when.
const run = promisify(execFile);
const git = (...args) => run('git', ['-c', 'user.name=Amy', '-c', 'user.email=amy@localhost', ...args], { cwd: ROOT, maxBuffer: 8 << 20 });
const TIMEOUT_MS = 20 * 60000;
let visit = null; // { task, started, child }
let last = null; // the most recent finished visit, for the message after a restart
export const lastVisit = () => last;
// While this exists, watchdog.bat doesn't restart her for the doctor's edits (see watchdog.bat).
const LOCK = path.join(ROOT, 'data', 'doctor.lock');

function findClaude() {
  const candidates = [
    process.env.CLAUDE_PATH,
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'claude.cmd'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? 'claude'; // else hope it's on PATH
}

const RULES = `You are the doctor for ${config.botName}, a Discord companion bot whose code is in this folder. Her owner asked for the fix or change below; she is relaying it. Rules:
- Only change code and docs in this project. Never read, print or edit .env, anything under data/ (her database, memories, logs are data you may read but not change) or models/.
- Read the relevant code and her recent errors (data/activity.jsonl, data/tool-failures.jsonl, data/bot.err.log) before changing anything. Make the smallest change that fixes it, matching the surrounding style.
- Run \`npm test\` after changing code. Don't commit, push, restart the bot, or install packages; the owner decides those.
- Finish with a short plain-language report for the owner: what was wrong, what you changed (files), and whether tests pass. Two to five sentences, no code blocks: she may read it out loud.`;

export function doctorStatus() {
  if (!visit) return 'The doctor is not working on anything right now.';
  return `The doctor has been working on "${visit.task}" for ${Math.round((Date.now() - visit.started) / 60000)} minute(s).`;
}

// A finished visit as a verified tool result for her history ("doctor <title>: ok, tests pass"), so
// later turns see what really happened instead of an unbacked claim she might take back.
export const visitResult = (v) => `doctor ${v.title}: ${v.ok ? 'ok' : 'failed'}, ${v.changed ? `tests ${v.tests}` : 'no files changed'}`;

// Starts a visit in the background and returns at once; notify(text) gets the report when it ends.
export async function callDoctor(task, notify) {
  task = String(task ?? '').trim();
  if (!task) return 'Error: tell the doctor what to fix or change.';
  if (visit) return `Error: ${doctorStatus()} Wait for it to finish, or cancel it.`;
  // Snapshot first, so this visit (and only this visit) can be undone.
  await git('add', '-A');
  await git('commit', '-q', '--allow-empty', '-m', `Before doctor: ${task.slice(0, 60)}`);
  const title = task.length > 60 ? `${task.slice(0, 57)}...` : task;
  visit = { task: title, started: Date.now() };
  try { writeFileSync(LOCK, String(Date.now())); } catch {}
  activity('doctor', { status: 'started', task });

  const args = ['-p', `${task}\n\n(Recent context is in her logs; read them first.)`, '--output-format', 'json',
    '--append-system-prompt', RULES, '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(npm test*),Bash(node --check *),Bash(git diff*),Bash(git status*),Bash(git log*)',
    '--disallowedTools', 'Edit(.env*),Write(.env*),Read(.env*),Edit(data/**),Write(data/**),Edit(models/**),Write(models/**)'];
  const bin = findClaude();
  const child = spawn(bin, args, { cwd: ROOT, shell: bin.endsWith('.cmd'), windowsHide: true });
  visit.child = child;
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

  child.on('error', (e) => finish(null, e.code === 'ENOENT'
    ? "Claude Code isn't installed where I can find it. Install it, sign in once by running `claude` in a terminal, or set CLAUDE_PATH in .env."
    : e.message));
  child.on('close', (code) => finish(code, null));

  let done = false;
  async function finish(code, failure) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    let report = failure, isError = false;
    if (!report) {
      // Claude Code exits 0 even when the run fails; the JSON says so in is_error.
      try { const result = JSON.parse(out); report = result.result; isError = Boolean(result.is_error); } catch { report = (out || err).trim().slice(-1500); }
      if (code !== 0) report = `The doctor stopped early (exit ${code}). ${report || err.slice(-500)}`;
      // Claude Code keeps its own login, separate from the Claude desktop app's. Only a failed run is
      // a login problem; a finished report may just mention logging in.
      if ((isError || code !== 0) && /not logged in|\/login/i.test(report)) report = "Claude Code isn't signed in on this computer. Its login is separate from the Claude desktop app: open a terminal, run `claude auth login`, sign in with your Claude account, then ask me again.";
    }
    let summary = '', tests = 'not run';
    try {
      summary = (await git('diff', '--stat', 'HEAD')).stdout.trim();
      if (summary) {
        tests = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: ROOT, shell: process.platform === 'win32', timeout: 300000, maxBuffer: 8 << 20 })
          .then(() => 'pass', () => 'FAIL');
        await git('add', '-A');
        await git('commit', '-q', '-m', `Doctor: ${title}`);
      }
    } catch (e) { report += ` (Saving the change failed: ${e.message})`; }
    visit = null;
    rmSync(LOCK, { force: true });
    const ok2 = !failure && code === 0 && !isError;
    activity('doctor', { status: ok2 ? 'done' : 'failed', task: title, changed: Boolean(summary), tests, report: String(report).slice(0, 500) });
    last = { at: Date.now(), title, ok: ok2, report: String(report || '').slice(0, 800), changed: summary.split('\n').slice(0, -1).map((l) => l.split('|')[0].trim()).join(', '), tests };
    const text = `Doctor visit "${title}" ${ok2 ? 'done' : 'failed'}:\n${report || 'No report.'}\n` +
      (summary ? `Changed:\n${summary}\nTests: ${tests}.${tests === 'FAIL' ? ' Say "undo the doctor" to roll it back.' : ''} Restart me when you want the fix to take effect.` : 'No files were changed.');
    try { await notify?.(text); } catch {}
  }
  return `The doctor is on it: "${title}". This can take a few minutes; I'll report back when it's done. Tell your owner briefly.`;
}

export function cancelDoctor() {
  if (!visit?.child) return 'The doctor is not working on anything.';
  visit.child.kill();
  return 'Told the doctor to stop. Anything it already changed is kept until you undo it.';
}

// Rolls back the most recent doctor visit (its commit and anything uncommitted after it).
export async function undoDoctor() {
  if (visit) return `Error: ${doctorStatus()} Cancel it first.`;
  const log = (await git('log', '--format=%H %s', '-n', '50')).stdout.trim().split('\n');
  const before = log.find((l) => l.split(' ').slice(1).join(' ').startsWith('Before doctor:'));
  if (!before) return 'There is no doctor visit to undo.';
  const [hash, ...subject] = before.split(' ');
  await git('reset', '--hard', hash);
  activity('doctor', { status: 'undone', task: subject.join(' ') });
  return `Rolled back the doctor's last visit (${subject.join(' ').replace('Before doctor: ', '')}). Restart me to load the old code.`;
}
