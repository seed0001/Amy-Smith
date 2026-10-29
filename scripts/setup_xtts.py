"""Download the official, pinned XTTS-v2 inference assets without changing running services."""
import argparse
import json
import os
from pathlib import Path
import urllib.request

REVISION = "6c2b0d75eae4b7047358e3b6bd9325f857d43f77"
FILES = ["config.json", "vocab.json", "model.pth", "speakers_xtts.pth", "LICENSE.txt", "README.md", "samples/en_sample.wav"]

def download(directory):
    directory = Path(directory)
    for name in FILES:
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size:
            print(f"Already present: {name}", flush=True)
            continue
        url = f"https://huggingface.co/coqui/XTTS-v2/resolve/{REVISION}/{name}"
        partial = target.with_suffix(target.suffix + ".part")
        print(f"Downloading {name}...", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        partial.replace(target)
        print(f"Saved {name}: {target.stat().st_size:,} bytes", flush=True)
    (directory / "download.json").write_text(json.dumps({"repository": "coqui/XTTS-v2", "revision": REVISION, "files": FILES}, indent=2), encoding="utf-8")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default=str(Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local/share"))) / "NewChamp/XTTS/model"))
    download(parser.parse_args().model_dir)
