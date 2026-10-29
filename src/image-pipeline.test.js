import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGeneralImage, generateSelfImage, imageRouteError, isSelfImageRequest, directImageIntent } from './image-pipeline.js';

test('direct mode resolves image follow-ups from successful tool history', () => {
  const rows = [{ tools: 'generate_self_image : ok' }];
  assert.equal(directImageIntent('make it anime', rows, 'Amy'), 'self');
  assert.equal(directImageIntent('draw a dragon', rows, 'Amy'), 'general');
  assert.equal(directImageIntent('make it anime', [{ tools: 'generate_image : ok' }]), 'general');
  assert.equal(directImageIntent('make it anime', [{ tools: 'generate_self_image : failed' }]), null);
});

test('direct mode requires explicit permission to replace identity assets', () => {
  assert.match(imageRouteError('look', { action: 'setup' }, { classifierDirect: true, userText: 'make a selfie' }), /explicit appearance setup/);
  assert.equal(imageRouteError('look', { action: 'setup' }, { classifierDirect: true, userText: 'replace your identity reference' }), null);
});

test('general images never receive companion references', async () => {
  let call;
  await generateGeneralImage(' A dragon over a city ', { generateImage: async (...args) => { call = args; }, referenceImage() { throw new Error('must not read identity'); } });
  assert.deepEqual(call, ['A dragon over a city', []]);
});

test('self-images require identity sheet and include current saved look when available', async () => {
  const reference = { mime: 'image/png', bytes: Buffer.from('identity') };
  const active = { mime: 'image/png', bytes: Buffer.from('outfit') };
  let call;
  await generateSelfImage('anime style in a forest', { name: 'Amy', referenceImage: () => reference, activeImage: () => active, generateImage: async (...args) => { call = args; } });
  assert.deepEqual(call[1], [reference, active]);
  assert.match(call[0], /anime style in a forest/);
  assert.match(call[0], /authoritative identity/);
  assert.match(call[0], /Amy/);
});

test('missing identity fails without generating, inventing assets or falling back', async () => {
  let calls = 0;
  await assert.rejects(generateSelfImage('at the beach', { referenceImage: () => null, generateImage: () => { calls++; } }), /reference sheet is missing/);
  assert.equal(calls, 0);
});

test('identity sheet alone is sufficient when no active saved look exists', async () => {
  const reference = { mime: 'image/png', bytes: Buffer.from('identity') };
  await generateSelfImage('watercolor portrait', { referenceImage: () => reference, activeImage: () => null, generateImage: async (prompt, refs) => assert.deepEqual(refs, [reference]) });
});

test('route guards reject wrong tools and prevent silent identity setup', () => {
  const self = { imageIntent: 'self', userText: 'make a picture of you', character: { name: 'Amy' } };
  assert.match(imageRouteError('generate_image', { prompt: 'woman at the beach' }, self), /generate_self_image/);
  assert.match(imageRouteError('look', { action: 'setup' }, self), /does not authorize/);
  assert.match(imageRouteError('look', { action: 'new' }, self), /generate_self_image/);
  const general = { imageIntent: 'general', userText: 'draw a dragon', character: { name: 'Amy' } };
  assert.match(imageRouteError('generate_self_image', {}, general), /generate_image/);
  assert.match(imageRouteError('generate_self_image', { prompt: 'picture of Amy' }, general), /general image/);
  assert.match(imageRouteError('generate_image', { prompt: 'picture of Amy with a dragon' }, general), /Remove the companion/);
  assert.match(imageRouteError('look', { action: 'new' }, general), /general image/);
  assert.equal(imageRouteError('generate_image', { prompt: 'dragon' }, general), null);
  assert.equal(imageRouteError('generate_self_image', { prompt: 'forest portrait' }, self), null);
});

test('direct self requests are detected without treating ordinary pictures as self-images', () => {
  for (const text of ['create an image about you', 'draw yourself', 'make a picture of Amy', 'send me a selfie', 'take a selfie on the beach', 'paint you wearing a dress']) assert.equal(isSelfImageRequest(text, 'Amy'), true, text);
  for (const text of ['draw a dragon', 'make an image you like', 'a woman taking a selfie', 'make a selfie of an astronaut', 'create a random image']) assert.equal(isSelfImageRequest(text, 'Amy'), false, text);
});
