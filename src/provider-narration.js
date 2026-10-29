import { AsyncLocalStorage } from 'node:async_hooks';

export function createProviderNarration({ enabled = () => true, background = () => {} } = {}) {
  const storage = new AsyncLocalStorage();
  const run = (speak, task) => {
    const context = { speak, active: true };
    return storage.run(context, async () => { try { return await task(); } finally { context.active = false; } });
  };
  const announce = async (event) => {
    if (!enabled()) return;
    const context = storage.getStore();
    if (context?.active && context.speak) await context.speak(event.message);
    else background(event);
  };
  return { run, announce };
}
