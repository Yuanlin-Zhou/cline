# Run from any directory. Defaults to the repository containing this script.
# Example: .\sync-sdk-dist.ps1 -RepoRoot 'D:\workspace\cline'
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoRoot = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-PlainDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Directory not found: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Symbolic link/junction detected: $Path. No changes made; check its target before copying."
    }
}

$root = (Resolve-Path -LiteralPath $RepoRoot).Path
$names = @('shared', 'llms', 'agents', 'core', 'sdk')
$modules = Join-Path $root 'node_modules'
$scope = Join-Path $modules '@cline'
Assert-PlainDirectory $modules
Assert-PlainDirectory $scope

# Validate every package before changing any destination.
$jobs = @(
    foreach ($name in $names) {
        $source = Join-Path $root "sdk\packages\$name\dist"
        $package = Join-Path $scope $name
        $target = Join-Path $package 'dist'
        Assert-PlainDirectory $source
        Assert-PlainDirectory $package
        if (-not (Test-Path -LiteralPath (Join-Path $source 'index.js') -PathType Leaf)) {
            throw "Missing build output: $source\index.js. Build the SDK first."
        }
        if (-not (Test-Path -LiteralPath (Join-Path $package 'package.json') -PathType Leaf)) {
            throw "Missing package.json: $package. Copy/install the complete package first."
        }
        if (Test-Path -LiteralPath $target) {
            Assert-PlainDirectory $target
        }
        # Reject nested links too, so the staged copy contains real build files.
        $links = @(Get-ChildItem -LiteralPath $source -Recurse -Force |
            Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
        if ($links.Count -gt 0) {
            throw "Build output contains symbolic links/junctions: $source"
        }
        [PSCustomObject]@{ Name = $name; Source = $source; Target = $target }
    }
)

if (-not $PSCmdlet.ShouldProcess($scope, 'Back up and replace dist for shared, llms, agents, core, sdk')) {
    return
}

$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$backupRoot = Join-Path $root ".sdk-dist-backups\$stamp"
$stageRoot = Join-Path $backupRoot '_staging'
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

# Finish all potentially expensive copies before moving existing dist folders.
foreach ($job in $jobs) {
    Copy-Item -LiteralPath $job.Source -Destination (Join-Path $stageRoot $job.Name) -Recurse -Force
}

$changed = [System.Collections.Generic.List[object]]::new()
try {
    foreach ($job in $jobs) {
        $backup = Join-Path $backupRoot $job.Name
        $hadOriginal = Test-Path -LiteralPath $job.Target
        if ($hadOriginal) {
            Move-Item -LiteralPath $job.Target -Destination $backup
        }
        $changed.Add([PSCustomObject]@{
            Target = $job.Target; Backup = $backup; HadOriginal = $hadOriginal
        })
        Move-Item -LiteralPath (Join-Path $stageRoot $job.Name) -Destination $job.Target
        Write-Host "Updated @cline/$($job.Name)/dist"
    }
}
catch {
    $originalError = $_
    for ($i = $changed.Count - 1; $i -ge 0; $i--) {
        $entry = $changed[$i]
        try {
            if (Test-Path -LiteralPath $entry.Target) {
                Remove-Item -LiteralPath $entry.Target -Recurse -Force
            }
            if ($entry.HadOriginal) {
                Move-Item -LiteralPath $entry.Backup -Destination $entry.Target
            }
        }
        catch {
            Write-Warning "Rollback failed for $($entry.Target): $_. Backup: $($entry.Backup)"
        }
    }
    throw $originalError
}

Remove-Item -LiteralPath $stageRoot -Force
Write-Host "Done. Original dist backups: $backupRoot"
Write-Host 'Restart agent-eval and run check-sdk.mjs / smoke:web to verify runtime compatibility.'
Write-Host 'Only dist folders were replaced; package.json and other dependencies were not changed.'
