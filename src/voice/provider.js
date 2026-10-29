import { xttsAvailability } from './xtts.js';

// Provider changes use injected dependencies so validation can be tested without loading a model.
export async function changeVoice({ action = 'status', engine = '', voice = '', speed = 0 } = {}, { config, updateSettings, voices, activity, xttsVoices = () => [], prepareXTTS }) {
  if (!['status', 'set', 'voices', 'providers'].includes(action)) throw new Error('Unknown voice action');
  if (action === 'providers') return 'Available TTS providers: Fish Audio (cloud, cloned voices; requires an API key), Kokoro (local preset voices), and XTTS (local voice cloning from your saved sample).';
  if (action === 'voices') {
    if (engine === 'xtts' || (!engine && config.tts === 'xtts')) return `XTTS voice samples: ${(await xttsVoices()).join(', ') || 'none yet; put your reference audio in the XTTS sample folder'}.`;
    return `Kokoro voices: ${(await voices()).join(', ')}.`;
  }
  if (action === 'set') {
    if (typeof engine !== 'string' || typeof voice !== 'string') throw new Error('Engine and voice must be text');
    engine = engine.trim().toLowerCase();
    engine = ({ 'fish audio': 'fish', cloud: 'fish', local: 'kokoro', 'xtts v2': 'xtts', 'xtts-v2': 'xtts', coqui: 'xtts' })[engine] ?? engine;
    voice = voice.trim();
    if (engine && !['fish', 'kokoro', 'xtts'].includes(engine)) throw new Error('Supported TTS providers are Fish Audio, Kokoro and XTTS');
    if (typeof speed !== 'number' || !Number.isFinite(speed) || (speed !== 0 && (speed < 0.5 || speed > 2))) throw new Error('Local speech speed must be between 0.5 and 2');
    const target = engine || (voice ? /\.(wav|mp3|flac|ogg|m4a)$/i.test(voice) ? 'xtts' : 'kokoro' : config.tts);
    if (!engine && !voice && !speed) throw new Error('Nothing to change: give a provider, voice or speed');
    if (target === 'fish' && (voice || speed)) throw new Error('Local voice and speed settings apply to Kokoro or XTTS; choose a local engine to use them');
    if (target === 'fish' && !config.fish.apiKey) throw new Error('Fish Audio is not configured: add its API key before switching');
    if (target === 'kokoro') {
      // Load the local model before persisting a switch; a failed download leaves settings intact.
      const available = await voices();
      const selected = voice || config.kokoro.voice;
      if (!available.includes(selected)) throw new Error(`Unknown Kokoro voice: ${selected}. Ask to list voices`);
    }
    if (target === 'xtts') {
      if (!prepareXTTS) throw new Error('XTTS is not configured');
      if (voice && !(await xttsVoices()).includes(voice)) throw new Error('Unknown XTTS voice sample. Ask to list XTTS voices');
      await prepareXTTS({ ...config.xtts, ...(voice ? { reference: voice } : {}), ...(speed ? { speed } : {}) });
    }
    const patch = { ttsProvider: target };
    if (voice) patch[target === 'xtts' ? 'xttsReference' : 'kokoroVoice'] = voice;
    if (speed) patch[target === 'xtts' ? 'xttsSpeed' : 'kokoroSpeed'] = speed;
    updateSettings(patch);
    activity('settings', { message: `Voice: ${JSON.stringify(patch)}` });
  }
  return config.tts === 'xtts'
    ? `Speaking with XTTS (local voice cloning), sample ${config.xtts.reference || '(automatically selected from the sample folder)'}, language ${config.xtts.language}, speed ${config.xtts.speed}.`
    : config.tts === 'kokoro'
    ? `Speaking with Kokoro (local), voice ${config.kokoro.voice}, speed ${config.kokoro.speed}.`
    : `Speaking with Fish Audio (cloud), model ${config.fish.ttsModel}, voice ${config.fish.voiceId || '(default)'}.`;
}

export const ttsReady = (config) => config.tts === 'xtts' ? xttsAvailability(config.xtts).ready : config.tts === 'kokoro' || Boolean(config.fish.apiKey);
