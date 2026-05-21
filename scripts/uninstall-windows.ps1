# Telecode uninstaller - Windows / NSSM
#
# Plan section 8 (Phase 5 - Windows support). Stops + removes the NSSM
# service, optionally wipes %USERPROFILE%\.telecode.
#
# USAGE:
#   .\scripts\uninstall-windows.ps1                  # interactive
#   .\scripts\uninstall-windows.ps1 -DryRun          # print commands only
#   .\scripts\uninstall-windows.ps1 -Purge           # wipe ~/.telecode (one confirm)
#   .\scripts\uninstall-windows.ps1 -Purge -Yes      # skip confirm (automation)
#   .\scripts\uninstall-windows.ps1 -KeepData        # explicit keep
#   .\scripts\uninstall-windows.ps1 -Help

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Purge,
    [switch]$KeepData,
    [Alias('y')]
    [switch]$Yes,
    [Alias('h')]
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HomeDir     = Join-Path $env:USERPROFILE '.telecode'
$ServiceName = 'Telecode'

function Write-Bold([string]$Text) { Write-Host $Text -ForegroundColor White }
function Write-Ok  ([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [!]  $Text" -ForegroundColor Yellow }
function Write-Err ([string]$Text) { Write-Host "  [X]  $Text" -ForegroundColor Red }

function Show-Usage {
    @"
Telecode Windows uninstaller (NSSM)

USAGE:
  .\uninstall-windows.ps1 [-DryRun] [-Purge|-KeepData] [-Yes] [-Help]

OPTIONS:
  -DryRun       Print commands only, do not execute.
  -Purge        Also delete %USERPROFILE%\.telecode (config, .env, DB, logs).
                Prompts once before deleting unless -Yes is also supplied.
  -KeepData     Skip the prompt and keep user data.
  -Yes          Skip -Purge confirm prompt (automation pipelines).
  -Help, -h     Show this message.
"@ | Write-Host
}

if ($Help) {
    Show-Usage
    exit 0
}

function Invoke-Action {
    param(
        [Parameter(Mandatory)] [scriptblock]$Action,
        [Parameter(Mandatory)] [string]$Description
    )
    if ($DryRun) {
        Write-Host "+ $Description" -ForegroundColor Cyan
    } else {
        & $Action
    }
}

Write-Bold 'Telecode uninstall'

# 1. NSSM detection (allow missing - we may be uninstalling after NSSM removal)
$nssmCmd = Get-Command -Name 'nssm' -ErrorAction SilentlyContinue
if ($null -eq $nssmCmd -and -not $DryRun) {
    Write-Warn2 'nssm not found on PATH - falling back to sc.exe for stop/delete.'
}

# 2. Stop + remove service if it exists
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $svc -or $DryRun) {
    Invoke-Action -Description "stop service $ServiceName" -Action {
        try {
            if ($null -ne $nssmCmd) {
                & nssm stop $ServiceName | Out-Null
            } else {
                Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
            }
        } catch {
            Write-Warn2 "stop returned $($_.Exception.Message) - service may already be stopped"
        }
    }
    Invoke-Action -Description "remove service $ServiceName" -Action {
        if ($null -ne $nssmCmd) {
            & nssm remove $ServiceName 'confirm' | Out-Null
            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 4) {
                # exit 4 = "service does not exist"
                throw "nssm remove returned $LASTEXITCODE"
            }
        } else {
            & sc.exe delete $ServiceName | Out-Null
        }
    }
    if (-not $DryRun) { Write-Ok "removed service $ServiceName" }
} else {
    Write-Warn2 "$ServiceName not registered - skipping stop+remove"
}

# 3. ~/.telecode handling
Write-Host ''
if ((-not $DryRun) -and (-not (Test-Path -LiteralPath $HomeDir))) {
    Write-Warn2 "$HomeDir not present"
    Write-Host ''
    Write-Bold 'Uninstall complete.'
    exit 0
}

$mode = $null
if ($Purge -and $KeepData) {
    Write-Err 'cannot combine -Purge and -KeepData'
    exit 2
}
if ($Purge)    { $mode = 'purge' }
if ($KeepData) { $mode = 'keep' }

switch ($mode) {
    'purge' {
        if ($DryRun) {
            if ($Yes) {
                Write-Host "+ Remove-Item -LiteralPath $HomeDir -Recurse -Force    # -Yes, no confirm" -ForegroundColor Cyan
            } else {
                Write-Host "+ prompt: PURGE $HomeDir? (yes/N) - abort if not 'yes'" -ForegroundColor Cyan
                Write-Host "+ Remove-Item -LiteralPath $HomeDir -Recurse -Force" -ForegroundColor Cyan
            }
        } else {
            $proceed = $Yes
            if (-not $proceed) {
                Write-Warn2 "About to PERMANENTLY DELETE $HomeDir (config, .env, sessions DB, logs)."
                Write-Warn2 'This cannot be undone.'
                $ans = Read-Host -Prompt "Type 'yes' to confirm purge"
                $proceed = ($ans -eq 'yes')
            }
            if ($proceed) {
                Remove-Item -LiteralPath $HomeDir -Recurse -Force
                Write-Ok "removed $HomeDir (purge)"
            } else {
                Write-Ok "purge aborted - $HomeDir kept"
            }
        }
    }
    'keep' {
        Write-Ok "keeping $HomeDir (-KeepData)"
    }
    default {
        if ($DryRun) {
            Write-Host "+ prompt: delete $HomeDir? (y/N) - default keep" -ForegroundColor Cyan
        } else {
            $ans = Read-Host -Prompt "Also delete $HomeDir? [y/N]"
            if ($ans -match '^[Yy]') {
                Remove-Item -LiteralPath $HomeDir -Recurse -Force
                Write-Ok "removed $HomeDir"
            } else {
                Write-Ok "kept $HomeDir (reinstall later to reuse it)"
            }
        }
    }
}

Write-Host ''
Write-Bold 'Uninstall complete.'
