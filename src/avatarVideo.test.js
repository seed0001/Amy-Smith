import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findBrowser, recorderLaunch } from './avatarVideo.js';

test('findBrowser prefers AVATAR_BROWSER, then Chrome, then Edge', () => {
  const env = { PROGRAMFILES: 'C:\\PF', 'PROGRAMFILES(X86)': 'C:\\PF86' };
  const chrome = path.join('C:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const edge = path.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(findBrowser(env, (p) => p === chrome || p === edge), chrome);
  assert.equal(findBrowser(env, (p) => p === edge), edge);
  assert.equal(findBrowser({ ...env, AVATAR_BROWSER: 'X:\\b.exe' }, (p) => p === 'X:\\b.exe' || p === chrome), 'X:\\b.exe');
  assert.equal(findBrowser(env, () => false), null);
});

test('the hidden recorder opens the silent recorder page, headless, with audio allowed', () => {
  const args = recorderLaunch({ host: '0.0.0.0', port: 3000, password: '', profile: 'P' });
  assert.equal(args.at(-1), 'http://127.0.0.1:3000/avatar.html?recorder=1&silent=1');
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'));
  assert.ok(args.includes('--user-data-dir=P'));
});

test('the hidden recorder signs in when the dashboard has a password', () => {
  const args = recorderLaunch({ host: '127.0.0.1', port: 4000, password: 'p@ss word', profile: 'P' });
  assert.equal(args.at(-1), 'http://recorder:p%40ss%20word@127.0.0.1:4000/avatar.html?recorder=1&silent=1');
});
