param(
    [string]$Target = 'D:\下载\文档\Obsidian\往昔的涟漪\.obsidian\plugins\lucias-marginbook'
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $sourceRoot
$resolvedTarget = (Resolve-Path -LiteralPath $Target).Path
$installed = Get-Content -LiteralPath (Join-Path $resolvedTarget 'manifest.json') -Raw | ConvertFrom-Json
if ($installed.id -ne 'lucias-marginbook') { throw 'Target is not Lucia''s MarginBook.' }
$backupFolder = Join-Path $workspaceRoot ('tools\marginbook-picker-backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
foreach ($name in @('main.js', 'manifest.json')) {
    Copy-Item -LiteralPath (Join-Path $resolvedTarget $name) -Destination (Join-Path $backupFolder $name)
}
foreach ($name in @('main.js', 'manifest.json')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $resolvedTarget $name)
    if ((Get-FileHash -LiteralPath (Join-Path $sourceRoot $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $resolvedTarget $name)).Hash) {
        throw "Deployment hash mismatch: $name; original files preserved at $backupFolder"
    }
}
[pscustomobject]@{
    Version = (Get-Content -LiteralPath (Join-Path $resolvedTarget 'manifest.json') -Raw | ConvertFrom-Json).version
    Target = $resolvedTarget
    Backup = $backupFolder
    SHA256 = (Get-FileHash -LiteralPath (Join-Path $resolvedTarget 'main.js')).Hash
} | ConvertTo-Json
