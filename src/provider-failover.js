const LABEL = { openrouter: 'OpenRouter', chatgpt: 'OpenAI ChatGPT', mistral: 'Mistral', ollama: 'the local model' };
const CLOUD = ['openrouter', 'chatgpt', 'mistral'];

export function providerRequestError(payload, provider, status = 0) {
  const detail = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const error = new Error(`${LABEL[provider] || provider}: ${typeof detail?.message === 'string' ? detail.message.slice(0, 500) : `request failed (${status})`}`);
  error.provider = provider; error.code = detail?.code ?? ''; error.status = status || (Number(detail?.code) || 0);
  return error;
}

export function isCreditLimit(error, provider) {
  const code = String(error?.code ?? '');
  if (provider === 'chatgpt') return code === 'subscription_sharing_usage_limit_exceeded';
  // Mistral's free plan answers 429 both for the per-second rate limit (just wait) and for the
  // monthly allowance (switch providers); only the allowance counts as a usage limit.
  if (provider === 'mistral') return Number(error?.status) === 402 || /quota|monthly|billing|credit|payment|usage limit/i.test(`${code} ${error?.message || ''}`);
  if (provider !== 'openrouter') return false;
  const status = Number(error?.status ?? error?.statusCode ?? code);
  return status === 402 || ['insufficient_credits', 'insufficient_balance', 'credit_limit_exceeded'].includes(code) || ((status === 429 || code === 'insufficient_quota') && /credit|balance|insufficient.quota|spend.limit|billing/i.test(`${code} ${error?.message || ''}`));
}

export function createProviderFailover({ preferred, enabled = () => true, configured = () => true, model = () => '', load = () => ({}), save = () => {}, onSwitch = async () => {}, clock = Date.now, cooldownMs = () => 15 * 60000 }) {
  const initial = load();
  const state = { blocked: initial.blocked || {}, active: initial.active || null, lastSwitch: initial.lastSwitch || null };
  const persist = () => save(structuredClone(state));
  function candidates() {
    const primary = preferred();
    const order = !enabled() || primary === 'ollama' ? [primary] : [primary, ...CLOUD.filter((p) => p !== primary), 'ollama'];
    return order.filter((p) => !enabled() || p === 'ollama' || (configured(p) && !(state.blocked[p]?.until > clock())));
  }
  function markLimit(provider, error) {
    state.blocked[provider] = { at: clock(), until: clock() + cooldownMs(), code: String(error.code || error.status || 'credit_limit'), reason: 'credits or plan/app usage limit reached' };
    persist();
  }
  async function activate(provider) {
    const previous = state.active?.provider || preferred();
    const changed = previous !== provider;
    state.active = { provider, model: model(provider), at: clock() };
    delete state.blocked[provider];
    if (changed) {
      const bothLimited = CLOUD.filter((p) => configured(p)).every((p) => state.blocked[p]?.until > clock());
      const recovering = !state.blocked[previous];
      const message = provider === 'ollama'
        ? `${preferred() === 'ollama' ? 'The local model is selected.' : bothLimited ? 'All the cloud providers have reached their credit or usage limits.' : 'The cloud fallback is unavailable.'} I'm switching to the local model so we can keep talking.`
        : recovering ? `I'm switching back to ${LABEL[provider]} now that it's available.`
          : `${LABEL[previous]} has reached a credit or usage limit. I'm switching to ${LABEL[provider]} so we can keep talking.`;
      state.lastSwitch = { from: previous, to: provider, model: model(provider), at: clock(), message };
      persist();
      await onSwitch({ ...state.lastSwitch, blocked: structuredClone(state.blocked) });
    } else persist();
  }
  async function execute(run) {
    let last;
    for (const provider of candidates()) {
      try { const value = await run(provider); await activate(provider); return value; }
      catch (error) { last = error; if (!enabled() || !isCreditLimit(error, provider)) throw error; markLimit(provider, error); }
    }
    throw last || new Error('No configured reply provider is available');
  }
  async function* stream(messages, run) {
    let last, partial = '';
    for (const provider of candidates()) {
      const history = partial ? [...messages, { role: 'assistant', content: partial }, { role: 'user', content: '(A provider usage limit interrupted that reply. Continue only the unfinished answer without repeating what was already said. Previously completed tool results above are still valid; do not repeat their actions.)' }] : messages;
      const metadata = []; let attemptText = '', activated = false;
      try {
        const result = await run(provider, history);
        for await (const part of result) {
          const content = part.message?.content || '';
          if (content) { if (!activated) { await activate(provider); activated = true; } attemptText += content; yield { message: { content }, provider, model: model(provider) }; }
          // Never expose tool calls from an attempt that subsequently fails.
          if (part.message?.tool_calls?.length || part.responseOutput || part.usage || part.prompt_eval_count != null) metadata.push(part);
        }
        if (!activated) await activate(provider);
        for (const part of metadata) yield { ...part, provider, model: model(provider), message: { ...part.message, content: '' }, ...(partial && part.responseOutput ? { responseOutput: [{ role: 'assistant', content: partial }, ...part.responseOutput] } : {}) };
        return;
      } catch (error) {
        last = error;
        if (!enabled() || !isCreditLimit(error, provider)) throw error;
        partial += attemptText; markLimit(provider, error);
      }
    }
    throw last || new Error('No configured reply provider is available');
  }
  return { execute, stream, status: () => ({ preferred: preferred(), enabled: enabled(), ...structuredClone(state) }), reset: () => { state.blocked = {}; persist(); return { preferred: preferred(), ...structuredClone(state) }; } };
}
