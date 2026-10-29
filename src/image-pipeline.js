// Independent entry points: ordinary pictures never receive companion identity assets.
export function isSelfImageRequest(text, name = '') {
  const value = String(text ?? '');
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subject = `(?:you(?:rself)?|your character|${escaped || '(?!)'})`;
  return new RegExp(`\\b(?:image|picture|photo|portrait|drawing|art|painting|illustration)\\s+(?:of|about|featuring)\\s+${subject}\\b|\\b(?:draw|paint|depict|illustrate)\\s+${subject}\\b|\\byour\\s+selfie\\b|\\b(?:send|take|make|create|generate|show)(?: me)?(?: a)? selfie\\b(?!\\s+of\\s+(?!you\\b|yourself\\b))|\\byou\\s+(?:wearing|standing|sitting|posing)\\b`, 'i').test(value);
}

export function directImageIntent(text, rows = [], name = '') {
  if (isSelfImageRequest(text, name)) return 'self';
  const value = String(text ?? '');
  // Recover simple contextual image follow-ups from successful saved tool evidence, without
  // another LLM call. A fresh explicit subject takes precedence over earlier images.
  const followup = /\b(make it|draw it|render it|do it|another one|same (?:image|picture|pose|style)|try again|redo (?:it|that)|this time|different (?:angle|style))\b/i.test(value);
  if (followup) for (const row of [...rows].reverse()) {
    const tools = String(row.tools || '');
    if (/generate_self_image\b[^;]*: ok|look (?:new|setup)\b[^;]*: ok/.test(tools)) return 'self';
    if (/generate_image\b[^;]*: ok/.test(tools)) return 'general';
  }
  if (/\b(draw|paint|illustrate|generate|create|make|show)\b.{0,70}\b(image|picture|photo|portrait|art|illustration|painting)\b|^\s*(?:please\s+)?(?:draw|paint|illustrate)\b/i.test(value)) return 'general';
  return null;
}

export function imageRouteError(tool, args, ctx) {
  if (ctx.classifierDirect && tool === 'look' && args?.action === 'setup' && !/\b(set\s*up|create|replace|rebuild|reset|invent|design|change)\b.{0,45}\b(reference|identity|appearance|look|face|body)\b/i.test(String(ctx.userText || ''))) return 'Creating or replacing identity assets needs an explicit appearance setup request. Missing self-image assets must be restored, not silently replaced.';
  const requestedSelf = isSelfImageRequest(ctx.userText, ctx.character?.name);
  const promptSelf = isSelfImageRequest(args?.prompt, ctx.character?.name);
  const general = ctx.imageIntent === 'general' && !requestedSelf;
  if (general && (tool === 'generate_self_image' || (tool === 'look' && ['new', 'setup'].includes(args?.action)))) return 'This request is for a general image. Call generate_image; do not use or change the companion identity assets.';
  if (general && tool === 'generate_image' && promptSelf) return 'The user requested a general image. Remove the companion from the prompt and use generate_image for the requested subject only.';
  const self = ctx.imageIntent === 'self' || requestedSelf || promptSelf;
  if (tool === 'generate_image' && self) return 'This is a picture of the companion. Call generate_self_image instead; generate_image never uses her identity assets.';
  if (tool === 'look' && args?.action === 'setup' && ctx.imageIntent === 'self') return 'A self-image request does not authorize creating or replacing identity assets. Use generate_self_image with the existing assets; if they are missing, explain that they need restoring.';
  if (tool === 'look' && args?.action === 'new' && ctx.imageIntent === 'self') return 'Use generate_self_image for this requested picture of the companion. The look new action changes the active outfit/profile and is reserved for appearance management.';
  return null;
}

export async function generateGeneralImage(prompt, { generateImage }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty image prompt');
  return generateImage(prompt.trim(), []);
}

export async function generateSelfImage(prompt, { generateImage, referenceImage, activeImage, name }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty self-image prompt');
  const reference = referenceImage();
  if (!reference) throw new Error('Her saved identity reference sheet is missing. Restore it or explicitly set up her appearance with look; do not invent a replacement or fall back to generate_image');
  const active = activeImage?.();
  const references = [reference, ...(active ? [active] : [])];
  return generateImage(`Create an image of ${name || 'the companion'} using the supplied saved identity assets. The first reference is the authoritative identity sheet: preserve her face, hair, skin tone, body type and proportions. ${active ? 'The second reference is her current saved look; use it as supporting identity and clothing context, unless the request specifies different clothing. ' : ''}Follow the requested scene, pose, composition and art style without changing her identity. Produce one image, not a reference sheet or collage. Request: ${prompt.trim()}`, references);
}
