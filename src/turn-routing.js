export async function chooseTurnPlan({ enabled = true, cue = false, hasActions = true, plan, now = performance.now.bind(performance) }) {
  const routingMode = enabled ? 'classifier_advisory' : 'direct';
  if (cue || !hasActions || !enabled) return { search: null, tools: [], routingMode, classifierMs: 0 };
  const started = now();
  const result = await plan();
  return { ...result, routingMode, classifierMs: Math.max(0, now() - started) };
}

export function controlTurnClassifier({ action }, { config, updateSettings, activity }) {
  if (!['on', 'off', 'status'].includes(action)) throw new Error('Classifier action must be on, off or status');
  if (action !== 'status') {
    updateSettings({ turnClassifierEnabled: action === 'on' });
    activity('settings', { message: `Turn classification pass turned ${action}` });
  }
  return config.turnClassifierEnabled
    ? 'The turn classification pass is on. It advises the main model before replies, starting with the next turn.'
    : 'The turn classification pass is off. Starting with the next turn, the main model chooses its own tools directly. Tool permissions and checks still apply. You can ask to turn classification back on at any time.';
}
