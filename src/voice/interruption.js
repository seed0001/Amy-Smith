// Match direct commands rather than mentions such as "she told him to stop talking".
export function isStopRequest(text) {
  return /^\s*(?:(?:hey|okay|ok|please|amy|champ)[,\s]+)*(?:stop(?:\s+(?:talking|speaking))?|be quiet|shut up|enough|give it a rest|leave me alone)(?:[.!?,\s]*(?:please|now|for (?:a bit|a minute)|i(?:'m| am) done))*[.!?\s]*$/i.test(text);
}

export function continuationReady(session, now = Date.now()) {
  return !session.destroyed && !session.pending && !session.speaking && !session.pumping &&
    !session.speech.length && !session.listening.size && !session.transcribing &&
    now - Math.max(session.lastHeard, session.lastSpoke ?? 0) >= 8000;
}
