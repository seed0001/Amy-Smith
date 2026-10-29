import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const directory = path.join(DATA_DIR, 'task-deliveries');
mkdirSync(directory, { recursive: true });
let sequence = Math.max(Date.now(), ...readdirSync(directory).filter(f => /^\d+\.json$/.test(f)).map(f => Number(f.slice(0, -5))));

export function saveGenerationDelivery(conversation, kind, data, storageDir = directory) {
  const id = ++sequence;
  const { base64, ...metadata } = data;
  if (base64) writeFileSync(path.join(storageDir, `${id}.bin`), Buffer.from(base64, 'base64'));
  const record = { ...metadata, id, conversation, kind, time: Date.now(), ...(base64 ? { url: `/api/generation-deliveries/${id}/media` } : {}) };
  writeFileSync(path.join(storageDir, `${id}.json`), JSON.stringify(record));
  return record;
}

export function generationDeliveries(conversation, after = 0, storageDir = directory) {
  return readdirSync(storageDir).filter(f => /^\d+\.json$/.test(f) && Number(f.slice(0, -5)) > Number(after || 0)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5))).map(f => JSON.parse(readFileSync(path.join(storageDir, f), 'utf8'))).filter(r => r.conversation === conversation).slice(0, 50);
}

export function generationDeliveryMedia(id, storageDir = directory) {
  if (!/^\d+$/.test(String(id))) throw new Error('Invalid delivery ID');
  const metadata = JSON.parse(readFileSync(path.join(storageDir, `${id}.json`), 'utf8'));
  return { metadata, bytes: readFileSync(path.join(storageDir, `${id}.bin`)) };
}

export function generationDestination(conversation, characterName) {
  const save = (kind, data) => saveGenerationDelivery(conversation, kind, { ...data, characterName });
  return {
    showImage: data => save('image', data),
    showAudio: data => save('audio', data),
    sendBackground: file => save('file', { name: file.name, base64: Buffer.from(file.attachment).toString('base64') }),
    notify: message => save('notice', { message }),
  };
}
