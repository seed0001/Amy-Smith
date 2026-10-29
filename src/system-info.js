import os from 'node:os';
import { execFile } from 'node:child_process';

// A read-only look at the owner's computer, for Amy and her helpers: hardware (CPU, RAM, GPUs and
// their video memory, disks, OS), current status (load, memory, disk space, GPU memory in use) and
// running processes. Only fixed commands run; nothing the model says is ever put into a command.
// Privacy: no usernames, hostname, serial numbers, network addresses, command lines, paths or window
// titles; processes are reported by name and ID only.

const TIMEOUT_MS = 20_000;
const MAX_PROCESSES = 40;
const MAX_CHARS = 6000;

function execText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
const powershell = (run, script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='SilentlyContinue'; ${script}`]);
const json = (text) => { try { return JSON.parse(String(text).trim() || 'null'); } catch { return null; } };
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const gb = (bytes) => `${(Number(bytes) / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes) => `${Math.round(Number(bytes) / 1024 ** 2)} MB`;

// Win32_VideoController's AdapterRAM stops at 4 GB, so dedicated video memory comes from the display
// driver's registry entry (a 64-bit value) when it's there.
const HARDWARE_PS =
  "$gpu = Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; ram = $_.AdapterRAM; driver = $_.DriverVersion } }; " +
  "$vram = Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | Where-Object { $_.'HardwareInformation.qwMemorySize' } | ForEach-Object { $b = $_.'HardwareInformation.qwMemorySize'; @{ name = $_.DriverDesc; bytes = $(if ($b -is [byte[]]) { [BitConverter]::ToUInt64($b, 0) } else { [uint64]$b }) } }; " +
  "$os = Get-CimInstance Win32_OperatingSystem | ForEach-Object { @{ name = $_.Caption; version = $_.Version } }; " +
  "@{ gpu = @($gpu); vram = @($vram); os = $os } | ConvertTo-Json -Depth 4 -Compress";
const DISKS_PS = "@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ drive = $_.DeviceID; size = $_.Size; free = $_.FreeSpace; fs = $_.FileSystem } }) | ConvertTo-Json -Compress";
const GPU_USE_PS = "$s = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples; if ($s) { ($s | Measure-Object CookedValue -Sum).Sum } else { '' }";
const PROCESSES_PS = '@(Get-Process | ForEach-Object { @{ name = $_.ProcessName; id = $_.Id; mem = $_.WorkingSet64; cpu = $_.CPU } }) | ConvertTo-Json -Compress';

// NVIDIA cards report exact memory and load through nvidia-smi, when it's installed.
async function nvidia(run) {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']).catch(() => '');
  return out.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [name, total, used, util, temp] = l.split(',').map((s) => s.trim());
    return { name, total: Number(total), used: Number(used), util: Number(util), temp: Number(temp) };
  });
}

function cpuLine() {
  const cpus = os.cpus();
  return `CPU: ${cpus[0]?.model?.trim() ?? 'unknown'}, ${cpus.length} logical cores, ${os.arch()}`;
}

async function cpuLoad(ms) {
  const sample = () => os.cpus().map((c) => c.times).reduce((a, t) => ({ idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq }), { idle: 0, total: 0 });
  const a = sample();
  await new Promise((r) => setTimeout(r, ms));
  const b = sample();
  const total = b.total - a.total;
  return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : null;
}

async function diskLines(run, windows) {
  if (!windows) return [];
  const disks = list(json(await powershell(run, DISKS_PS).catch(() => '')));
  return disks.map((d) => `Disk ${d.drive} ${gb(d.free)} free of ${gb(d.size)}${d.fs ? ` (${d.fs})` : ''}`);
}

async function hardware(run, windows) {
  const lines = [cpuLine(), `RAM: ${gb(os.totalmem())} total`];
  const [info, nv, disks] = await Promise.all([windows ? powershell(run, HARDWARE_PS).then(json).catch(() => null) : null, nvidia(run), diskLines(run, windows)]);
  if (nv.length) for (const g of nv) lines.push(`GPU: ${g.name}, ${(g.total / 1024).toFixed(1)} GB video memory (from nvidia-smi)`);
  else if (info) {
    const vram = list(info.vram);
    for (const g of list(info.gpu)) {
      const exact = vram.find((v) => v.name === g.name)?.bytes;
      lines.push(`GPU: ${g.name}, ${exact ? `${gb(exact)} dedicated video memory` : g.ram ? `at least ${gb(g.ram)} video memory (Windows caps this report at 4 GB)` : 'video memory unknown'}${g.driver ? `, driver ${g.driver}` : ''}`);
    }
  } else lines.push(windows ? "GPU: couldn't read the graphics card details" : 'GPU: only readable on Windows or with nvidia-smi');
  lines.push(...disks);
  const osInfo = info?.os;
  lines.push(`OS: ${osInfo?.name ? `${osInfo.name} ${osInfo.version}` : `${os.type()} ${os.release()}`}`);
  return lines.join('\n');
}

async function status(run, windows, sampleMs) {
  const [load, nv, disks, gpuUse] = await Promise.all([
    cpuLoad(sampleMs),
    nvidia(run),
    diskLines(run, windows),
    windows ? powershell(run, GPU_USE_PS).catch(() => '') : '',
  ]);
  const used = os.totalmem() - os.freemem();
  const hours = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  const lines = [
    `Computer up for ${hours(os.uptime())}`,
    `CPU load: ${load == null ? 'unknown' : `${load}%`} (${os.cpus().length} logical cores)`,
    `Memory: ${gb(used)} used of ${gb(os.totalmem())} (${Math.round((100 * used) / os.totalmem())}%), ${gb(os.freemem())} free`,
  ];
  if (nv.length) for (const g of nv) lines.push(`GPU ${g.name}: ${g.util}% busy, ${g.used} of ${g.total} MB video memory used${Number.isFinite(g.temp) ? `, ${g.temp}°C` : ''}`);
  else if (Number(gpuUse) > 0) lines.push(`GPU: ${gb(gpuUse)} dedicated video memory in use (all cards)`);
  lines.push(...disks);
  lines.push(`You (this bot): ${mb(process.memoryUsage().rss)} memory, running ${hours(Math.round(process.uptime()))}, Node ${process.version}`);
  return lines.join('\n');
}

async function processes(run, windows, { name, sort, limit }) {
  if (!windows) return 'Error: the process list is only available on Windows.';
  const all = list(json(await powershell(run, PROCESSES_PS).catch(() => ''))).filter((p) => p?.name);
  if (!all.length) return "Error: couldn't read the process list.";
  const want = String(name ?? '').trim().toLowerCase();
  const matched = want ? all.filter((p) => p.name.toLowerCase().includes(want)) : all;
  if (!matched.length) return `No running process has "${name}" in its name (${all.length} processes running).`;
  const byCpu = sort === 'cpu';
  matched.sort((a, b) => (byCpu ? (b.cpu ?? 0) - (a.cpu ?? 0) : (b.mem ?? 0) - (a.mem ?? 0)));
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 15, 1), MAX_PROCESSES);
  const head = `${matched.length} process${matched.length === 1 ? '' : 'es'}${want ? ` matching "${name}"` : ' running'}; top ${Math.min(n, matched.length)} by ${byCpu ? 'total CPU time' : 'memory'}:`;
  const rows = matched.slice(0, n).map((p) => `${p.name} (pid ${p.id}): ${mb(p.mem ?? 0)}${p.cpu != null ? `, ${Math.round(p.cpu)}s CPU` : ''}`);
  return [head, ...rows].join('\n');
}

// action: hardware | status | processes. For processes: name filters by part of the name, sort is
// memory (default) or cpu, limit is how many to show (default 15, max 40).
export async function systemInfo({ action, name, sort, limit } = {}, { run = execText, platform = process.platform, sampleMs = 500 } = {}) {
  const windows = platform === 'win32';
  let out;
  if (action === 'hardware') out = await hardware(run, windows);
  else if (action === 'status') out = await status(run, windows, sampleMs);
  else if (action === 'processes') out = await processes(run, windows, { name, sort, limit });
  else return 'Error: action must be hardware, status or processes.';
  return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}\n[TRUNCATED: ask for fewer processes or filter by name]` : out;
}
