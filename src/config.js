import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { RSS_LIMITS, clampPollMinutes, normalizeFeeds } from './rss.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const env = process.env;
const fluxRuntime = env.FLUX_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NewChamp', 'Flux');
const xttsRuntime = env.XTTS_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NewChamp', 'XTTS');
const parakeetRuntime = env.PARAKEET_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NewChamp', 'Parakeet');
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const personaPath = path.join(ROOT, 'persona.md');
const settingsPath = path.join(DATA_DIR, 'settings.json');

export const config = {
  discordToken: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID,

  botName: env.BOT_NAME || 'Champ',
  // On/off switch from the dashboard; remembered across restarts.
  botEnabled: true,
  persona: existsSync(personaPath) ? readFileSync(personaPath, 'utf8').trim() : '',
  // Lets people reshape the bot's persona just by asking in conversation.
  personaSelfEdit: bool(env.PERSONA_SELF_EDIT, true),
  // Discord user IDs of the owner: always top access, and the only one who can set contacts' tiers.
  ownerIds: list(env.OWNER_IDS),
  // Channels where the bot replies to every message (it always replies to DMs and @mentions).
  chatChannelIds: list(env.CHAT_CHANNEL_IDS),
  historyLimit: num(env.HISTORY_LIMIT, 100),

  ollama: {
    host: env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: env.OLLAMA_MODEL || 'gemma4:12b',
    embedModel: env.OLLAMA_EMBED_MODEL || 'bge-m3',
    think: bool(env.OLLAMA_THINK, false),
    // Context window in tokens. Ollama defaults to 4096, which silently cuts off long histories.
    numCtx: num(env.OLLAMA_NUM_CTX, 32768),
  },

  // Which brain writes the replies: 'ollama' (local), 'mistral' (Mistral's cloud), or 'openrouter' (cloud models, including big
  // reasoning ones). Memory extraction and embeddings always stay on local Ollama.
  brain: (env.BRAIN || 'ollama').toLowerCase(),
  providerFailover: true,
  turnClassifierEnabled: true,
  turnClassifierVoice: false, // also run it before spoken replies (slower; see companion.js)
  providerFailoverNarration: true,
  providerRetryMinutes: 15,
  // fastModel answers in voice and runs the quick behind-the-scenes calls (planner, mark scoring):
  // measured on her real prompt, gpt-6.1-terra started talking in ~2s vs ~6s for gpt-6.1-sol.
  // Text replies keep `model`. Blank = use `model` for everything.
  chatgpt: { model: env.CHATGPT_MODEL || '', fastModel: env.CHATGPT_FAST_MODEL ?? 'gpt-6.1-terra' },
  // Mistral's own cloud (https://console.mistral.ai/api-keys). The free Experiment plan is rate-limited
  // (about 1 request a second) with a large monthly token allowance.
  mistral: {
    apiKey: env.MISTRAL_API_KEY,
    model: env.MISTRAL_MODEL || 'mistral-large-latest',
  },
  // OpenRouter (https://openrouter.ai/keys). Also powers image generation, whichever brain is on.
  openrouter: {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
    // How hard reasoning models think before answering: none, low, medium or high.
    reasoning: (env.OPENROUTER_REASONING || 'medium').toLowerCase(),
    // Spoken replies: reasoning costs seconds before the first word, so it's off unless set.
    voiceReasoning: (env.OPENROUTER_VOICE_REASONING || 'none').toLowerCase(),
    imageModel: env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image',
    // Looks at pictures people send when her own model can't.
    visionModel: env.OPENROUTER_VISION_MODEL || 'google/gemini-3.8-flash',
    // Google Lyria 3 music: 30-second clips ($0.04 each) and full-length songs ($0.08 each).
    clipModel: env.OPENROUTER_CLIP_MODEL || 'google/lyria-3-clip-preview',
    songModel: env.OPENROUTER_SONG_MODEL || 'google/lyria-3-pro-preview',
  },

  memory: {
    topK: num(env.MEMORY_TOP_K, 6),
    minScore: num(env.MEMORY_MIN_SCORE, 0.35),
    dedupeScore: num(env.MEMORY_DEDUPE_SCORE, 0.9),
  },

  // Pictures: 'openrouter' (cloud, openrouter.imageModel), 'kontext' (FLUX.1 Kontext on this PC's
  // GPU through stable-diffusion.cpp/Vulkan) or 'flux' (FLUX.2 klein through PyTorch ROCm).
  imageProvider: env.IMAGE_PROVIDER || 'openrouter',
  kontext: {
    exe: env.KONTEXT_SD_EXE || path.join(os.homedir(), 'sd-cpp', 'sd-cli.exe'),
    model: env.KONTEXT_MODEL || path.join(os.homedir(), 'FLUX1-Kontext', 'flux1-kontext-dev-Q4_K_M.gguf'),
    vae: path.join(os.homedir(), 'FLUX1-Kontext', 'ae.safetensors'),
    clipL: path.join(os.homedir(), 'FLUX1-Kontext', 'clip_l.safetensors'),
    t5xxl: path.join(os.homedir(), 'FLUX1-Kontext', 't5xxl_fp8_e4m3fn.safetensors'),
    steps: num(env.KONTEXT_STEPS, 20),
  },
  flux: {
    python: env.FLUX_PYTHON || path.join(fluxRuntime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    modelDir: env.FLUX_MODEL_DIR || path.join(os.homedir(), 'FLUX2-klein-4B'),
  },

  // Text-to-speech: 'fish' (Fish Audio, cloud) or 'kokoro' (local, on this PC).
  tts: env.TTS_PROVIDER || 'fish',
  kokoro: {
    voice: env.KOKORO_VOICE || 'af_heart',
    speed: num(env.KOKORO_SPEED, 1),
  },
  xtts: {
    python: env.XTTS_PYTHON || path.join(xttsRuntime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    modelDir: env.XTTS_MODEL_DIR || path.join(xttsRuntime, 'model'),
    referenceDir: path.join(DATA_DIR, 'voices', 'xtts'),
    reference: env.XTTS_REFERENCE || '',
    language: env.XTTS_LANGUAGE || 'en',
    speed: num(env.XTTS_SPEED, 1),
  },

  fish: {
    apiKey: env.FISH_API_KEY,
    voiceId: env.FISH_VOICE_ID,
    // Her second, stronger voice for serious moments in calls (voice/tone.js). Blank turns it off.
    strongVoiceId: env.FISH_STRONG_VOICE_ID || '',
    ttsModel: env.FISH_TTS_MODEL || 's2.1-pro',
    asrModel: env.FISH_ASR_MODEL || 'transcribe-1-pro',
    language: env.FISH_LANGUAGE || 'en',
  },

  // Web search (https://tavily.com). Leave the key blank to turn search off.
  tavily: {
    apiKey: env.TAVILY_API_KEY,
    depth: env.TAVILY_DEPTH || 'basic', // basic = 1 credit, advanced = 2
    maxResults: num(env.TAVILY_MAX_RESULTS, 5),
  },

  // RSS/Atom news feeds she reads in the background (feeds.js). The list is set by the owner through
  // the news_feeds tool or data/settings.json ("rssFeeds": [{ "name", "url" }]); none are built in.
  rss: {
    enabled: bool(env.RSS_ENABLED, true),
    pollMinutes: clampPollMinutes(num(env.RSS_POLL_MINUTES, RSS_LIMITS.defaultPollMinutes)),
    feeds: [],
  },

  // Speech-to-text: 'groq' (Groq cloud Whisper, falls back to local), 'local' (Whisper on this PC),
  // or 'fish' (Fish Audio API, needs credit).
  stt: (env.STT_PROVIDER || 'local').toLowerCase(),
  parakeet: {
    python: env.PARAKEET_PYTHON || path.join(parakeetRuntime, 'venv', 'Scripts', 'python.exe'),
    modelDir: env.PARAKEET_MODEL_DIR || path.join(parakeetRuntime, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'),
    threads: Math.max(1, Math.min(16, Math.round(num(env.PARAKEET_THREADS, 4)))),
  },
  groq: {
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
  },
  whisper: {
    model: env.WHISPER_MODEL || 'Xenova/whisper-base.en',
    device: env.WHISPER_DEVICE || 'auto', // auto (GPU via DirectML, else CPU) | dml | cpu
  },

  voice: {
    // Voice channels the bot may join. Empty = any.
    channelIds: list(env.VOICE_CHANNEL_IDS),
    silenceMs: num(env.VOICE_SILENCE_MS, 800),
    minSpeechMs: num(env.VOICE_MIN_SPEECH_MS, 1200), // talk this long over her before she checks for a real interruption
    // ...and it only counts if that much speech transcribes to at least this many words.
    bargeInWords: num(env.VOICE_BARGE_IN_WORDS, 3),
    // Sounds shorter than this are ignored, so coughs and clicks don't become "thank you".
    minUtteranceMs: num(env.VOICE_MIN_UTTERANCE_MS, 1500),
    bargeIn: bool(env.VOICE_BARGE_IN, true),
    postTranscripts: bool(env.VOICE_POST_TRANSCRIPTS, true),
    // When she joins a call, read the room and greet everyone by name, introducing herself to
    // people she hasn't met in voice yet. Off falls back to one introduction per new person.
    joinGreeting: bool(env.VOICE_JOIN_GREETING, true),
    // If set, the bot only answers voice utterances containing this word.
    wakeWord: (env.VOICE_WAKE_WORD || '').toLowerCase(),
  },

  // Video replies: the recorder page (/avatar.html?recorder=1, opened in a hidden browser by the
  // bot when none is open) adds a clip of her face saying Discord text replies. AVATAR_VIDEO=off
  // switches the whole thing off.
  avatarVideo: !/^(off|false|0|no)$/i.test(env.AVATAR_VIDEO || ''),
  // Inner monologue: she thinks out loud (a short thought, said and shown) before she answers.
  innerMonologue: /^(on|true|1|yes)$/i.test(env.INNER_MONOLOGUE || ''),
  // Solo thoughts: a private thinking loop between conversations. Separate from innerMonologue.
  // On by default; empty thoughtChannelId means store privately and never post.
  soloMonologue: true,
  thoughtChannelId: String(env.THOUGHT_CHANNEL_ID || '').trim(),

  // The 3D avatar shown at /avatar.html.
  avatar: {
    path: env.AVATAR_PATH || path.join(DATA_DIR, 'avatar.glb'),
  },

  dashboard: {
    port: num(env.DASHBOARD_PORT, 3000),
    host: env.DASHBOARD_HOST || '127.0.0.1',
    password: env.DASHBOARD_PASSWORD || '',
  },
};

// Settings the dashboard can change at runtime. Saved to data/settings.json, which overrides .env.
// Each entry maps a flat settings key to [get, set] on the config object.
const EDITABLE = {
  sttProvider: [() => config.stt, (v) => {
    if (!['local', 'parakeet', 'groq', 'fish'].includes(v)) throw new Error('Unknown speech recognition provider');
    if (v === 'parakeet' && ![config.parakeet.python, ...['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].map(f => path.join(config.parakeet.modelDir, f))].every(existsSync)) throw new Error('Install local Parakeet first: run scripts/setup-parakeet.ps1');
    config.stt = v;
  }],
  botName: [() => config.botName, (v) => (config.botName = String(v).trim() || 'Champ')],
  botEnabled: [() => config.botEnabled, (v) => (config.botEnabled = Boolean(v))],
  voiceChannelIds: [() => config.voice.channelIds, (v) => (config.voice.channelIds = Array.isArray(v) ? v.map(String) : list(v))],
  chatChannelIds: [() => config.chatChannelIds, (v) => (config.chatChannelIds = Array.isArray(v) ? v.map(String) : list(v))],
  historyLimit: [() => config.historyLimit, (v) => (config.historyLimit = Math.max(1, Math.min(500, Math.round(Number(v)) || 100)))],
  personaSelfEdit: [() => config.personaSelfEdit, (v) => (config.personaSelfEdit = Boolean(v))],
  ollamaModel: [() => config.ollama.model, (v) => (config.ollama.model = String(v))],
  ollamaThink: [() => config.ollama.think, (v) => (config.ollama.think = Boolean(v))],
  avatarVideo: [() => config.avatarVideo, (v) => (config.avatarVideo = Boolean(v))],
  innerMonologue: [() => config.innerMonologue, (v) => (config.innerMonologue = Boolean(v))],
  soloMonologue: [() => config.soloMonologue, (v) => (config.soloMonologue = Boolean(v))],
  thoughtChannelId: [() => config.thoughtChannelId, (v) => (config.thoughtChannelId = String(v ?? '').trim())],
  brain: [() => config.brain, (v) => (config.brain = ['ollama', 'openrouter', 'chatgpt', 'mistral'].includes(v) ? v : config.brain)],
  providerFailover: [() => config.providerFailover, (v) => (config.providerFailover = Boolean(v))],
  turnClassifierEnabled: [() => config.turnClassifierEnabled, (v) => { if (typeof v !== 'boolean') throw new Error('turnClassifierEnabled must be a boolean'); config.turnClassifierEnabled = v; }],
  turnClassifierVoice: [() => config.turnClassifierVoice, (v) => (config.turnClassifierVoice = Boolean(v))],
  providerFailoverNarration: [() => config.providerFailoverNarration, (v) => (config.providerFailoverNarration = Boolean(v))],
  providerRetryMinutes: [() => config.providerRetryMinutes, (v) => (config.providerRetryMinutes = Math.max(1, Math.min(1440, Number(v) || 15)))],
  chatgptFastModel: [() => config.chatgpt.fastModel, (v) => (config.chatgpt.fastModel = String(v ?? '').trim())],
  chatgptModel: [() => config.chatgpt.model, (v) => (config.chatgpt.model = String(v ?? '').trim())],
  mistralModel: [() => config.mistral.model, (v) => (config.mistral.model = String(v).trim() || config.mistral.model)],
  openrouterModel: [() => config.openrouter.model, (v) => (config.openrouter.model = String(v).trim() || config.openrouter.model)],
  openrouterVoiceReasoning: [() => config.openrouter.voiceReasoning, (v) => (config.openrouter.voiceReasoning = ['none', 'low', 'medium', 'high'].includes(v) ? v : 'none')],
  openrouterReasoning: [() => config.openrouter.reasoning, (v) => (config.openrouter.reasoning = ['none', 'low', 'medium', 'high'].includes(v) ? v : 'medium')],
  openrouterImageModel: [() => config.openrouter.imageModel, (v) => (config.openrouter.imageModel = String(v).trim() || config.openrouter.imageModel)],
  imageProvider: [() => config.imageProvider, (v) => (config.imageProvider = ['openrouter', 'kontext', 'flux'].includes(v) ? v : config.imageProvider)],
  // Blank falls back to .env: with no voice ID, Fish picks a random voice for every sentence.
  fishVoiceId: [() => config.fish.voiceId ?? '', (v) => (config.fish.voiceId = String(v ?? '').trim() || env.FISH_VOICE_ID || '')],
  fishStrongVoiceId: [() => config.fish.strongVoiceId ?? '', (v) => (config.fish.strongVoiceId = String(v ?? '').trim() || env.FISH_STRONG_VOICE_ID || '')],
  ttsProvider: [() => config.tts, (v) => (config.tts = ['fish', 'kokoro', 'xtts'].includes(v) ? v : config.tts)],
  xttsReference: [() => config.xtts.reference, (v) => { const name = String(v ?? '').trim(); if (name && (path.basename(name) !== name || /[\\/]/.test(name))) throw new Error('XTTS reference must be a filename in the XTTS sample folder'); config.xtts.reference = name; }],
  xttsLanguage: [() => config.xtts.language, (v) => { const language = String(v).trim().toLowerCase(); if (!['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl', 'cs', 'ar', 'zh-cn', 'ja', 'hu', 'ko', 'hi'].includes(language)) throw new Error('Unsupported XTTS language'); config.xtts.language = language; }],
  xttsSpeed: [() => config.xtts.speed, (v) => { const speed = Number(v); if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('XTTS speed must be between 0.5 and 2'); config.xtts.speed = speed; }],
  kokoroVoice: [() => config.kokoro.voice, (v) => (config.kokoro.voice = String(v).trim() || config.kokoro.voice)],
  kokoroSpeed: [() => config.kokoro.speed, (v) => (config.kokoro.speed = Math.max(0.5, Math.min(2, Number(v) || 1)))],
  fishTtsModel: [() => config.fish.ttsModel, (v) => (config.fish.ttsModel = String(v))],
  fishLanguage: [() => config.fish.language, (v) => (config.fish.language = String(v).trim().toLowerCase())],
  voiceSilenceMs: [() => config.voice.silenceMs, (v) => (config.voice.silenceMs = Number(v) || 800)],
  voiceBargeIn: [() => config.voice.bargeIn, (v) => (config.voice.bargeIn = Boolean(v))],
  voicePostTranscripts: [() => config.voice.postTranscripts, (v) => (config.voice.postTranscripts = Boolean(v))],
  voiceJoinGreeting: [() => config.voice.joinGreeting, (v) => (config.voice.joinGreeting = Boolean(v))],
  voiceWakeWord: [() => config.voice.wakeWord, (v) => (config.voice.wakeWord = String(v).trim().toLowerCase())],
  rssEnabled: [() => config.rss.enabled, (v) => (config.rss.enabled = Boolean(v))],
  rssPollMinutes: [() => config.rss.pollMinutes, (v) => (config.rss.pollMinutes = clampPollMinutes(v))],
  rssFeeds: [() => config.rss.feeds, (v) => (config.rss.feeds = normalizeFeeds(v))],
};

let saved = {};
if (existsSync(settingsPath)) {
  try {
    saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const [key, value] of Object.entries(saved)) EDITABLE[key]?.[1](value);
  } catch (err) {
    console.warn('Ignoring unreadable data/settings.json:', err.message);
  }
}

export function getSettings() {
  return {
    ...Object.fromEntries(Object.entries(EDITABLE).map(([k, [get]]) => [k, get()])),
    persona: config.persona,
    mistralKey: Boolean(config.mistral.apiKey), // whether one is set, never the key itself
    openrouterKey: Boolean(config.openrouter.apiKey), // whether one is set, never the key itself
  };
}

export function updateSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'persona') {
      config.persona = String(value).trim();
      writeFileSync(personaPath, config.persona + '\n');
    } else if (EDITABLE[key]) {
      EDITABLE[key][1](value);
      saved[key] = EDITABLE[key][0]();
    }
  }
  writeFileSync(settingsPath, JSON.stringify(saved, null, 2));
  return getSettings();
}
