$ErrorActionPreference = 'Stop'
# Local FLUX.2 [klein] runtime for an AMD Radeon RX 9000 (gfx120X) GPU: PyTorch from AMD's ROCm
# wheels plus diffusers. The model itself stays in C:\Users\<you>\FLUX2-klein-4B (outside OneDrive).
$fluxRuntime = Join-Path $env:LOCALAPPDATA 'NewChamp\Flux'
$fluxPython = Join-Path $fluxRuntime 'venv\Scripts\python.exe'
New-Item -ItemType Directory -Path $fluxRuntime -Force | Out-Null
if (-not (Test-Path -LiteralPath $fluxPython)) { py -3.13 -m venv (Join-Path $fluxRuntime 'venv') }
& $fluxPython -m pip install --upgrade pip
& $fluxPython -m pip install torch torchvision --index-url https://rocm.nightlies.amd.com/v2/gfx120X-all/
if ($LASTEXITCODE) { throw 'PyTorch (ROCm) installation failed' }
& $fluxPython -m pip install 'git+https://github.com/huggingface/diffusers' transformers accelerate safetensors pillow
if ($LASTEXITCODE) { throw 'diffusers installation failed' }
& $fluxPython -c "import torch; from diffusers import Flux2KleinPipeline; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none (CPU only, slow)')"
if ($LASTEXITCODE) { throw 'Flux runtime check failed' }
Write-Output 'Flux installed. Restart Amy, then tell her "use Flux for images".'
