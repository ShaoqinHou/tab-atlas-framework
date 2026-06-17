$ErrorActionPreference = "Stop"
$env:TABATLAS_PORT = if ($env:TABATLAS_PORT) { $env:TABATLAS_PORT } else { "9787" }
npm run dev
