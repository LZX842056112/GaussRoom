param([switch]$Native, [string]$LogDir = 'runs/workbench-tests')
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '../..'))
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$env:PYTHONUTF8 = '1'
$taskTests = (Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object Name -Match '^test_(assistance.*|annotation|quality|quality_ui|viewer_render)\.mjs$').FullName
$ErrorActionPreference = 'Continue'
& node --test @taskTests *> (Join-Path $LogDir 'node.log')
$taskCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Get-Content (Join-Path $LogDir 'node.log') -Tail 10
if ($taskCode -ne 0) { exit $taskCode }
if ($Native) { $env:GAUSSROOM_NATIVE_TEST = '1' }
$ErrorActionPreference = 'Continue'
& '.venv/Scripts/python.exe' -m unittest discover -s tools/workbench/py -p 'test_*.py' -v *> (Join-Path $LogDir 'python.log')
$taskCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Get-Content (Join-Path $LogDir 'python.log') -Tail 8
exit $taskCode
