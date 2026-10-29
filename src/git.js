import { execFile } from 'node:child_process';
import path from 'node:path';
import { resolve, show } from './files.js';

// Git and GitHub for the owner's projects, without a shell: git and gh are run directly with a
// fixed set of subcommands and arguments built here, never text passed through from the model.
// Push is two-step: preparePush() shows what would go up, and push() runs only after the owner
// confirms (see tools.js). GitHub sign-in is the owner's own `gh auth login`: git borrows it as a
// credential helper for these processes only, so no token sits in .env or the global git config.

const GH_AUTH = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '!gh auth git-credential',
};

const exec = (cmd, cwd, args, timeout) =>
  new Promise((ok, fail) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...GH_AUTH, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).trim().split('\n').slice(0, 6).join('\n')));
      else ok(stdout.trimEnd());
    });
  });
const run = (cwd, args, timeout = 30_000) => exec('git', cwd, args, timeout);
const gh = (args, cwd = resolve('Desktop'), timeout = 60_000) =>
  exec('gh', cwd, args, timeout).catch((e) => {
    throw new Error(/not logged|auth login|ENOENT/i.test(e.message) ? `GitHub isn't connected (${e.message}). Your owner needs to run "gh auth login" on this PC.` : e.message);
  });

// The repository a path belongs to (any folder or file inside it).
export async function repoOf(p) {
  const dir = resolve(p);
  const top = await run(dir, ['rev-parse', '--show-toplevel']).catch(() => run(path.dirname(dir), ['rev-parse', '--show-toplevel'])).catch(() => {
    throw new Error(`${show(dir)} isn't inside a git repository`);
  });
  return resolve(path.normalize(top)); // the repo itself must be an allowed place too
}

// A path given relative to the repo (or as a full/Desktop path inside it), checked to stay inside.
function inRepo(repo, p) {
  const raw = String(p ?? '').trim();
  if (!raw || raw.startsWith('-')) throw new Error(`"${raw}" isn't a file path`);
  let full;
  try {
    full = resolve(raw);
    if (!full.startsWith(repo)) full = path.resolve(repo, raw);
  } catch {
    full = path.resolve(repo, raw);
  }
  const rel = path.relative(repo, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${raw} is outside the repository`);
  resolve(full); // same blocklist as the files tool
  return rel || '.';
}

export async function status(repo) {
  const branch = await run(repo, ['status', '--short', '--branch']);
  return `${show(repo)}:\n${branch || '(clean)'}`;
}

export async function diff(repo, { file, staged } = {}) {
  const args = ['diff', '--stat', '--patch', '--no-color', ...(staged ? ['--cached'] : [])];
  if (file) args.push('--', inRepo(repo, file));
  const out = await run(repo, args);
  if (!out) return staged ? 'Nothing staged.' : 'No unstaged changes.';
  return out.length > 30_000 ? `${out.slice(0, 30_000)}\n(diff cut at 30,000 characters; diff one file at a time for the rest)` : out;
}

export async function add(repo, files) {
  const list = Array.isArray(files) ? files : [files];
  const args = list.length === 1 && /^(all|\.|-A|everything)$/i.test(String(list[0]).trim()) ? ['add', '--all'] : ['add', '--', ...list.map((f) => inRepo(repo, f))];
  await run(repo, args);
  return `Staged. Now:\n${await run(repo, ['status', '--short'])}`;
}

export async function commit(repo, message) {
  const msg = String(message ?? '').trim();
  if (!msg) throw new Error('A commit needs a message');
  const staged = await run(repo, ['diff', '--cached', '--name-only']);
  if (!staged) throw new Error('Nothing is staged; add files first');
  await run(repo, ['commit', '-m', msg]);
  return `Committed: ${await run(repo, ['log', '-1', '--format=%h %s'])}`;
}

// What a push would send, without sending it.
export async function preparePush(repo) {
  const branch = await run(repo, ['branch', '--show-current']);
  if (!branch) throw new Error('Not on a branch (detached HEAD), so there is nothing to push');
  const upstream = await run(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
  const remote = upstream ? upstream.split('/')[0] : 'origin';
  const url = await run(repo, ['remote', 'get-url', remote]).catch(() => null);
  if (!url) throw new Error(`There's no "${remote}" remote to push to`);
  const commits = upstream ? await run(repo, ['log', '--format=%h %s', `${upstream}..HEAD`]) : await run(repo, ['log', '--format=%h %s', '-10']);
  if (upstream && !commits) throw new Error(`Nothing to push: ${branch} is up to date with ${upstream}`);
  return { repo, branch, remote, url, upstream, commits };
}

export async function push(plan) {
  const args = plan.upstream ? ['push', plan.remote, plan.branch] : ['push', '--set-upstream', plan.remote, plan.branch];
  await run(plan.repo, args, 120_000);
  return `Pushed ${plan.branch} to ${plan.remote} (${plan.url}).`;
}

// Brings in the remote's new commits; fast-forward only, so it never makes a merge or loses work.
export async function pull(repo) {
  const out = await run(repo, ['pull', '--ff-only'], 120_000);
  return `${show(repo)}: ${out || 'Already up to date.'}`;
}

// "owner/name", "name" (the owner's own account) or a github.com URL.
function repoName(r) {
  const m = String(r ?? '').trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/)?([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m || m[2].startsWith('-') || m[1]?.startsWith('-')) throw new Error(`"${r}" isn't a GitHub repository name (use "name" or "owner/name")`);
  return (m[1] ?? '') + m[2];
}

// Clones into Desktop/<name> (or the folder given), which must not exist yet.
export async function clone(name, dest) {
  const full = repoName(name);
  const dir = resolve(dest || path.join('Desktop', full.split('/').pop()));
  await gh(['repo', 'clone', full, dir], resolve('Desktop'), 300_000);
  return `Cloned ${full} into ${show(dir)}.`;
}

export async function repos() {
  const out = await gh(['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,visibility,description', '--jq', '.[] | "\\(.nameWithOwner) [\\(.visibility | ascii_downcase)] \\(.description // "")"']);
  return out || 'No repositories.';
}

// A new GitHub repository (private unless asked), optionally linked to a local repo as origin.
export async function createRepo(name, { description, isPublic, folder } = {}) {
  const args = ['repo', 'create', repoName(name), isPublic ? '--public' : '--private'];
  if (description) args.push('--description', String(description));
  if (!folder) return gh(args);
  const dir = await repoOf(folder);
  args.push('--source', dir, '--remote', 'origin');
  return `${await gh(args, dir)}\nLinked ${show(dir)} to it as origin (nothing pushed yet).`;
}

export async function prs(repo) {
  return (await gh(['pr', 'list', '--state', 'all', '--limit', '20'], repo)) || 'No pull requests.';
}

// From the current branch, which must already be pushed.
export async function createPr(repo, { title, body }) {
  if (!String(title ?? '').trim()) throw new Error('A pull request needs a title');
  return gh(['pr', 'create', '--title', String(title), '--body', String(body ?? '')], repo);
}

export async function issues(repo) {
  return (await gh(['issue', 'list', '--limit', '30'], repo)) || 'No open issues.';
}

export async function createIssue(repo, { title, body }) {
  if (!String(title ?? '').trim()) throw new Error('An issue needs a title');
  return gh(['issue', 'create', '--title', String(title), '--body', String(body ?? '')], repo);
}
