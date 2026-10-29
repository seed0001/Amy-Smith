// Separate from the reply stream: a completed sub-agent can deliver while another turn runs.
export function watchGeneration(conversation, makeBubble) {
  let after = 0, busy = false;
  const poll = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch(`/api/generation-deliveries?conversation=${encodeURIComponent(conversation)}&after=${after}`);
      if (!response.ok) return;
      for (const record of await response.json()) {
        const box = makeBubble(record.message || (record.kind === 'image' ? 'Your image is ready.' : record.kind === 'audio' ? 'Your music is ready.' : 'Your file is ready.'), record.characterName);
        if (record.url) {
          if (record.kind === 'image') {
            const image = document.createElement('img'); image.className = 'gen'; image.alt = record.name || 'Generated image'; image.src = record.url; box.append(image);
          } else if (record.kind === 'audio') {
            const audio = document.createElement('audio'); audio.controls = true; audio.src = record.url; box.append(audio);
          }
          const link = document.createElement('a'); link.href = record.url; link.download = record.name || 'download'; link.className = 'file'; link.textContent = record.name || 'Download'; box.append(link);
        }
        after = record.id;
      }
    } catch { /* Retry on the next poll after a connection interruption. */ }
    finally { busy = false; }
  };
  poll();
  const timer = setInterval(poll, 3000);
  return () => clearInterval(timer);
}
