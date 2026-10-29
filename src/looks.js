import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

// Her stored appearance. Two kinds of image live here:
//   reference  the multi-angle identity sheet (face, hair, body) that every future picture is
//              generated from, so she stays recognisably the same person.
//   looks      saved outfits/selfies. The active one is her dashboard profile picture; the rest
//              stay in the gallery so she can switch back into them or send them again.
// Both are plain image files in data/looks with a small looks.json index beside them.
const DIR = path.join(DATA_DIR, 'looks');
const INDEX = path.join(DIR, 'looks.json');

const emptyState = () => ({ reference: null, activeId: null, looks: [] });

function load() {
  try {
    if (!existsSync(INDEX)) return emptyState();
    const parsed = JSON.parse(readFileSync(INDEX, 'utf8'));
    return {
      reference: parsed.reference ?? null,
      activeId: parsed.activeId ?? null,
      looks: Array.isArray(parsed.looks) ? parsed.looks : [],
    };
  } catch (err) {
    console.warn('Ignoring unreadable data/looks/looks.json:', err.message);
    return emptyState();
  }
}

let state = load();

function save() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(INDEX, JSON.stringify(state, null, 2));
}

function extFor(mime) {
  const ext = String(mime || 'image/png').split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  return ext || 'png';
}

function writeImage(prefix, { mime, bytes }) {
  mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${prefix}-${stamp}.${extFor(mime)}`;
  writeFileSync(path.join(DIR, file), bytes);
  return file;
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

export function reference() {
  return state.reference ? { ...state.reference } : null;
}

// The bytes the image model needs to keep her identity. null until setup has run.
export function referenceImage() {
  if (!state.reference) return null;
  try {
    return { mime: state.reference.mime, bytes: readFileSync(path.join(DIR, state.reference.file)) };
  } catch {
    return null;
  }
}

export function saveReference({ mime, bytes, prompt = '' }) {
  if (state.reference?.file) {
    try {
      unlinkSync(path.join(DIR, state.reference.file));
    } catch {}
  }
  const file = writeImage('reference', { mime, bytes });
  state.reference = { file, mime, prompt, createdAt: Date.now() };
  save();
  activity('look', { message: 'Reference sheet saved' });
  return reference();
}

export function addLook({ name, mime, bytes, prompt = '', kind = 'look' }) {
  const id = `look_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const file = writeImage(id, { mime, bytes });
  const look = { id, name: cleanName(name) || 'Look', file, mime, prompt, kind, createdAt: Date.now() };
  state.looks.unshift(look);
  state.activeId = id;
  save();
  activity('look', { message: `New look saved: ${look.name}` });
  return { ...look };
}

export function getLook(id) {
  return state.looks.find((l) => l.id === id) ?? null;
}

// A saved look by id or name. With no query, the active look.
export function findLook(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return activeLook();
  const q = raw.toLowerCase();
  return (
    state.looks.find((l) => l.id === raw) ??
    state.looks.find((l) => l.name.toLowerCase() === q) ??
    state.looks.find((l) => l.name.toLowerCase().includes(q)) ??
    null
  );
}

export function activeLook() {
  return state.activeId ? getLook(state.activeId) : null;
}

export function setActive(id) {
  const look = getLook(id) ?? findLook(id);
  if (!look) return null;
  state.activeId = look.id;
  save();
  activity('look', { message: `Profile picture switched to ${look.name}` });
  return { ...look };
}

export function lookImage(id) {
  const look = getLook(id);
  if (!look) return null;
  try {
    return { ...look, bytes: readFileSync(path.join(DIR, look.file)) };
  } catch {
    return null;
  }
}

export const lookUrl = (id) => `/api/looks/image/${encodeURIComponent(id)}`;
export const referenceUrl = () => '/api/looks/reference';

export function activeImageUrl() {
  const active = activeLook();
  return active ? lookUrl(active.id) : null;
}

export const count = () => state.looks.length;

// What the dashboard needs to draw the Looks tab.
export function stateForApi() {
  const active = activeLook();
  return {
    activeId: state.activeId,
    active: active ? { ...active, url: lookUrl(active.id) } : null,
    reference: state.reference ? { ...state.reference, url: referenceUrl() } : null,
    looks: state.looks.map((l) => ({ ...l, url: lookUrl(l.id), active: l.id === state.activeId })),
  };
}

// The small profile summary that /api/status carries for the header.
export function statusForApi() {
  const active = activeLook();
  return {
    active: active ? { id: active.id, name: active.name, url: lookUrl(active.id) } : null,
    reference: state.reference ? { url: referenceUrl() } : null,
    count: state.looks.length,
  };
}
