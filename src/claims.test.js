import test from 'node:test';
import assert from 'node:assert/strict';
import { phantomClaim } from './claims.js';
import { visitResult } from './doctor.js';

const none = new Map();

test('her own unbacked claim is still caught', () => {
  assert.equal(phantomClaim("Done, I've sent it to you.", none).tool, 'send_file');
  assert.equal(phantomClaim('Sent you the file just now.', none).tool, 'send_file');
  assert.equal(phantomClaim('Alright, it’s playing now.', none).tool, 'music');
  assert.equal(phantomClaim("I've sent it.", new Map([['send_file', true]])), null);
});

test('reporting an error or someone else doing it is not a claim', () => {
  // From her logs: each of these got a canned "correction: that didn't go through" tacked on.
  assert.equal(phantomClaim("The picture didn't go through, the image tool rejected the request. I haven't sent you a pic.", none), null);
  assert.equal(phantomClaim('ultrahal sent you a zip of the Tiny Model Maker source around 3:50 PM.', none), null);
  assert.equal(phantomClaim('The stuff Travis sent you in the DM should have the exact commands.', none), null);
  assert.equal(phantomClaim("Sorry, I couldn't get it posted, so nothing went to #general.", none), null);
});

test("the doctor's work counts only when its ok result is on record", () => {
  const line = 'The doctor updated the code and the file has been updated.';
  assert.equal(phantomClaim(line, none).tool, 'files');
  assert.equal(phantomClaim(line, none, { doctorOk: true }), null);
});

test('a doctor visit becomes a verified history note', () => {
  assert.equal(visitResult({ title: 'fix waits', ok: true, changed: 'src/a.js', tests: 'pass' }), 'doctor fix waits: ok, tests pass');
  assert.equal(visitResult({ title: 'x', ok: false, changed: '', tests: 'not run' }), 'doctor x: failed, no files changed');
});
