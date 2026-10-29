import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { agentStep } from './llm.js';
import { activity } from './events.js';

// Background helpers: Amy hands a task (write a script, research something, build a project) to a
// helper that works through it on its own with file access and web search, while she keeps talking.
// When it finishes it reports back where the task was started, and its report is kept in data/tasks.

const MAX_STEPS = 40;
const MAX_RESULT_CHARS = 20_000;
const SUMMARY_CHARS = 1500; // a finished report in the task list; the whole one is read with taskReport
const REPORT_PAGE_CHARS = 16_000; // one page of taskReport
const tasks = new Map(); // id -> task
let nextId = Date.now();

const PROGRESS_EVERY_MS = 60_000; // at most one progress line a minute, so updates don't flood
const PROGRESS_ERROR_MS = 30_000; // a failure is worth hearing about sooner

// One plain line about what a helper just did, for progress(): no model call, just its tool step.
function describeStep(name, rawArgs, out) {
  let a = {};
  try { a = JSON.parse(rawArgs || '{}'); } catch {}
  const short = (s, n = 70) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const what =
    name === 'web_search' ? `searching for "${short(a.query)}"`
    : name === 'files' ? `${a.action === 'download' ? 'downloading' : a.action === 'read' ? 'reading' : a.action === 'list' ? 'looking through' : a.action === 'edit' || a.action === 'write' ? 'editing' : 'working on'} ${short(a.path || a.url, 60) || 'files'}`
    : name === 'read_source' ? 'reading my own code'
    : name === 'news_feeds' ? 'pulling the news feeds'
    : `using ${name.replace(/_/g, ' ')}`;
  const failed = /^Error\b|failed|isn't available|not found/i.test(out.slice(0, 200));
  return { failed, text: failed ? `hit a snag ${what}: ${short(out.replace(/^Error:?\s*/i, ''), 120)}. Trying another way.` : `${what}.` };
}

// run(name, args) runs one of her tools; tools are their definitions; notify(text) reports back;
// progress(text) gets a short line now and then while it works, so nobody waits in silence.
export function startTask({ title, instructions, model, tools, run, notify, progress, execute, conversation }) {
  const id = nextId++;
  const task = { id, title: String(title || 'Task').slice(0, 80), status: 'running', model: execute ? 'generation-worker' : model || config.openrouter.model, conversation, steps: 0, actions: [], started: Date.now(), result: '', cancel: false };
  task.brief = String(instructions ?? '').trim();
  tasks.set(id, task);
  activity('task', { id, title: task.title, status: 'started', model: task.model });

  (async () => {
    // A generation sub-agent already has its exact tool and arguments. Execute that brief
    // directly, without asking another language model to reinterpret or expand the request.
    if (execute) {
      await new Promise(resolve => setImmediate(resolve));
      task.result = String(await execute(task));
      task.status = task.cancel ? 'cancelled' : 'done';
      return;
    }
    const messages = [
      {
        role: 'system',
        content:
          `You are a background helper for ${config.botName}, working on a task for her owner. Work through it on your own with your tools, step by step: ` +
          `look before you change things, make precise edits rather than rewriting whole files, and check your work by reading it back. ` +
          `Paths can start with Desktop, Documents, Downloads, Pictures, Music or Videos. You can't delete files or run commands; if the task needs that, say so in your report. ` +
          `You can download files from https addresses with files action download (for a model, look up the exact file addresses first, e.g. https://huggingface.co/api/models/<owner>/<name> lists a repo's files, and its files are at https://huggingface.co/<owner>/<name>/resolve/main/<file>). ` +
          `Only call a download done if the tool said "Downloaded"; give its path and size in your report. ` +
          `If you have system_info, use it to check the computer's hardware, free disk space and running programs instead of guessing. ` +
          `For research, don't write a report file or send one into chat unless the brief explicitly asks for a file; just put the findings in your final reply, and ${config.botName} will talk them through. ` +
          `When you're done, reply with a short report: what you did or found, where things are, and anything left for the owner to do.`,
      },
      { role: 'user', content: String(instructions) },
    ];
    for (; task.steps < MAX_STEPS && !task.cancel; task.steps++) {
      const step = await agentStep(messages, tools, task.model);
      if (!step.tool_calls.length) {
        task.result = step.content.trim() || '(The helper finished without a report.)';
        break;
      }
      messages.push({ role: 'assistant', content: step.content, tool_calls: step.tool_calls });
      for (const call of step.tool_calls) {
        if (task.cancel) break;
        const out = String(await run(call.function.name, call.function.arguments));
        task.actions.push(`${call.function.name} ${String(call.function.arguments).slice(0, 160)}`);
        if (progress && !task.cancel) {
          const step = describeStep(call.function.name, call.function.arguments, out);
          const since = Date.now() - (task.lastProgress ?? 0);
          if (since >= (step.failed ? PROGRESS_ERROR_MS : PROGRESS_EVERY_MS)) {
            task.lastProgress = Date.now();
            try { await progress(`"${task.title}": ${step.text}`, task); } catch (err) { activity('error', { where: 'task progress', id, message: err.message }); }
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n[TRUNCATED: showed ${MAX_RESULT_CHARS} of ${out.length} characters. Ask for less at once, e.g. read a file in parts with start_line and end_line.]` : out });
      }
    }
    if (task.cancel) task.status = 'cancelled';
    else if (!task.result) {
      task.status = 'stopped';
      task.result = `Stopped after ${MAX_STEPS} steps without finishing. Last actions: ${task.actions.slice(-5).join('; ')}`;
    } else task.status = 'done';
  })()
    .catch((err) => {
      task.status = task.cancel ? 'cancelled' : 'failed';
      task.result = err.message;
    })
    .finally(async () => {
      task.finished = Date.now();
      try { task.file = save(task); } catch (err) { activity('error', { where: 'task report', message: err.message }); }
      activity('task', { id, title: task.title, status: task.status, steps: task.steps });
      if (task.status !== 'cancelled') {
        try { await notify?.(`Background task #${id} "${task.title}" ${task.status}:\n${task.result}`, task); }
        catch (err) { activity('error', { where: 'task notification', id, message: err.message }); }
      }
    });
  return task;
}

function save(task) {
  const dir = path.join(DATA_DIR, 'tasks');
  mkdirSync(dir, { recursive: true });
  const when = new Date(task.started).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(dir, `${when}-task-${task.id}.md`);
  writeFileSync(
    file,
    `# Task ${task.id}: ${task.title}\n\nStatus: ${task.status}, ${task.steps} steps, model ${task.model}\n\n## Report\n\n${task.result}\n\n## Actions\n\n${task.actions.map((a) => `- ${a}`).join('\n')}\n`,
  );
  return file;
}

// The whole report of one task, a page at a time, so long findings aren't lost to the list's summary.
// After a restart the task is gone from memory, so its saved report is read instead.
export function taskReport(id, start = 0) {
  let t = tasks.get(Number(id));
  if (!t) {
    const dir = path.join(DATA_DIR, 'tasks');
    let name;
    try { name = readdirSync(dir).find((f) => f.endsWith(`-task-${Number(id)}.md`)); } catch {}
    if (!name) return null;
    const saved = readFileSync(path.join(dir, name), 'utf8');
    t = { id: Number(id), title: saved.match(/^# Task \d+: (.*)$/m)?.[1] ?? 'Task', status: 'finished', file: path.join(dir, name), result: saved };
  }
  if (t.status === 'running') return `Task #${t.id} "${t.title}" is still running (${t.steps} steps so far, last: ${t.actions.at(-1) ?? 'none yet'}).`;
  const from = Math.max(0, Math.floor(Number(start) || 0));
  const page = t.result.slice(from, from + REPORT_PAGE_CHARS);
  const end = from + page.length;
  const head = `Task #${t.id} "${t.title}" ${t.status}${t.file ? ` (saved at ${t.file})` : ''}.`;
  if (end < t.result.length) return `${head}\nReport TRUNCATED: showing characters ${from}-${end} of ${t.result.length}. Read the rest with status, id ${t.id} and start ${end}.\n${page}`;
  return `${head}\n${from ? `Report from character ${from}:\n` : ''}${page}`;
}

// Tasks from before the last restart, from their saved reports, so a finished job isn't "gone"
// just because she restarted. Newest first; the whole report is read with status and its id.
const SAVED_LISTED = 8;
function savedTasks() {
  const dir = path.join(DATA_DIR, 'tasks');
  let names = [];
  try { names = readdirSync(dir).filter((f) => /-task-\d+\.md$/.test(f)).sort().reverse(); } catch {}
  const out = [];
  for (const name of names) {
    if (out.length >= SAVED_LISTED) break;
    const id = Number(name.match(/-task-(\d+)\.md$/)[1]);
    if (tasks.has(id)) continue;
    let saved;
    try { saved = readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const report = saved.match(/## Report\n\n([\s\S]*?)\n\n## Actions/)?.[1] ?? '';
    out.push({
      id,
      title: saved.match(/^# Task \d+: (.*)$/m)?.[1] ?? 'Task',
      status: saved.match(/^Status: (\w+)/m)?.[1] ?? 'finished',
      beforeRestart: true,
      file: path.join(dir, name),
      result: report.length > SUMMARY_CHARS ? `${report.slice(0, SUMMARY_CHARS)}\n(Only the first ${SUMMARY_CHARS} of ${report.length} characters. Call status with id ${id} for the whole report.)` : report,
    });
  }
  return out;
}

export function listTasks() {
  return [...[...tasks.values()].map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    conversation: t.conversation,
    steps: t.steps,
    minutes: Math.round(((t.finished ?? Date.now()) - t.started) / 60000),
    lastAction: t.actions.at(-1) ?? null,
    result: t.status === 'running' ? null
      : t.result.length > SUMMARY_CHARS ? `${t.result.slice(0, SUMMARY_CHARS)}\n(Only the first ${SUMMARY_CHARS} of ${t.result.length} characters. Call status with id ${t.id} for the whole report.)`
      : t.result,
  })), ...savedTasks()];
}

// Language-model helpers still working (generation jobs have their own queue and limit).
export function runningHelpers() {
  return [...tasks.values()].filter((t) => t.status === 'running' && t.model !== 'generation-worker');
}

export function cancelTask(id) {
  const t = tasks.get(Number(id));
  if (!t || t.status !== 'running') return false;
  t.cancel = true;
  return true;
}
