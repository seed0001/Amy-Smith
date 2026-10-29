"""Persistent private stdio worker. No listener, cloud calls, or voice uploads."""
import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import wave

parser = argparse.ArgumentParser()
parser.add_argument("--model-dir", required=True)
args = parser.parse_args()
model = None
conditioning = {}

def load():
    global model
    if model is not None:
        return model
    import torch
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    config = XttsConfig()
    config.load_json(str(Path(args.model_dir) / "config.json"))
    instance = Xtts(config)
    instance.load_checkpoint(config, checkpoint_dir=args.model_dir, eval=True)
    # The installed runtime is CPU-compatible on Windows/AMD. Do not reserve GPU memory
    # used by the running conversational models or silently download another backend.
    instance.cpu().eval()
    model = instance
    return instance

def voice_conditioning(instance, filename):
    reference = Path(filename)
    stat = reference.stat()
    key = (str(reference.resolve()), stat.st_mtime_ns, stat.st_size)
    if key not in conditioning:
        # Normalize all supported source containers before torch reads them. This also validates
        # the sample on provider selection and avoids platform-specific MP3/M4A decoder issues.
        with tempfile.TemporaryDirectory(prefix="champ-xtts-reference-") as directory:
            normalized = Path(directory) / "reference.wav"
            converted = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(reference), "-t", "30", "-ac", "1", "-ar", "22050", str(normalized)], capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if converted.returncode:
                raise ValueError("The XTTS reference audio could not be decoded")
            conditioning.clear()
            conditioning[key] = instance.get_conditioning_latents(audio_path=[str(normalized)])
    return conditioning[key]

def handle(request):
    import torch
    instance = load()
    if request.get("action") == "warmup":
        if request.get("reference"):
            with torch.inference_mode():
                voice_conditioning(instance, request["reference"])
        return {"ready": True, "device": "cpu"}
    if request.get("action") != "synthesize":
        raise ValueError("Unknown XTTS action")
    text = request.get("text", "").strip()
    if not text or len(text) > 4000:
        raise ValueError("XTTS text must contain 1 to 4000 characters")
    language = request.get("language", "en")
    if language not in instance.config.languages:
        raise ValueError("Unsupported XTTS language")
    speed = request.get("speed", 1)
    if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2:
        raise ValueError("XTTS speed must be between 0.5 and 2")
    with torch.inference_mode():
        latent, embedding = voice_conditioning(instance, request["reference"])
        result = instance.inference(text, language, latent, embedding, speed=speed, enable_text_splitting=True)
    import numpy as np
    pcm = (np.clip(np.asarray(result["wav"], dtype=np.float32), -1, 1) * 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(pcm)
    return {"audio": base64.b64encode(output.getvalue()).decode("ascii"), "sampleRate": 24000}

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        # Coqui and its dependencies print progress to stdout; keep protocol output separate.
        with contextlib.redirect_stdout(sys.stderr):
            result = handle(request)
        reply = {"id": request.get("id"), "ok": True, **result}
    except Exception as error:
        reply = {"id": request.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"[:1500]}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
