param(
    [ValidateRange(1024,65535)][int]$Port = 8188,
    [ValidateRange(2048,16384)][int]$Context = 4096,
    [ValidateRange(0,99)][int]$GpuLayers = 99
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $projectRoot 'tools/runtime/llama-b11669-cuda12'
$executable = Join-Path $runtime 'llama-server.exe'
$model = Join-Path $projectRoot 'models/qwen3.5-4b/qwen3.5-4b-q4_k_m.gguf'
$projector = Join-Path $projectRoot 'models/qwen3.5-4b/mmproj-qwen3.5-4b-bf16.gguf'
$logs = Join-Path $projectRoot 'work/local-qwen'
foreach ($required in @($executable, $model, $projector)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing local file: $required. Run tools/install_qwen_local.py first." }
}
New-Item -ItemType Directory -Force -Path $logs | Out-Null
try {
    $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 2
    if ($existing.data.id -contains 'qwen3.5-4b-local') {
        Write-Output "Qwen is already available: http://127.0.0.1:$Port/v1"
        exit 0
    }
    throw "Port $Port already serves another model."
} catch {
    if ($_.Exception.Message -like '*already serves another model*') { throw }
}
$serverArguments = @(
    '-m', ('"' + $model + '"'), '--mmproj', ('"' + $projector + '"'),
    '--host', '127.0.0.1', '--port', "$Port", '--alias', 'qwen3.5-4b-local',
    '--ctx-size', "$Context", '--parallel', '1', '--n-gpu-layers', "$GpuLayers",
    '--flash-attn', 'on', '--batch-size', '512', '--ubatch-size', '128',
    '--image-min-tokens', '256', '--image-max-tokens', '1024',
    '--jinja', '--reasoning', 'off', '--no-webui', '--no-agent', '--no-ui-mcp-proxy',
    '--timeout', '180'
)
$child = Start-Process -FilePath $executable -ArgumentList $serverArguments -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'server.stdout.log') -RedirectStandardError (Join-Path $logs 'server.stderr.log')
$state = @{ pid = $child.Id; startTimeUtcTicks = $child.StartTime.ToUniversalTime().Ticks; executable = $executable; baseUrl = "http://127.0.0.1:$Port/v1"; model = 'qwen3.5-4b-local'; context = $Context; gpuLayers = $GpuLayers; externalNetworkRequired = $false }
$state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'runtime.json') -Encoding UTF8
Write-Output "Starting local Qwen (PID $($child.Id)); API http://127.0.0.1:$Port/v1; model qwen3.5-4b-local."
Write-Output "Readiness: GET http://127.0.0.1:$Port/health. Logs: $logs"
