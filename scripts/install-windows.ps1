# Telecode installer - Windows 11 / NSSM
#
# Plan section 8 (Phase 5 - Windows support). Mirrors install-systemd.sh
# (Linux) and install-launchd.sh (macOS). Writes %USERPROFILE%\.telecode\
# config + .env, installs the daemon as an NSSM-managed Windows service, and
# enables auto-start on boot.
#
# USAGE:
#   .\scripts\install-windows.ps1                # interactive install
#   .\scripts\install-windows.ps1 -DryRun        # print intended actions only
#   .\scripts\install-windows.ps1 -Help          # show usage
#
# ENV overrides (handy for non-interactive automation, e.g. Ansible / Intune):
#   TELECODE_BOT_TOKEN          - Telegram bot token (skips wizard prompt)
#   TELECODE_ALLOWED_CHAT_IDS   - comma-separated chat IDs (skips prompt)
#   TELECODE_KIRO_BINARY        - absolute path to kiro-cli.exe (optional)
#   TELECODE_INSTALL_DIR        - install dir override (default: repo dir if
#                                 dist\ exists, else $env:ProgramFiles\Telecode)
#
# PRE-REQUISITES:
#   - Windows 10 1809+ / Windows 11
#   - PowerShell 5.1 or PowerShell 7+
#   - Node 22+ on PATH (or under %ProgramFiles%\nodejs / nvm-windows)
#   - NSSM (install via: winget install NSSM.NSSM)
#
# This script is intentionally written for BOTH Windows PowerShell 5.1 (Win 10/11
# default) and PowerShell 7+ (winget-installed). We avoid 7-only syntax
# (`??`, `?.`, `-Parallel`) and stick to the 5.1-compatible subset.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [Alias('h')]
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir     = Split-Path -Parent $ScriptDir
$HomeDir     = Join-Path $env:USERPROFILE '.telecode'
$LogDir      = Join-Path $HomeDir 'logs'
$ConfigPath  = Join-Path $HomeDir 'config.yaml'
$EnvPath     = Join-Path $HomeDir '.env'
$PolicyPath  = Join-Path $HomeDir 'policy.yaml'
$ServiceName = 'Telecode'

# ---------------------------------------------------------------------------
# Output helpers - match install-systemd.sh tone
# ---------------------------------------------------------------------------
function Write-Bold([string]$Text) { Write-Host $Text -ForegroundColor White }
function Write-Ok  ([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [!]  $Text" -ForegroundColor Yellow }
function Write-Err ([string]$Text) { Write-Host "  [X]  $Text" -ForegroundColor Red }
function Write-Info([string]$Text) { Write-Host "  -  $Text" -ForegroundColor Gray }

function Show-Usage {
    @"
Telecode Windows installer (NSSM)

USAGE:
  .\install-windows.ps1 [-DryRun] [-Help]

OPTIONS:
  -DryRun       Print intended file writes + NSSM commands without executing.
                Useful for verifying output in tests or reviewing before applying.
  -Help, -h     Show this message.

ENVIRONMENT:
  TELECODE_BOT_TOKEN, TELECODE_ALLOWED_CHAT_IDS, TELECODE_KIRO_BINARY,
  TELECODE_INSTALL_DIR - non-interactive overrides (see header comment).

PRE-REQUISITES:
  - Node 22+ on PATH (winget install OpenJS.NodeJS.LTS)
  - NSSM (winget install NSSM.NSSM)
"@ | Write-Host
}

if ($Help) {
    Show-Usage
    exit 0
}

# ---------------------------------------------------------------------------
# Invoke-Action - execute (or print, when -DryRun)
# ---------------------------------------------------------------------------
function Invoke-Action {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$Action,
        [Parameter(Mandatory)]
        [string]$Description
    )
    if ($DryRun) {
        Write-Host "+ $Description" -ForegroundColor Cyan
    } else {
        & $Action
    }
}

# ---------------------------------------------------------------------------
# Atomic write helper - write to .tmp file then Move-Item -Force
# ---------------------------------------------------------------------------
function Write-FileAtomic {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Content,
        [switch]$RestrictAcl
    )
    if ($DryRun) {
        Write-Host "+ atomic_write $Path - body:" -ForegroundColor Cyan
        $Content -split "`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        return
    }
    $tmp = "$Path.tmp.$PID"
    try {
        # P5 senior review (Opus 4.7) — [P1] ACL race window fix.
        # Previous order was: write content -> rename -> Set-Acl. That left a
        # window between the rename and Set-Acl where the destination file
        # carried the parent directory's default ACL (typically `Users:RX`
        # inherited). A concurrent reader could open .env between those two
        # steps and exfiltrate the bot token. We now ACL the EMPTY tmp file
        # FIRST, then write content into it, then rename — meaning the
        # destination NEVER exists with anything other than the owner-only
        # ACL.
        # UTF-8 (no BOM) so node/yaml parsers don't choke on a leading BOM.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        if ($RestrictAcl) {
            # Create empty file, ACL it, then write into it. WriteAllText
            # opens with FileShare.None so the ACL applies before the bytes
            # land on disk.
            New-Item -ItemType File -Path $tmp -Force | Out-Null
            Set-FileOwnerOnlyAcl -Path $tmp
            [System.IO.File]::WriteAllText($tmp, $Content, $utf8NoBom)
        } else {
            [System.IO.File]::WriteAllText($tmp, $Content, $utf8NoBom)
        }
        # Move-Item -Force on Windows preserves the source file's ACL when
        # renaming within the same volume (rename is metadata-only). The
        # destination inherits the tmp file's restrictive ACL.
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
    if ($RestrictAcl) {
        # Belt-and-braces: re-apply ACL on the final destination in case the
        # rename crossed a volume boundary (Move-Item then falls back to
        # copy+delete and the dest may inherit the new parent's ACL).
        Set-FileOwnerOnlyAcl -Path $Path
    }
}

# ---------------------------------------------------------------------------
# Set-FileOwnerOnlyAcl - restrict file to the current user (mirror chmod 600)
# ---------------------------------------------------------------------------
function Set-FileOwnerOnlyAcl {
    param([Parameter(Mandatory)] [string]$Path)
    # NTFS uses ACLs; "mode 0600" maps to "owner has full control, no other
    # principal has access". We disable inheritance, strip inherited ACEs,
    # and add a single explicit ACE for the running user.
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)   # disable inheritance, don't copy parent ACEs
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($rule)
    }
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid,
        [System.Security.AccessControl.FileSystemRights]'FullControl',
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# ---------------------------------------------------------------------------
# Test-NssmPresent - fail fast if NSSM is missing
# ---------------------------------------------------------------------------
function Test-NssmPresent {
    $cmd = Get-Command -Name 'nssm' -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
        return $cmd.Source
    }
    return $null
}

# ---------------------------------------------------------------------------
# Find-NodeBinary - prefer absolute path so NSSM-spawned service has it
# ---------------------------------------------------------------------------
function Find-NodeBinary {
    # 1. PATH lookup
    $n = Get-Command -Name 'node' -ErrorAction SilentlyContinue
    if ($null -ne $n) { return $n.Source }

    # 2. Standard install paths
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if (-not [string]::IsNullOrEmpty($c) -and (Test-Path -LiteralPath $c)) {
            return $c
        }
    }

    # 3. nvm-windows installs under %APPDATA%\nvm\v<version>\node.exe
    # P5 senior review (Opus 4.7) — [P1] numeric (not lexical) version sort.
    # The naive `Sort-Object Name -Descending` picks v9.0.0 over v22.0.0
    # because "9" > "2" lexically. We project the version triplet into an
    # int array first so v22 correctly beats v9.
    $nvmRoot = Join-Path $env:APPDATA 'nvm'
    if (Test-Path -LiteralPath $nvmRoot) {
        $versions = Get-ChildItem -LiteralPath $nvmRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^v\d' } |
                    Sort-Object -Property @{ Expression = {
                        # Strip leading 'v' and any pre-release / build suffix
                        # (e.g. v22.0.0-beta1 -> 22.0.0) so the numeric parse
                        # never throws under StrictMode. We keep nightly /
                        # pre-release dirs in the candidate list — production
                        # users rarely have them, but nuking them would be a
                        # regression vs the v0.8 behaviour.
                        $clean = $_.Name.Substring(1) -replace '[-+].*$', ''
                        $parts = $clean.Split('.')
                        [int]$major = 0; [int]$minor = 0; [int]$patch = 0
                        if ($parts.Length -ge 1) { [int]::TryParse($parts[0], [ref]$major) | Out-Null }
                        if ($parts.Length -ge 2) { [int]::TryParse($parts[1], [ref]$minor) | Out-Null }
                        if ($parts.Length -ge 3) { [int]::TryParse($parts[2], [ref]$patch) | Out-Null }
                        (($major * 1000000) + ($minor * 1000) + $patch)
                    }} -Descending
        foreach ($v in $versions) {
            $exe = Join-Path $v.FullName 'node.exe'
            if (Test-Path -LiteralPath $exe) { return $exe }
        }
    }

    return $null
}

# ---------------------------------------------------------------------------
# Find-InstallDir - detect from repo checkout or fall back to ProgramFiles
# ---------------------------------------------------------------------------
function Find-InstallDir {
    if ($env:TELECODE_INSTALL_DIR) { return $env:TELECODE_INSTALL_DIR }
    # Running from a checkout that already has dist\ ? use it.
    if (Test-Path -LiteralPath (Join-Path $RepoDir 'dist\index.js')) { return $RepoDir }
    # Running from a checkout that we can build? still use it.
    if (Test-Path -LiteralPath (Join-Path $RepoDir 'package.json')) { return $RepoDir }
    # Otherwise default to %ProgramFiles%\Telecode.
    return (Join-Path $env:ProgramFiles 'Telecode')
}

# ---------------------------------------------------------------------------
# Read-PromptOrEnv - mirror prompt_or_env() from install-systemd.sh
# ---------------------------------------------------------------------------
function Read-PromptOrEnv {
    param(
        [Parameter(Mandatory)] [string]$EnvName,
        [Parameter(Mandatory)] [string]$Prompt,
        [bool]$Required = $true,
        [string]$Default = ''
    )
    $envVal = [Environment]::GetEnvironmentVariable($EnvName)
    if ($null -ne $envVal) {
        if ([string]::IsNullOrEmpty($envVal) -and $Required) {
            Write-Err "$EnvName is set but empty - required for install."
            exit 1
        }
        return $envVal
    }
    if ($DryRun) {
        if ($Required) {
            if ($Default -ne '') { return $Default }
            return '<PROMPTED-AT-RUNTIME>'
        }
        return $Default
    }
    $promptText = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
    $val = Read-Host -Prompt $promptText
    if ([string]::IsNullOrEmpty($val)) { $val = $Default }
    if ([string]::IsNullOrEmpty($val) -and $Required) {
        Write-Err "value is required - aborting"
        exit 1
    }
    return $val
}

# ---------------------------------------------------------------------------
# Get-ConfigYaml - render config.yaml body
# ---------------------------------------------------------------------------
function Get-ConfigYaml {
    param(
        [string]$KiroBinary,
        [string]$ChatIdsCsv
    )
    $yamlList = '[]'
    if (-not [string]::IsNullOrEmpty($ChatIdsCsv)) {
        $items = $ChatIdsCsv -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $yamlList = '[' + ($items -join ', ') + ']'
    }
    $lines = @()
    $lines += '# %USERPROFILE%\.telecode\config.yaml - generated by install-windows.ps1'
    $lines += 'telegram:'
    $lines += '  bot_token: ${TELEGRAM_BOT_TOKEN}     # loaded from ~/.telecode/.env'
    $lines += "  allowed_user_ids: $yamlList"
    $lines += 'daemon:'
    $lines += '  log_dir: ~/.telecode/logs'
    $lines += '  approval_timeout_sec: 300'
    $lines += '  workspace_scan:'
    $lines += '    roots: [~/Documents/workspaces, ~/workspaces, ~/projects]'
    $lines += '    max_depth: 1'
    $lines += '    exclude: [node_modules, .git, dist, build]'
    $lines += 'agents:'
    $lines += '  claude:'
    $lines += '    binary: claude'
    $lines += '    setting_sources: [user, project, local]'
    if (-not [string]::IsNullOrEmpty($KiroBinary)) {
        $lines += '  kiro:'
        $lines += "    binary: $KiroBinary"
    }
    $lines += 'defaults:'
    $lines += '  agent: claude'
    $lines += 'session_switch_preview_lines: 3'
    $lines += 'notifier:'
    $lines += '  debounce_ms: 3000'
    $lines += '  buffer_cap_bytes: 50000'
    return ($lines -join "`n") + "`n"
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
Write-Bold 'Telecode Windows installer (NSSM)'

# 0. OS check
if (-not $DryRun) {
    if ($env:OS -ne 'Windows_NT') {
        Write-Err "this installer is Windows-only (detected: $env:OS)."
        Write-Err 'use scripts/install-launchd.sh on macOS, scripts/install-systemd.sh on Linux.'
        exit 1
    }
}

# 1. NSSM pre-requisite
$nssmPath = Test-NssmPresent
if ($null -eq $nssmPath -and -not $DryRun) {
    Write-Err 'NSSM not found on PATH.'
    Write-Err 'Install with one of:'
    Write-Err '    winget install NSSM.NSSM'
    Write-Err '    choco install nssm'
    Write-Err '    Download manually from https://nssm.cc/download'
    Write-Err ''
    Write-Err 'Then re-run this installer.'
    exit 1
}
$nssmDisplay = if ($null -ne $nssmPath) { $nssmPath } else { '<dry-run skipped>' }
Write-Ok "nssm: $nssmDisplay"

# 2. Detect Node
$nodeBin = Find-NodeBinary
if ($null -eq $nodeBin -and -not $DryRun) {
    Write-Err 'Node.js not found in PATH, %ProgramFiles%\nodejs, or nvm-windows.'
    Write-Err 'Install with: winget install OpenJS.NodeJS.LTS'
    exit 1
}
if (-not $DryRun) {
    $nodeMajor = & $nodeBin -p 'process.versions.node.split(".")[0]'
    if ([int]$nodeMajor -lt 22) {
        Write-Err "Node $nodeMajor too old (need >= 22). Found: $nodeBin"
        exit 1
    }
}
$nodeDisplay = if ($null -ne $nodeBin) { $nodeBin } else { '<dry-run skipped>' }
Write-Ok "node: $nodeDisplay"

# 3. Detect install dir
$installDir = Find-InstallDir
if (-not $DryRun -and -not (Test-Path -LiteralPath $installDir)) {
    Write-Err "install dir does not exist: $installDir"
    Write-Err 'set TELECODE_INSTALL_DIR or clone the repo and run from inside it.'
    exit 1
}
Write-Ok "install dir: $installDir"

# 4. Prompts (skipped in -DryRun unless env supplied)
Write-Host ''
Write-Bold 'Configuration'
$botToken = Read-PromptOrEnv -EnvName 'TELECODE_BOT_TOKEN' `
    -Prompt 'Telegram bot token (from @BotFather)' -Required $true -Default '<TELEGRAM_BOT_TOKEN>'
$chatIds  = Read-PromptOrEnv -EnvName 'TELECODE_ALLOWED_CHAT_IDS' `
    -Prompt 'Allowed Telegram chat IDs (comma-separated, from @userinfobot)' -Required $true -Default '<USER_ID>'
$kiroBinary = Read-PromptOrEnv -EnvName 'TELECODE_KIRO_BINARY' `
    -Prompt 'Kiro CLI absolute path (blank to skip)' -Required $false -Default ''

# 5. ~/.telecode dirs
Write-Host ''
Write-Bold 'Files'
Invoke-Action -Description "mkdir $HomeDir + $LogDir" -Action {
    New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
    New-Item -ItemType Directory -Force -Path $LogDir  | Out-Null
}
if (-not $DryRun) { Write-Ok "$HomeDir" }

# 6. Write config.yaml (restricted ACL)
$configBody = Get-ConfigYaml -KiroBinary $kiroBinary -ChatIdsCsv $chatIds
if ((-not $DryRun) -and (Test-Path -LiteralPath $ConfigPath)) {
    Write-Ok 'config.yaml already present - skipping (edit manually if needed)'
} else {
    Write-FileAtomic -Path $ConfigPath -Content $configBody -RestrictAcl
    if (-not $DryRun) { Write-Ok "$ConfigPath (owner-only ACL)" }
}

# 7. Write .env (restricted ACL)
$envBody = "TELEGRAM_BOT_TOKEN=$botToken`n"
$envExists = $false
if ((-not $DryRun) -and (Test-Path -LiteralPath $EnvPath)) {
    $existing = Get-Content -LiteralPath $EnvPath -Raw -ErrorAction SilentlyContinue
    if ($existing -match '(?m)^TELEGRAM_BOT_TOKEN=') {
        $envExists = $true
        Write-Ok '.env already configured - skipping'
    }
}
if (-not $envExists) {
    Write-FileAtomic -Path $EnvPath -Content $envBody -RestrictAcl
    if (-not $DryRun) { Write-Ok "$EnvPath (owner-only ACL)" }
}

# 8. Seed policy.yaml if missing
$policyExample = Join-Path $RepoDir 'policy.example.yaml'
if ($DryRun) {
    Write-Host "+ copy $policyExample -> $PolicyPath (owner-only ACL) if missing" -ForegroundColor Cyan
} elseif ((-not (Test-Path -LiteralPath $PolicyPath)) -and (Test-Path -LiteralPath $policyExample)) {
    Copy-Item -LiteralPath $policyExample -Destination $PolicyPath -Force
    Set-FileOwnerOnlyAcl -Path $PolicyPath
    Write-Ok 'seeded policy.yaml (owner-only ACL)'
}

# 9. Build (skip in -DryRun)
$distEntry = Join-Path $installDir 'dist\index.js'
if (-not $DryRun) {
    if ((Test-Path -LiteralPath (Join-Path $installDir 'package.json')) -and (-not (Test-Path -LiteralPath $distEntry))) {
        Write-Host ''
        Write-Bold 'Building telecode'
        Push-Location $installDir
        try {
            & npm install --silent
            if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
        Write-Ok 'build OK'
    }
}

# 10. NSSM service install
Write-Host ''
Write-Bold 'Service'

# Build the PATH env the service will see. NSSM strips inherited PATH unless
# AppEnvironmentExtra is set; we prepend Node's directory so the daemon's
# child kiro-cli can still find `node` for the preToolUse gate.
$nodeDir = if ($null -ne $nodeBin) { Split-Path -Parent $nodeBin } else { '' }
$svcPath = "$nodeDir;$env:SystemRoot\system32;$env:SystemRoot;$env:SystemRoot\system32\Wbem"

# P5 senior review (Opus 4.7) — [P0] homedir() under LocalSystem fix.
# NSSM's default service identity is LocalSystem; without overriding
# USERPROFILE / HOMEDRIVE / HOMEPATH, Node's os.homedir() resolves to
# `C:\Windows\system32\config\systemprofile`. That breaks every `~`
# expansion (KIRO_AGENTS_DIR, TELECODE_HOME if it were `~/.telecode`,
# workspace_scan roots like `~/Documents/workspaces`). We pin all three
# to the INSTALLING user's profile so the daemon, even running as
# LocalSystem, sees the same filesystem layout as a foreground user
# session. Node 22 docs verified: os.homedir() checks USERPROFILE first
# on Windows before falling back to the OS profile lookup.
$userProfile = $env:USERPROFILE
$homeDrive   = if ($env:HOMEDRIVE) { $env:HOMEDRIVE } else { ($userProfile.Substring(0,2)) }
$homePath    = if ($env:HOMEPATH)  { $env:HOMEPATH }  else { ($userProfile.Substring(2)) }

$nssmCommands = @(
    @{ Args = @('install', $ServiceName, $nodeBin, "--enable-source-maps", $distEntry);
       Desc = "nssm install $ServiceName <node> --enable-source-maps <dist\index.js>" }
    @{ Args = @('set', $ServiceName, 'AppDirectory', $installDir);
       Desc = "nssm set $ServiceName AppDirectory $installDir" }
    @{ Args = @('set', $ServiceName, 'AppEnvironmentExtra',
                "TELECODE_HOME=$HomeDir",
                "NODE_ENV=production",
                "USERPROFILE=$userProfile",
                "HOMEDRIVE=$homeDrive",
                "HOMEPATH=$homePath",
                "PATH=$svcPath");
       Desc = "nssm set $ServiceName AppEnvironmentExtra TELECODE_HOME=... USERPROFILE=... HOMEDRIVE=... HOMEPATH=... PATH=..." }
    @{ Args = @('set', $ServiceName, 'AppRestartDelay', '5000');
       Desc = "nssm set $ServiceName AppRestartDelay 5000" }
    @{ Args = @('set', $ServiceName, 'AppExit', 'Default', 'Restart');
       Desc = "nssm set $ServiceName AppExit Default Restart" }
    @{ Args = @('set', $ServiceName, 'AppStopMethodConsole', '15000');
       Desc = "nssm set $ServiceName AppStopMethodConsole 15000  # SIGBREAK grace window" }
    @{ Args = @('set', $ServiceName, 'AppStdout', (Join-Path $LogDir 'stdout.log'));
       Desc = "nssm set $ServiceName AppStdout $LogDir\stdout.log" }
    @{ Args = @('set', $ServiceName, 'AppStderr', (Join-Path $LogDir 'stderr.log'));
       Desc = "nssm set $ServiceName AppStderr $LogDir\stderr.log" }
    @{ Args = @('set', $ServiceName, 'AppRotateFiles', '1');
       Desc = "nssm set $ServiceName AppRotateFiles 1" }
    @{ Args = @('set', $ServiceName, 'AppRotateBytes', '10485760');
       Desc = "nssm set $ServiceName AppRotateBytes 10485760  # 10 MiB" }
    @{ Args = @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START');
       Desc = "nssm set $ServiceName Start SERVICE_AUTO_START" }
)

# If the service already exists, remove it first so `install` is idempotent.
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $svc) {
    Invoke-Action -Description "nssm stop $ServiceName" -Action {
        try { & nssm stop $ServiceName | Out-Null } catch { Write-Warn2 "nssm stop returned $LASTEXITCODE" }
    }
    Invoke-Action -Description "nssm remove $ServiceName confirm" -Action {
        & nssm remove $ServiceName 'confirm' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "nssm remove failed (exit $LASTEXITCODE)" }
    }
}

foreach ($cmd in $nssmCommands) {
    Invoke-Action -Description $cmd.Desc -Action {
        try {
            & nssm @($cmd.Args) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "nssm exit $LASTEXITCODE for: $($cmd.Args -join ' ')" }
        } catch {
            Write-Err "nssm command failed: $($cmd.Desc)"
            throw
        }
    }
}

# 11. Start + verify
Invoke-Action -Description "nssm start $ServiceName" -Action {
    & nssm start $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm start failed (exit $LASTEXITCODE)" }
}

if (-not $DryRun) {
    # Retry briefly - service-control-manager state transition can lag a second
    # or two on slow / VM hosts; a single sleep would flake there.
    $active = $false
    for ($i = 0; $i -lt 6; $i++) {
        Start-Sleep -Seconds 1
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $svc -and $svc.Status -eq 'Running') {
            $active = $true
            break
        }
    }
    if ($active) {
        Write-Ok "running: $ServiceName"
    } else {
        Write-Warn2 "service not running after ~6s - tail of stderr.log below:"
        $stderrLog = Join-Path $LogDir 'stderr.log'
        if (Test-Path -LiteralPath $stderrLog) {
            Get-Content -LiteralPath $stderrLog -Tail 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    }
}

Write-Host ''
Write-Bold 'Install complete.'
Write-Host "  - Status:  Get-Service $ServiceName"
Write-Host "  - Logs:    Get-Content $LogDir\stdout.log -Tail 30 -Wait"
Write-Host "  - Stop:    nssm stop $ServiceName"
Write-Host "  - Restart: nssm restart $ServiceName"
Write-Host "  - Uninstall: .\scripts\uninstall-windows.ps1"
