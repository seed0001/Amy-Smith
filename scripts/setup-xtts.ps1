$ErrorActionPreference = 'Stop'
$xttsRuntime = Join-Path $env:LOCALAPPDATA 'NewChamp\XTTS'
$xttsPython = Join-Path $xttsRuntime 'venv\Scripts\python.exe'
New-Item -ItemType Directory -Path $xttsRuntime -Force | Out-Null
if (-not (Test-Path -LiteralPath $xttsPython)) { python -m venv (Join-Path $xttsRuntime 'venv') }
& $xttsPython -m pip install 'torch==2.8.0' 'torchaudio==2.8.0' --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE) { throw 'PyTorch installation failed' }
& $xttsPython -m pip install 'coqui-tts==0.28.0'
if ($LASTEXITCODE) { throw 'Coqui TTS installation failed' }
& $xttsPython (Join-Path $PSScriptRoot 'setup_xtts.py') --model-dir (Join-Path $xttsRuntime 'model')
if ($LASTEXITCODE) { throw 'XTTS model download failed' }
Write-Output 'XTTS installed. Put your voice sample in data\voices\xtts\reference.wav. This script does not restart Amy or change her active provider.'
