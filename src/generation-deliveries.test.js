import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveGenerationDelivery, generationDeliveries, generationDeliveryMedia } from './generation-deliveries.js';

test('completed media persists independently of a reply stream and stays in its conversation', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'amy-deliveries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const image = saveGenerationDelivery('avatar', 'image', { name: 'portrait.png', mime: 'image/png', base64: Buffer.from('image bytes').toString('base64') }, root);
  const notice = saveGenerationDelivery('avatar', 'notice', { message: 'Done' }, root);
  saveGenerationDelivery('dashboard', 'notice', { message: 'Another conversation' }, root);
  assert.equal(image.base64, undefined);
  assert.match(image.url, /\/media$/);
  assert.deepEqual(generationDeliveries('avatar', 0, root).map(record => record.id), [image.id, notice.id]);
  assert.deepEqual(generationDeliveries('avatar', image.id, root).map(record => record.id), [notice.id]);
  const media = generationDeliveryMedia(image.id, root);
  assert.equal(media.bytes.toString(), 'image bytes');
  assert.equal(media.metadata.name, 'portrait.png');
  assert.throws(() => generationDeliveryMedia('../settings', root), /Invalid delivery ID/);
});

test('delivery pagination does not skip earlier results when many jobs complete offline', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'amy-deliveries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 55; i++) saveGenerationDelivery('avatar', 'notice', { message: String(i) }, root);
  const first = generationDeliveries('avatar', 0, root);
  const next = generationDeliveries('avatar', first.at(-1).id, root);
  assert.equal(first.length, 50);
  assert.equal(first[0].message, '0');
  assert.equal(next.length, 5);
  assert.equal(next.at(-1).message, '54');
});
