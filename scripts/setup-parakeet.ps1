$ErrorActionPreference = 'Stop'
$parakeetRuntime = Join-Path $env:LOCALAPPDATA 'NewChamp\Parakeet'
$parakeetPython = Join-Path $parakeetRuntime 'venv\Scripts\python.exe'
$parakeetModel = Join-Path $parakeetRuntime 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
New-Item -ItemType Directory -Path $parakeetRuntime -Force | Out-Null
if (-not (Test-Path -LiteralPath $parakeetPython)) {
  python -m venv (Join-Path $parakeetRuntime 'venv')
  if ($LASTEXITCODE) { throw 'Python environment creation failed' }
}
& $parakeetPython -m pip install 'sherpa-onnx==1.13.8' 'numpy>=2,<3'
if ($LASTEXITCODE) { throw 'Parakeet runtime installation failed' }
if (-not (Test-Path -LiteralPath (Join-Path $parakeetModel 'encoder.int8.onnx'))) {
  $parakeetArchive = Join-Path $parakeetRuntime 'model.tar.bz2'
  curl.exe -L --fail --show-error -o $parakeetArchive https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
  if ($LASTEXITCODE) { throw 'Parakeet model download failed' }
  tar -xf $parakeetArchive -C $parakeetRuntime
  if ($LASTEXITCODE) { throw 'Parakeet model extraction failed' }
}
foreach ($parakeetFile in @('encoder.int8.onnx','decoder.int8.onnx','joiner.int8.onnx','tokens.txt')) {
  if (-not (Test-Path -LiteralPath (Join-Path $parakeetModel $parakeetFile))) { throw "Missing Parakeet file: $parakeetFile" }
}
Write-Output 'Parakeet v3 installed locally. Choose Parakeet in dashboard Settings > Voice > Speech recognition engine. Amy was not restarted and the active provider was not changed.'
