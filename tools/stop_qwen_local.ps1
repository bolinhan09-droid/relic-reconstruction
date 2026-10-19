$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$record = Join-Path $projectRoot 'work/local-qwen/runtime.json'
if (-not (Test-Path -LiteralPath $record)) { Write-Output 'No project-owned Qwen service record.'; exit 0 }
$state = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
$child = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
if ($null -eq $child) { Write-Output 'Qwen service is already stopped.'; exit 0 }
if ($child.Path -ne $state.executable -or $child.StartTime.ToUniversalTime().Ticks -ne $state.startTimeUtcTicks) { throw 'PID no longer matches this project service; no process was stopped.' }
Stop-Process -Id $child.Id
Write-Output 'Project Qwen service stopped; model files retained.'
