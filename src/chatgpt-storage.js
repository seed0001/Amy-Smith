import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// Keep subscription credentials outside the project/OneDrive and beyond the bot's file tools.
export const CHATGPT_AUTH_DIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NewChamp', 'ChatGPT')
  : path.join(os.homedir(), '.config', 'new-champ', 'chatgpt');

function dpapi(value, decrypt = false) {
  const script = decrypt
    ? 'Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))'
    : 'Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($v),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b))';
  // Tokens travel only through stdin/stdout, never through command arguments or logs.
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Could not access protected ChatGPT credential storage'); }
}

export function createCredentialStore({ directory = CHATGPT_AUTH_DIR, protect = process.platform === 'win32' ? (v) => dpapi(v) : (v) => v, unprotect = process.platform === 'win32' ? (v) => dpapi(v, true) : (v) => v } = {}) {
  const file = path.join(directory, 'credentials.json');
  function read() {
    if (!existsSync(file)) return { hostId: `urn:uuid:${randomUUID()}`, activeId: null, accounts: {} };
    try { return JSON.parse(unprotect(readFileSync(file, 'utf8'))); }
    catch { throw new Error('ChatGPT credentials could not be read; existing credentials were preserved'); }
  }
  function write(value) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, protect(JSON.stringify(value)), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  }
  async function withLock(fn) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, 'refresh.lock');
    const started = Date.now();
    for (;;) {
      let descriptor;
      try { descriptor = openSync(lock, 'wx', 0o600); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // A crashed process cannot hold rotating credentials indefinitely.
        try { if (Date.now() - statSync(lock).mtimeMs > 120000) { unlinkSync(lock); continue; } } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (Date.now() - started > 45000) throw new Error('Another Amy process is renewing ChatGPT sign-in. Try again shortly');
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      try { return await fn(); }
      finally { closeSync(descriptor); try { unlinkSync(lock); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
    }
  }
  return { read, write, withLock };
}
