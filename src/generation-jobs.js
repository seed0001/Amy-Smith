export function isGenerationTool(name, args = {}) {
  return ['generate_image', 'generate_self_image', 'generate_music'].includes(name) || (name === 'look' && ['setup', 'new'].includes(args.action));
}

export const toolQueued = result => /^\[[\w-]+: queued\]/.test(String(result));

export function createGenerationDispatcher({ startTask, runTool, completed = () => {} }) {
  const requests = new Map();
  let outstanding = 0, active = 0;
  const waiting = [];
  return (name, args, ctx) => {
    const key = JSON.stringify([ctx.turn, ctx.conversation, name, args]);
    const existing = ctx.turn && requests.get(key);
    if (existing) return existing;
    if (outstanding >= 12) throw new Error('Generation queue is full. Wait for an existing job to finish before starting another.');
    outstanding++;
    const snapshot = { ...ctx, perms: { ...ctx.perms }, character: ctx.character && { ...ctx.character }, generationJob: true };
    const task = startTask({
      title: `${name === 'generate_music' ? 'Music' : name === 'look' ? 'Appearance' : 'Image'} generation`,
      conversation: ctx.conversation,
      execute: async task => {
        if (active >= 2) await new Promise(resolve => waiting.push(resolve));
        else active++;
        try {
        if (task.cancel) throw new Error('Generation task cancelled');
        snapshot.generationCancelled = () => task.cancel;
        // Every delivery uses a durable destination, not an array or stream owned by a reply.
        for (const fn of ['sendHere', 'showImage', 'showAudio']) {
          const destination = fn === 'sendHere' ? ctx.sendBackground || ctx.sendHere : ctx[fn];
          if (destination) snapshot[fn] = async (...values) => {
            if (task.cancel) throw new Error('Generation task cancelled before delivery');
            return destination(...values);
          };
        }
        const result = await runTool(name, args, snapshot);
        task.actions.push(name);
        task.steps = 1;
        if (/^\[[\w-]+: error/.test(String(result))) throw new Error(String(result));
        return result;
        } finally {
          outstanding--;
          const next = waiting.shift();
          if (next) next(); else active--;
        }
      },
      notify: async (text, task) => {
        await completed({ name, args, ctx: snapshot, task, text });
        await ctx.notify?.(text);
      },
    });
    const receipt = `Queued generation sub-agent #${task.id}. It is still working; no artifact is ready yet. Keep talking with the user. The result or failure will be delivered here separately. Do not call the tool again to wait or claim it is finished.`;
    if (ctx.turn) {
      requests.set(key, receipt);
      if (requests.size > 500) requests.delete(requests.keys().next().value);
    }
    return receipt;
  };
}
