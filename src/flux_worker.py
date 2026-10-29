"""Local FLUX.2 [klein] image generation for Amy. Reads one JSON request per line on stdin and
answers one JSON line on stdout: {"id", "ok", "path"} with a PNG written to the requested file.
The pipeline loads once on the first request and stays in memory."""
import argparse
import json
import sys
import traceback

import torch
from diffusers import Flux2KleinPipeline
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
args = parser.parse_args()
pipe = None


def pick_gpu():
    """The ROCm wheels only carry kernels for some chips (gfx120X for the RX 9000 series), and HIP
    can also list the CPU's built-in Radeon graphics. Running on that one fails with
    hipErrorInvalidImage, so use the first GPU this PyTorch build was compiled for."""
    if not torch.cuda.is_available():
        return None
    built = {a.split(':')[0] for a in torch.cuda.get_arch_list()}
    for i in range(torch.cuda.device_count()):
        arch = getattr(torch.cuda.get_device_properties(i), 'gcnArchName', '').split(':')[0]
        if not built or not arch or arch in built:
            torch.cuda.set_device(i)
            return i
    found = ', '.join(f'{torch.cuda.get_device_name(i)} ({torch.cuda.get_device_properties(i).gcnArchName})'
                      for i in range(torch.cuda.device_count()))
    raise RuntimeError(f'No GPU matches this PyTorch build ({", ".join(sorted(built))}); found {found}')


gpu = None


def load():
    global pipe, gpu
    if pipe is None:
        gpu = pick_gpu()
        pipe = Flux2KleinPipeline.from_pretrained(args.model_dir, torch_dtype=torch.bfloat16)
        if gpu is not None:
            pipe.enable_model_cpu_offload(gpu_id=gpu)
    return pipe


def generate(req):
    p = load()
    refs = [Image.open(f).convert('RGB') for f in req.get('references') or []]
    image = p(
        prompt=req['prompt'],
        image=refs or None,
        width=int(req.get('width') or 1024),
        height=int(req.get('height') or 1024),
        guidance_scale=1.0,
        num_inference_steps=int(req.get('steps') or 4),
        generator=torch.Generator(device='cpu').manual_seed(int(req['seed'])) if req.get('seed') else None,
    ).images[0]
    image.save(req['out'], 'PNG')


def describe_failure(e):
    """GPU errors like hipErrorInvalidImage say nothing about where they happened, so name the
    device, the build's chips and the innermost code lines to make the next failure diagnosable."""
    try:
        device = f'{torch.cuda.get_device_name(gpu)} #{gpu} {torch.cuda.get_device_properties(gpu).gcnArchName}' if gpu is not None else 'cpu'
        built = ','.join(torch.cuda.get_arch_list()) or '?'
    except Exception:
        device, built = f'gpu #{gpu}', '?'
    frames = traceback.extract_tb(e.__traceback__)[-3:]
    where = ' < '.join(f'{f.filename.replace(chr(92), "/").split("/")[-1]}:{f.lineno} {f.name}' for f in reversed(frames))
    return f'device {device}; torch {torch.__version__} for {built}; at {where}'


for line in sys.stdin:
    req = json.loads(line)
    try:
        if req.get('action') == 'warmup':
            load()
        else:
            generate(req)
        reply = {'id': req['id'], 'ok': True, 'path': req.get('out'),
                 'device': torch.cuda.get_device_name(gpu) if gpu is not None else 'cpu'}
    except Exception as e:  # report every failure to Node instead of dying
        reply = {'id': req['id'], 'ok': False, 'error': f'{(str(e).splitlines() or [repr(e)])[0][:300]} [{describe_failure(e)}]'}
    sys.stdout.write(json.dumps(reply) + '\n')
    sys.stdout.flush()
