$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw '先にsetup.ps1を実行してください。' }
& $python (Join-Path $PSScriptRoot 'server.py')
exit $LASTEXITCODE
