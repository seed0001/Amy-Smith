# Local Parakeet speech recognition

Parakeet TDT 0.6b v3 is an optional hearing engine, separate from the TTS speaking voice. This integration uses the sherpa-onnx INT8 conversion of NVIDIA's model with CPU inference on Windows, not the hosted Hugging Face Space. Audio is not uploaded. It automatically recognizes supported languages and preserves short phrases such as "okay" rather than applying Whisper's noise-text filter.

Install: `powershell -File scripts/setup-parakeet.ps1`. Runtime and model files live in `%LOCALAPPDATA%\NewChamp\Parakeet`. The installer neither restarts Amy nor changes the provider.

After loading the code through a normal manual restart, open dashboard Settings > Voice > Speech recognition engine, select Parakeet, and Save. Selection is persisted as `sttProvider` and takes effect for subsequent utterances without another restart. Both Discord voice and dashboard microphone transcription use the shared engine. Select the previous engine in the same menu to switch back. The current engine appears in dashboard status.

One hidden Python worker loads the model once; overlapping utterances queue sequentially. Requests time out after two minutes, accept at most two minutes of audio, and report errors without silently switching to another model during the test. The existing voice silence/utterance thresholds still apply. Optional environment settings: `PARAKEET_RUNTIME_DIR`, `PARAKEET_PYTHON`, `PARAKEET_MODEL_DIR`, `PARAKEET_THREADS` (default 4).

Smoke test on this PC: bundled `test_wavs/en.wav`, 3.845 seconds, converted to the receiver's 48kHz mono PCM16 format and passed through the Node worker adapter. Transcript: "Ask not what your country can do for you. Ask what you can do for your country." Cold total about 1.49 seconds; warm total about 117 ms. These are sample timings, not microphone accuracy or live conversation guarantees.

Sources and attribution: [NVIDIA model and CC BY 4.0 license](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [sherpa-onnx conversion and usage](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html). The installed model is converted to ONNX and quantized to INT8; results may differ from the original floating-point demo.
