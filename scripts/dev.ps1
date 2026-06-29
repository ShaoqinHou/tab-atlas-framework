$ErrorActionPreference = "Stop"

if (-not $env:TABATLAS_RUNTIME_PROFILE) {
    throw "TABATLAS_RUNTIME_PROFILE is required. Use scripts/start-tabatlas.ps1 for the release launcher."
}
if (-not $env:TABATLAS_PORT) {
    throw "TABATLAS_PORT is required."
}
if (-not $env:TABATLAS_DB) {
    throw "TABATLAS_DB is required."
}

npm run dev
