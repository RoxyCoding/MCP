$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & uv sync --locked --python 3.12
    if ($LASTEXITCODE -ne 0) { throw '依存関係のインストールに失敗しました。' }
    if (-not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath '.env.example' -Destination '.env'
    }
    & .\.venv\Scripts\python.exe configure.py
    if ($LASTEXITCODE -ne 0) { throw '接続設定の生成に失敗しました。' }
} finally {
    Pop-Location
}
