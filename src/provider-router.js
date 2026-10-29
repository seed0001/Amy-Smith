import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { chatgptAuth } from './chatgpt-auth.js';
import { activity, bus } from './events.js';
import { createProviderFailover } from './provider-failover.js';
import { createProviderNarration } from './provider-narration.js';

const narration = createProviderNarration({ enabled: () => config.providerFailoverNarration, background: (event) => bus.emit('provider-switch-narration', event) });
export const withProviderNarration = narration.run;
const FILE = path.join(DATA_DIR, 'provider-failover.json');
export const providerRouter = createProviderFailover({
  preferred: () => config.brain,
  enabled: () => config.providerFailover,
  cooldownMs: () => config.providerRetryMinutes * 60000,
  model: (provider) => provider === 'chatgpt' ? config.chatgpt.model : provider === 'openrouter' ? config.openrouter.model : provider === 'mistral' ? config.mistral.model : config.ollama.model,
  configured: (provider) => {
    if (provider === 'openrouter') return Boolean(config.openrouter.apiKey && config.openrouter.model);
    if (provider === 'mistral') return Boolean(config.mistral.apiKey && config.mistral.model);
    if (provider === 'chatgpt') { try { const s = chatgptAuth.status(); return Boolean(s.account?.planEnabled && !s.account.needsSignIn && config.chatgpt.model); } catch { return false; } }
    return Boolean(config.ollama.model);
  },
  load: () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; } catch { return {}; } },
  save: (state) => { const temp = `${FILE}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(state, null, 2)); renameSync(temp, FILE); },
  onSwitch: async (event) => {
    activity('provider-switch', { ...event, preferred: config.brain });
    if (!config.providerFailoverNarration) return;
    try {
      await narration.announce(event);
    } catch (err) { activity('error', { where: 'provider switch narration', message: err.message }); }
  },
});

export function activeReplyProvider() { return config.providerFailover ? providerRouter.status().active?.provider || config.brain : config.brain; }
export function activeReplyModel() { const provider = activeReplyProvider(); return provider === 'chatgpt' ? config.chatgpt.model : provider === 'openrouter' ? config.openrouter.model : provider === 'mistral' ? config.mistral.model : config.ollama.model; }
