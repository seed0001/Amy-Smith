import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import { DATA_DIR } from './config.js';

// What people send her on Discord. Every attachment is saved to data/files/received (so she can
// open it again later with the files tool, or send it back), then:
//   images -> passed to the model to look at (base64, at most MAX_IMAGES)
//   documents -> turned into text and put in the message: plain text and code as is, PDFs page by
//   page, Word / PowerPoint / Excel / OpenDocument from the XML inside them.
// Anything it can't read (audio, video, archives, unknown binaries) is still saved, and she's told so.

export const RECEIVED_DIR = path.join(DATA_DIR, 'files', 'received');
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOC_BYTES = 30 * 1024 * 1024;
const MAX_DOC_CHARS = 150_000; // per document; past this she's told it was cut and where the full file is

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bat|ps1|cmd|sql|yaml|yml|toml|ini|cfg|conf|env|log|srt|vtt|tex|rtf|lua|swift|r|m|pl|vue|svelte|gradle|properties|gitignore|dockerfile)$/i;
const OFFICE = /\.(docx|pptx|xlsx|odt|odp|ods)$/i;

// attachments: discord.js Collection or array of { name, url, contentType, size }.
export async function readAttachments(attachments) {
  const out = { images: [], docs: [], notes: [] };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  for (const a of [...(attachments?.values?.() ?? attachments ?? [])]) {
    const name = a.name || 'file';
    const type = a.contentType || '';
    const isImage = type.startsWith('image/') || IMAGE.test(name);
    if (a.size > (isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES)) {
      out.notes.push(`${name} is too big to open (${(a.size / 1048576).toFixed(1)} MB).`);
      continue;
    }
    let bytes;
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      out.notes.push(`${name} couldn't be downloaded: ${err.message}.`);
      continue;
    }
    const saved = save(stamp, name, bytes);

    if (isImage) {
      if (out.images.length >= MAX_IMAGES) {
        out.notes.push(`${name} (image) was saved to ${saved} but not shown to you: only ${MAX_IMAGES} images per message.`);
        continue;
      }
      out.images.push({ name, saved, base64: bytes.toString('base64'), mime: type.startsWith('image/') ? type : `image/${path.extname(name).slice(1).toLowerCase().replace('jpg', 'jpeg')}` });
      continue;
    }
    try {
      const text = await toText(name, type, bytes);
      if (text == null) {
        out.notes.push(`${name} (${type || 'unknown type'}) can't be read as text; it's saved at ${saved}.`);
        continue;
      }
      const clean = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
      out.docs.push({
        name,
        saved,
        text: clean.length > MAX_DOC_CHARS ? `${clean.slice(0, MAX_DOC_CHARS)}\n[TRUNCATED: showed ${MAX_DOC_CHARS} of ${clean.length} characters. The whole file is at ${saved}; read the rest with the files tool.]` : clean || '(the document has no text in it; it may be scanned images)',
      });
    } catch (err) {
      out.notes.push(`${name} couldn't be read (${err.message}); it's saved at ${saved}.`);
    }
  }
  return out;
}

function save(stamp, name, bytes) {
  mkdirSync(RECEIVED_DIR, { recursive: true });
  const file = path.join(RECEIVED_DIR, `${stamp}_${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`);
  writeFileSync(file, bytes);
  return file;
}

async function toText(name, type, bytes) {
  if (/\.pdf$/i.test(name) || type === 'application/pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => `--- page ${i + 1} of ${totalPages} ---\n${t}`).join('\n\n');
  }
  if (OFFICE.test(name)) return officeText(name, bytes);
  if (TEXT.test(name) || type.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(type) || looksLikeText(bytes)) {
    return bytes.toString('utf8');
  }
  return null;
}

// Mostly printable and no NUL bytes in the first few KB: treat an unknown file as text.
function looksLikeText(bytes) {
  const head = bytes.subarray(0, 4096);
  if (!head.length || head.includes(0)) return false;
  let odd = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) odd++;
  return odd / head.length < 0.02;
}

// Office files are zips of XML: pull the text out of the parts that hold it, in order.
function officeText(name, bytes) {
  const files = unzipSync(new Uint8Array(bytes));
  const xml = (p) => (files[p] ? strFromU8(files[p]) : '');
  const ext = path.extname(name).toLowerCase();
  const byNumber = (re) => Object.keys(files).filter((p) => re.test(p)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0));

  if (ext === '.docx') {
    return [xml('word/document.xml'), ...byNumber(/^word\/(footnotes|endnotes)\.xml$/).map(xml)]
      .map((x) => paragraphs(x, 'w:p', 'w:t', 'w:tab'))
      .join('\n\n');
  }
  if (ext === '.pptx') {
    return byNumber(/^ppt\/slides\/slide\d+\.xml$/)
      .map((p, i) => `--- slide ${i + 1} ---\n${paragraphs(xml(p), 'a:p', 'a:t')}`)
      .join('\n\n');
  }
  if (ext === '.xlsx') {
    const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
    const sheetNames = [...xml('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
    return byNumber(/^xl\/worksheets\/sheet\d+\.xml$/)
      .map((p, i) => {
        const rows = [...xml(p).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
          [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map((c) => {
              const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c[2]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
              return /t="s"/.test(c[1]) ? shared[Number(v)] ?? '' : decode(v);
            })
            .join('\t'),
        );
        return `--- sheet ${sheetNames[i] ?? i + 1} ---\n${rows.join('\n')}`;
      })
      .join('\n\n');
  }
  // OpenDocument (.odt, .odp, .ods): everything is in content.xml.
  return paragraphs(xml('content.xml'), 'text:p|text:h', null);
}

// Text of each paragraph element, one per line. run: the element holding text (null: all text inside).
function paragraphs(xmlText, para, run, tab) {
  const out = [];
  for (const m of xmlText.matchAll(new RegExp(`<(?:${para})[ >][\\s\\S]*?</(?:${para})>`, 'g'))) {
    let p = m[0];
    if (tab) p = p.replace(new RegExp(`<${tab}\\/>`, 'g'), '<x>\t</x>');
    const text = run ? [...p.matchAll(new RegExp(`<${run}(?: [^>]*)?>([\\s\\S]*?)</${run}>`, 'g'))].map((t) => t[1]).join('') : p.replace(/<text:tab\/>/g, '\t').replace(/<[^>]+>/g, '');
    out.push(decode(text));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function decode(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

// "HeavyWaterFirewall-Manual.txt" -> "Heavy Water Firewall Manual", so recall can match how people say it.
export const fileTitle = (name) => path.parse(name).name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').trim();

// A file only lives in the conversation it arrived in, so elsewhere (voice, another channel) she'd
// have no idea she got it. These are memories filed under the sender: what they sent, that she read
// it, her take, and where it's saved to open again. A DM stays marked private, so she doesn't bring
// it up in front of others unless the sender does.
export function sharedFileMemories({ speakerName, files, where, dm = false, take = '', date = new Date() }) {
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const gist = take.replace(/\s+/g, ' ').trim().slice(0, 240);
  return files.map((f) =>
    `${day}: ${speakerName} sent you "${fileTitle(f.name)}" (${f.name}) ${dm ? 'in a private DM' : `in ${where}`}, and you ${f.base64 || f.mime ? 'looked at' : 'read'} it.` +
    (gist ? ` Your reply then: "${gist}"` : '') +
    ` It's saved at ${f.saved}; to read it again, open it with received_file. You don't remember its contents word for word, so open it before quoting or answering details from it.` +
    (dm ? ` It was private: only discuss it with ${speakerName}, or when ${speakerName} brings it up.` : ''));
}

// Files people sent, so the received_file tool can open them again from voice or another channel,
// for anyone allowed to (files is owner-only, so without this she couldn't reopen a guest's file).
// Noted the moment they arrive, before her reply is saved: a voice turn a second later still finds it.
// Older ones come from the saved messages (rows: { user_id, name, created_at, attachments }).
const received = [];
export function noteReceived({ attachments, from, fromName, dm, guild = null, where = '' }) {
  for (const f of [...(attachments?.docs ?? []), ...(attachments?.images ?? [])]) {
    received.push({ name: f.name, saved: f.saved, text: f.text, image: !f.text, from, fromName, dm: Boolean(dm), guild, where, at: Date.now() });
  }
  received.splice(0, Math.max(0, received.length - 50));
}

// Who can open it: the owner, whoever sent it, or someone in the same server when it was posted in
// one of its channels. A saved message from before dm was recorded can't be told apart from a DM, so
// only its sender opens it; so does anything that didn't come from a server (DMs, the dashboard).
export function canOpenReceived(f, { speakerId, owner = false, guild = null }) {
  if (owner || f.from === speakerId) return true;
  return f.dm === false && Boolean(f.guild) && f.guild === guild;
}

// The files matching `query` (a name or words of its title; "" for all), newest first, split into
// what this person may open and how many others matched but are private.
export function findReceived(query, who, rows = []) {
  const saved = rows.flatMap((r) => {
    let att;
    try { att = JSON.parse(r.attachments); } catch { return []; }
    return [...(att.docs ?? []), ...(att.images ?? [])].map((f) => ({
      name: f.name, saved: f.saved, text: f.text, image: !f.text, from: r.user_id, fromName: r.name,
      dm: att.dm, guild: att.guild ?? null, where: att.where ?? '', at: r.created_at,
    }));
  });
  const seen = new Set();
  const all = [...received].reverse().concat(saved).filter((f) => !seen.has(f.saved) && seen.add(f.saved));
  const words = fileTitle(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  // Best match first: how many of the words are in its name ("the heavy water manual" still finds it).
  const score = (f) => words.filter((w) => `${f.name} ${fileTitle(f.name)}`.toLowerCase().includes(w)).length;
  const hits = words.length ? all.filter((f) => score(f) > 0).sort((a, b) => score(b) - score(a)) : all;
  const open = hits.filter((f) => canOpenReceived(f, who));
  return { open, hidden: hits.length - open.length };
}

// The documents, as text for her message.
export function documentsBlock({ docs, notes, images }) {
  const parts = docs.map((d) => `(Attached document "${d.name}", saved at ${d.saved}. Its contents:)\n<<<\n${d.text}\n>>>`);
  if (images.length) parts.push(`(Attached image${images.length > 1 ? 's' : ''}: ${images.map((i) => `"${i.name}" (saved at ${i.saved})`).join(', ')}. You can see ${images.length > 1 ? 'them' : 'it'} in this message.)`);
  for (const n of notes) parts.push(`(${n})`);
  return parts.join('\n\n');
}
