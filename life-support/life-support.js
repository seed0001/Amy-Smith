import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Life support: a small process of its own that keeps her running and gets word out when she can't.
// start.bat runs this instead of `node src/index.js`. It starts her, brings her back when she exits
// (her own restarts exit 0), and when she keeps failing to start it stops retrying, DMs the owner(s)
// the error over Discord's plain HTTP API, and takes commands back by DM: retry, doctor <task>, undo,
// cancel, status. It imports nothing from src/ or node_modules (Node built-ins only) and reads .env
// itself, so whatever broke her can't break it too. It only reads DMs while she is down; while she's
// up, her DMs are hers.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const ACTIVITY = path.join(DATA, 'activity.jsonl');
const LOCK = path.join(DATA, 'doctor.lock'); // the same lock as src/doctor.js; watchdog.bat honours it

export const LIMITS = {
  startupMs: 60_000, // she counts as started once she has stayed up this long
  startupFailures: 3, // this many failed starts in a row puts her on life support...
  crashWindowMs: 10 * 60_000, crashesInWindow: 5, // ...or this many crashes of any kind in the window
  backoffMs: [5_000, 15_000], // wait before the 1st, 2nd... automatic retry
  restartMs: 2_000, // after she exits on purpose
  pollMs: 10_000, // how often to check the owner's DMs while she's down
  doctorMs: 20 * 60_000,
};

const COMMANDS = [
  '`retry` - try starting her again',
  '`doctor <what to fix>` - send the doctor (Claude Code) to diagnose and fix it; on its own it looks into why she won\'t start. If it changes code and the tests pass, I start her again',
  '`undo` - roll back the last doctor visit',
  '`cancel` - stop the doctor',
  '`status` - what\'s going on',
].map((c) => `- ${c}`).join('\n');

// ---- Pure helpers ----

export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

// Values of secret-looking .env keys, to scrub from anything sent to Discord.
export const secretsOf = (env) => Object.entries(env)
  .filter(([k, v]) => /TOKEN|KEY|SECRET|PASS|AUTH|COOKIE/i.test(k) && v)
  .map(([, v]) => String(v));

export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets) if (v.length >= 8) s = s.split(v).join('[redacted]');
  return s
    .replace(/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/g, '[redacted]') // Discord token shape
    .replace(/\b(?:sk|gsk|tvly|pk|xai)[-_][\w-]{16,}/g, '[redacted]');
}

const ALIASES = {
  retry: 'retry', start: 'retry', boot: 'retry', restart: 'retry',
  doctor: 'doctor', fix: 'doctor',
  undo: 'undo', rollback: 'undo',
  cancel: 'cancel', stop: 'cancel',
  status: 'status', help: 'help',
};
export function parseCommand(text) {
  const m = String(text ?? '').trim().match(/^\/?([a-z]+)\b[\s:,-]*([\s\S]*)$/i);
  return { cmd: (m && ALIASES[m[1].toLowerCase()]) || 'help', arg: m ? m[2].trim() : '' };
}

// What to do after she exits. state: { crashes: [times], failedStarts }.
export function afterExit(state, { code, ranMs, now = Date.now() }, limits = LIMITS) {
  if (code === 0) return { crashes: state.crashes, failedStarts: 0, action: 'restart', delayMs: limits.restartMs };
  const crashes = [...state.crashes.filter((t) => now - t < limits.crashWindowMs), now];
  const failedStarts = ranMs < limits.startupMs ? state.failedStarts + 1 : 0;
  if (failedStarts >= limits.startupFailures) return { crashes, failedStarts, action: 'life-support', reason: 'startup' };
  if (crashes.length >= limits.crashesInWindow) return { crashes, failedStarts, action: 'life-support', reason: 'repeated' };
  const delayMs = limits.backoffMs[Math.min(Math.max(failedStarts - 1, 0), limits.backoffMs.length - 1)];
  return { crashes, failedStarts, action: 'restart', delayMs };
}

export function chunks(text, size = 1900) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

const secs = (ms) => `${Math.round(ms / 1000)}s`;
const fence = (s) => `\`\`\`\n${String(s).replace(/```/g, "'''").trim() || '(nothing)'}\n\`\`\``;

// ---- Logging: to the console and her activity feed (the dashboard and she see it after she's up) ----

export function logEvent(event, details = {}) {
  console.log(`[life support] ${event}${details.message ? `: ${details.message}` : ''}`);
  try { appendFileSync(ACTIVITY, JSON.stringify({ type: 'life-support', time: Date.now(), event, ...details }) + '\n'); } catch {}
}

// Errors she logged herself while starting (e.g. "Ollama check failed"), newest last.
function loggedErrors(since) {
  try {
    return readFileSync(ACTIVITY, 'utf8').split('\n').slice(-300).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.type === 'error' && e.time >= since)
      .slice(-3).map((e) => `${e.where}: ${String(e.message).slice(0, 300)}`);
  } catch { return []; }
}

// ---- Discord over plain HTTPS (no discord.js) ----

export function discordClient(token, { fetchImpl = fetch } = {}) {
  async function call(method, route, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchImpl(`https://discord.com/api/v10${route}`, {
        method,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (life-support, 1.0)' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) {
        const wait = Number((await res.json().catch(() => ({}))).retry_after) || 2;
        await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Discord ${method} ${route.split('?')[0]} failed (${res.status})`);
      return res.status === 204 ? null : res.json();
    }
    throw new Error('Discord kept rate limiting');
  }
  return {
    openDm: async (userId) => (await call('POST', '/users/@me/channels', { recipient_id: userId })).id,
    send: (channelId, content) => call('POST', `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } }),
    messagesAfter: (channelId, afterId) => call('GET', `/channels/${channelId}/messages?limit=20&after=${afterId}`),
  };
}

// DMs with the owner(s). Only messages written by an owner, in their own DM, after life support's
// latest alert are read as commands.
export function ownerLine({ discord, ownerIds, log = logEvent }) {
  const dms = new Map(); // ownerId -> { channel, last }
  const dm = async (id) => {
    if (!dms.has(id)) dms.set(id, { channel: await discord.openDm(id), last: null });
    return dms.get(id);
  };
  return {
    // reset: start reading commands from this message on (a new alert), ignoring anything before it.
    async notify(text, { reset = false } = {}) {
      for (const id of ownerIds) {
        try {
          const d = await dm(id);
          let first = true;
          for (const part of chunks(text)) {
            const sent = await discord.send(d.channel, part);
            if ((reset && first) || !d.last) d.last = sent.id;
            first = false;
          }
        } catch (err) { log('error', { message: `Couldn't DM owner ${id}: ${err.message}` }); }
      }
    },
    async poll() {
      const out = [];
      for (const id of ownerIds) {
        const d = dms.get(id);
        if (!d?.last) continue;
        try {
          const msgs = (await discord.messagesAfter(d.channel, d.last)) ?? [];
          msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          for (const m of msgs) {
            if (BigInt(m.id) > BigInt(d.last)) d.last = m.id;
            if (m.author?.id === id && !m.author.bot && m.content) out.push({ ownerId: id, text: m.content });
          }
        } catch (err) { log('error', { message: `Couldn't read owner ${id}'s DMs: ${err.message}` }); }
      }
      return out;
    },
  };
}

// ---- The doctor, run from here while she's down ----
// Same rules, tool limits, git snapshots and lock as src/doctor.js, copied rather than imported so a
// broken src/ can't stop it. The prompt goes in on stdin, so nothing from the crash output or the
// owner's message ever passes through a shell.

const run = promisify(execFile);
const git = (...args) => run('git', ['-c', 'user.name=Amy', '-c', 'user.email=amy@localhost', ...args], { cwd: ROOT, maxBuffer: 8 << 20 });
const ALLOWED = 'Read,Edit,Write,Glob,Grep,Bash(npm test*),Bash(node --check *),Bash(git diff*),Bash(git status*),Bash(git log*)';
const DISALLOWED = 'Edit(.env*),Write(.env*),Read(.env*),Edit(data/**),Write(data/**),Edit(models/**),Write(models/**)';

function findClaude(env = process.env) {
  const candidates = [
    env.CLAUDE_PATH,
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'claude.cmd'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? 'claude';
}

const rules = (botName) => `You are the doctor for ${botName}, a Discord companion bot whose code is in this folder. She FAILED TO START and is on life support (life-support/life-support.js), so her owner is talking to you through it by Discord DM. Rules:
- Only change code and docs in this project. Never read, print or edit .env, anything under data/ (her database, memories, logs are data you may read but not change) or models/.
- Read the startup failure below and her recent errors (data/activity.jsonl, data/tool-failures.jsonl, data/bot.err.log) before changing anything. Don't assume a cause the evidence doesn't show. Make the smallest change that fixes it, matching the surrounding style.
- Run \`npm test\` after changing code. Don't commit, push, start the bot, or install packages; the owner decides those. If the fix needs something outside the code (a package install, a .env value, a service that isn't running), don't work around it: say exactly what the owner must do.
- Finish with a short plain-language report for the owner: what was wrong, what you changed (files), and whether tests pass. Two to five sentences, no code blocks.`;

export function runDoctor({ task, evidence, botName, env = process.env }) {
  let child = null;
  const title = task.length > 60 ? `${task.slice(0, 57)}...` : task;
  const done = (async () => {
    if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < LIMITS.doctorMs + 60_000) throw new Error('Another doctor visit is already running.');
    await git('add', '-A');
    await git('commit', '-q', '--allow-empty', '-m', `Before doctor: ${task.slice(0, 60)}`);
    writeFileSync(LOCK, String(Date.now()));
    logEvent('doctor', { status: 'started', task: title });
    try {
      const prompt = `${rules(botName)}\n\nThe owner's request: ${task}\n\nHow she failed to start:\n${evidence}`;
      const { code, out, err } = await new Promise((resolve) => {
        const bin = findClaude(env);
        const shell = /\.(cmd|bat)$/i.test(bin);
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED, '--disallowedTools', DISALLOWED];
        // Only fixed arguments reach the shell (for an npm-installed claude.cmd); quote them for it.
        child = spawn(shell ? `"${bin}"` : bin, shell ? args.map((a) => `"${a}"`) : args, { cwd: ROOT, shell, windowsHide: true });
        let out = '', err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        const timer = setTimeout(() => child.kill(), LIMITS.doctorMs);
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.code === 'ENOENT' ? "Claude Code isn't installed where I can find it (set CLAUDE_PATH in .env)." : e.message }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
      });
      let report, isError = false;
      try { const result = JSON.parse(out); report = result.result; isError = Boolean(result.is_error); } catch { report = (out || err).trim().slice(-1500); }
      if (code !== 0) report = `The doctor stopped early (exit ${code}). ${report || err.slice(-500)}`;
      if ((isError || code !== 0) && /not logged in|\/login/i.test(report)) report = "Claude Code isn't signed in on this computer: open a terminal, run `claude auth login`, then send doctor again.";
      let summary = '', tests = 'not run';
      try {
        await git('add', '-A');
        summary = (await git('diff', '--cached', '--stat', 'HEAD')).stdout.trim();
        if (summary) {
          tests = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: ROOT, shell: process.platform === 'win32', timeout: 300_000, maxBuffer: 8 << 20 })
            .then(() => 'pass', () => 'FAIL');
          await git('add', '-A');
          await git('commit', '-q', '-m', `Doctor: ${title}`);
        }
      } catch (e) { report += ` (Saving the change failed: ${e.message})`; }
      const ok = code === 0 && !isError;
      const changed = summary.split('\n').slice(0, -1).map((l) => l.split('|')[0].trim()).join(', ');
      logEvent('doctor', { status: ok ? 'done' : 'failed', task: title, changed: Boolean(summary), tests, report: String(report).slice(0, 500) });
      return { title, ok, report: String(report || 'No report.'), changed, tests };
    } finally {
      rmSync(LOCK, { force: true });
    }
  })();
  return { title, done, cancel: () => child?.kill() };
}

// Rolls back the most recent doctor visit, the same way src/doctor.js does.
export async function undoDoctor() {
  const log = (await git('log', '--format=%H %s', '-n', '50')).stdout.trim().split('\n');
  const before = log.find((l) => l.split(' ').slice(1).join(' ').startsWith('Before doctor:'));
  if (!before) return 'There is no doctor visit to undo.';
  const [hash, ...subject] = before.split(' ');
  await git('reset', '--hard', hash);
  logEvent('doctor', { status: 'undone', task: subject.join(' ') });
  return `Rolled back the doctor's last visit (${subject.join(' ').replace('Before doctor: ', '')}). Send retry to start her on the old code.`;
}

// ---- The supervisor ----

export function createLifeSupport({
  command = [process.execPath, 'src/index.js'], cwd = ROOT, env = process.env,
  notify = async () => {}, poll = async () => [], doctor = runDoctor, undo = undoDoctor,
  log = logEvent, limits = LIMITS, botName = 'Champ', secrets = [],
} = {}) {
  let child = null, mode = 'running', stopped = false, visit = null, failure = null;
  let state = { crashes: [], failedStarts: 0 };
  let retryTimer = null, stableTimer = null, pollTimer = null, checking = false, recovering = false;
  const say = (text, opts) => Promise.resolve(notify(redact(text, secrets), opts)).catch((err) => log('error', { message: `Couldn't reach the owner: ${err.message}` }));

  function launch() {
    if (stopped) return;
    clearInterval(pollTimer);
    mode = 'running';
    const started = Date.now();
    let tail = '', ended = false;
    log('starting', { message: `starting ${botName}` });
    child = spawn(command[0], command.slice(1), { cwd, env: { ...env, CHAMP_SUPERVISED: '1' }, stdio: ['inherit', 'inherit', 'pipe'] });
    child.stderr.on('data', (d) => { process.stderr.write(d); tail = (tail + d).slice(-4000); });
    stableTimer = setTimeout(() => {
      if (!recovering) return;
      recovering = false;
      log('recovered', { message: `${botName} is up again` });
      say(`${botName} started and has stayed up for ${secs(limits.startupMs)}, so she's back. Life support is standing by again.`);
    }, limits.startupMs);
    const end = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(stableTimer);
      child = null;
      if (!stopped) onExit(code, Date.now() - started, tail, started);
    };
    child.on('error', (err) => { tail += `\n${err.message}`; end(-1); });
    child.on('exit', (code) => end(code ?? -1));
  }

  function onExit(code, ranMs, tail, started) {
    const next = afterExit(state, { code, ranMs }, limits);
    state = { crashes: next.crashes, failedStarts: next.failedStarts };
    if (code !== 0) {
      failure = { at: Date.now(), code, ranMs, tail: redact(tail, secrets), errors: loggedErrors(started), reason: next.reason, failedStarts: next.failedStarts, crashes: next.crashes.length };
      log('crash', { message: `${botName} exited with code ${code} after ${secs(ranMs)}`, code, ranMs });
    }
    if (next.action === 'restart') { retryTimer = setTimeout(launch, next.delayMs); return; }
    enterLifeSupport();
  }

  function failureText() {
    const f = failure;
    const what = f.reason === 'repeated'
      ? `${botName} crashed ${f.crashes} times in ${Math.round(limits.crashWindowMs / 60000)} minutes`
      : `${botName} failed to start ${f.failedStarts} time(s) in a row`;
    return `${what} (last: exit code ${f.code} after ${secs(f.ranMs)}).` +
      (f.errors.length ? `\nErrors she logged:\n${f.errors.map((e) => `- ${e}`).join('\n')}` : '') +
      `\nLast error output:\n${fence(f.tail.slice(-1200))}`;
  }

  async function enterLifeSupport() {
    mode = 'life-support';
    recovering = true;
    log('life-support', { message: `stopped retrying ${botName}; waiting for the owner`, reason: failure?.reason });
    await say(`**${botName} life support**\n${failureText()}\nI've stopped retrying so she doesn't crash-loop. Reply here:\n${COMMANDS}`, { reset: true });
    clearInterval(pollTimer);
    pollTimer = setInterval(checkInbox, limits.pollMs);
  }

  async function checkInbox() {
    if (checking || mode === 'running' || stopped) return;
    checking = true;
    try {
      for (const m of (await poll()) ?? []) {
        if (mode === 'running') break;
        await handle(m.text);
      }
    } catch (err) {
      log('error', { message: `Checking the owner's messages failed: ${err.message}` });
    } finally { checking = false; }
  }

  function retry() {
    // One more try: a single failed start puts her straight back on life support.
    state = { crashes: [], failedStarts: limits.startupFailures - 1 };
    launch();
  }

  async function handle(text) {
    const { cmd, arg } = parseCommand(text);
    log('command', { message: cmd });
    if (cmd === 'status') return say(statusText());
    if (cmd === 'retry') {
      if (visit) return say('The doctor is still working. Wait for its report, or send cancel first.');
      await say(`Starting ${botName} again...`);
      return retry();
    }
    if (cmd === 'cancel') {
      if (!visit) return say('The doctor is not working on anything.');
      visit.cancel();
      return say('Told the doctor to stop. Anything it already changed is kept until you undo it.');
    }
    if (cmd === 'undo') {
      if (visit) return say('The doctor is still working. Send cancel first.');
      return say(await undo().catch((err) => `Undo failed: ${err.message}`));
    }
    if (cmd === 'doctor') {
      if (visit) return say(`The doctor is already working on "${visit.title}".`);
      sendDoctor(arg); // runs in the background so status and cancel still work meanwhile
      return;
    }
    return say(`I'm ${botName}'s life support; she isn't running right now.\n${COMMANDS}`);
  }

  function statusText() {
    if (visit) return `${botName} is down and the doctor is working on "${visit.title}" (${Math.round((Date.now() - visit.started) / 60000)} min so far).`;
    if (mode === 'running') return `${botName} is starting.`;
    return `${botName} is down and waiting for you. ${failure ? failureText() : ''}`;
  }

  async function sendDoctor(task) {
    task = task || `Find out why ${botName} fails to start and fix it.`;
    const evidence = failure ? failureText() : 'No startup failure is on record.';
    let result;
    try {
      visit = { ...doctor({ task, evidence, botName, env }), started: Date.now() };
      await say(`The doctor is on it: "${visit.title}". This can take a few minutes; I'll report back here.`);
      result = await visit.done;
    } catch (err) {
      result = { title: visit?.title ?? task.slice(0, 60), ok: false, report: err.message, changed: '', tests: 'not run' };
    }
    visit = null;
    if (stopped) return;
    const fixed = result.ok && result.changed && result.tests === 'pass';
    await say(`Doctor visit "${result.title}" ${result.ok ? 'done' : 'failed'}:\n${result.report}\n` +
      (result.changed ? `Changed: ${result.changed}. Tests: ${result.tests}.` : 'No files were changed.') +
      (fixed ? `\nTests pass, so I'm starting ${botName} now. I'll tell you if she stays up.`
        : `\nNot starting her on my own. Send retry to try anyway${result.changed ? ', undo to roll it back' : ''}, or doctor <more detail> to try again.`));
    if (fixed && mode !== 'running') retry();
  }

  launch();
  return {
    status: () => ({ mode, doctor: Boolean(visit), failure }),
    stop() {
      stopped = true;
      clearTimeout(retryTimer); clearTimeout(stableTimer); clearInterval(pollTimer);
      visit?.cancel();
      child?.kill();
    },
  };
}

// ---- Entry point ----

function main() {
  const envFile = path.join(ROOT, '.env');
  const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
  const ownerIds = list(env.OWNER_IDS);
  const botName = env.BOT_NAME || 'Champ';
  let line = null;
  if (env.DISCORD_TOKEN && ownerIds.length) line = ownerLine({ discord: discordClient(env.DISCORD_TOKEN), ownerIds });
  else console.warn('[life support] No DISCORD_TOKEN or OWNER_IDS in .env: failures are only shown here and in data/activity.jsonl.');
  const ls = createLifeSupport({
    notify: (text, opts) => line?.notify(text, opts),
    poll: async () => (line ? line.poll() : []),
    botName, secrets: secretsOf(env),
  });
  // Life support must not die of its own bugs: log them and keep watching.
  process.on('uncaughtException', (err) => logEvent('error', { message: `life support: ${err.message}` }));
  process.on('unhandledRejection', (err) => logEvent('error', { message: `life support: ${err?.message ?? err}` }));
  process.on('exit', () => ls.stop());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { ls.stop(); process.exit(0); });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
