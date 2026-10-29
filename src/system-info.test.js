import test from 'node:test';
import assert from 'node:assert/strict';
import { systemInfo } from './system-info.js';
import { enabledTools, runTool } from './tools.js';
import { config } from './config.js';

const GB = 1024 ** 3;
// A pretend computer: answers the fixed commands with canned output, and records what was run.
function fakeComputer({ nvidiaOut = '' } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'nvidia-smi') { if (!nvidiaOut) throw new Error('not found'); return nvidiaOut; }
    const script = args.at(-1);
    if (script.includes('Win32_VideoController')) return JSON.stringify({ gpu: [{ name: 'AMD Radeon RX 7900 XT', ram: 4 * GB - 1, driver: '32.0.1' }], vram: [{ name: 'AMD Radeon RX 7900 XT', bytes: 20 * GB }], os: { name: 'Microsoft Windows 11 Pro', version: '10.0.26200' } });
    if (script.includes('Win32_LogicalDisk')) return JSON.stringify([{ drive: 'C:', size: 1000 * GB, free: 250 * GB, fs: 'NTFS' }]);
    if (script.includes('GPU Adapter Memory')) return String(3 * GB);
    if (script.includes('Get-Process')) return JSON.stringify([
      { name: 'node', id: 10, mem: 300 * 1024 ** 2, cpu: 50 },
      { name: 'ollama', id: 11, mem: 6000 * 1024 ** 2, cpu: 5 },
      { name: 'python', id: 12, mem: 100 * 1024 ** 2, cpu: 900 },
    ]);
    return '';
  };
  return { run, calls, platform: 'win32', sampleMs: 200 }; // Windows CPU counters tick too coarsely for less
}

test('hardware reports CPU, RAM, the real VRAM past the 4 GB Windows cap, disks and OS', async () => {
  const out = await systemInfo({ action: 'hardware' }, fakeComputer());
  assert.match(out, /^CPU: .+logical cores/m);
  assert.match(out, /^RAM: \d+\.\d GB total/m);
  assert.match(out, /AMD Radeon RX 7900 XT, 20\.0 GB dedicated video memory/);
  assert.match(out, /Disk C: 250\.0 GB free of 1000\.0 GB \(NTFS\)/);
  assert.match(out, /OS: Microsoft Windows 11 Pro 10\.0\.26200/);
});

test('an NVIDIA card is read from nvidia-smi, with load and temperature in status', async () => {
  const pc = fakeComputer({ nvidiaOut: 'NVIDIA GeForce RTX 4090, 24564, 2048, 37, 55\n' });
  assert.match(await systemInfo({ action: 'hardware' }, pc), /RTX 4090, 24\.0 GB video memory/);
  const status = await systemInfo({ action: 'status' }, pc);
  assert.match(status, /RTX 4090: 37% busy, 2048 of 24564 MB video memory used, 55°C/);
  assert.match(status, /CPU load: \d+%/);
  assert.match(status, /Memory: .+ used of/);
  assert.match(status, /You \(this bot\): \d+ MB memory/);
});

test('processes are sorted, filtered and capped, by name and ID only', async () => {
  const pc = fakeComputer();
  const byMem = await systemInfo({ action: 'processes', name: '', sort: '', limit: 0 }, pc);
  assert.match(byMem, /^3 processes running; top 3 by memory:\nollama \(pid 11\)/);
  assert.match(await systemInfo({ action: 'processes', sort: 'cpu', limit: 1 }, pc), /top 1 by total CPU time:\npython \(pid 12\): 100 MB, 900s CPU$/);
  assert.match(await systemInfo({ action: 'processes', name: 'OLLA' }, pc), /^1 process matching "OLLA"/);
  assert.match(await systemInfo({ action: 'processes', name: 'steam' }, pc), /No running process has "steam"/);
  // The filter is applied here, never handed to PowerShell.
  assert.ok(pc.calls.every((c) => !c.join(' ').includes('OLLA') && !c.join(' ').includes('steam')));
});

test('failures and unknown actions say so instead of guessing', async () => {
  const broken = { run: async () => { throw new Error('denied'); }, platform: 'win32', sampleMs: 1 };
  assert.match(await systemInfo({ action: 'processes' }, broken), /^Error: couldn't read the process list/);
  assert.match(await systemInfo({ action: 'hardware' }, broken), /GPU: couldn't read the graphics card details/);
  assert.match(await systemInfo({ action: 'reboot' }, broken), /^Error: action must be/);
});

test('system_info is owner only, and background helpers get it too', async (t) => {
  const names = (perms) => enabledTools({ perms }).map((d) => d.function.name);
  assert.ok(names({ owner: true }).includes('system_info'));
  assert.ok(!names({ files: true, search: true }).includes('system_info'));

  const key = config.openrouter.apiKey, realFetch = globalThis.fetch;
  t.after(() => { config.openrouter.apiKey = key; globalThis.fetch = realFetch; });
  config.openrouter.apiKey = 'unused-test-key';
  let body;
  globalThis.fetch = (url, init) => { body = JSON.parse(init.body); return new Promise(() => {}); };
  await runTool('background_task', { action: 'start', title: 'Check specs', instructions: 'What GPU is there?' }, { conversation: 'system-info-test', perms: { owner: true } });
  assert.ok(body.tools.some((d) => d.function.name === 'system_info'));
  assert.match(body.messages[0].content, /system_info/);
});
