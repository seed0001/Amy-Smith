"""Persistent, offline Parakeet v3 INT8 recognition. JSON lines on stdio."""
import argparse
import base64
import contextlib
import json
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
parser.add_argument('--threads', type=int, default=4)
args = parser.parse_args()

# Native runtime diagnostics belong on stderr, never the response channel.
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    import sherpa_onnx
    model_dir = Path(args.model_dir)
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model_dir / 'encoder.int8.onnx'),
        decoder=str(model_dir / 'decoder.int8.onnx'),
        joiner=str(model_dir / 'joiner.int8.onnx'),
        tokens=str(model_dir / 'tokens.txt'),
        num_threads=args.threads, sample_rate=16000,
        model_type='nemo_transducer', provider='cpu',
        decoding_method='greedy_search',
    )

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        pcm = base64.b64decode(request['pcm'], validate=True)
        if not pcm or len(pcm) % 6 or len(pcm) > 48000 * 2 * 120:
            raise ValueError('Expected up to 120 seconds of 48kHz mono PCM16 audio')
        started = time.perf_counter()
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32)
        samples = samples.reshape(-1, 3).mean(axis=1) / 32768.0
        with contextlib.redirect_stdout(sys.stderr):
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, samples)
            recognizer.decode_stream(stream)
        reply = {'id': request['id'], 'ok': True, 'text': stream.result.text,
                 'ms': round((time.perf_counter() - started) * 1000)}
    except Exception as error:
        reply = {'id': request.get('id'), 'ok': False, 'error': str(error)}
    print(json.dumps(reply, ensure_ascii=True), flush=True)
