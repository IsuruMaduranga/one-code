# One Code installer for Windows.
#
#   powershell -c "irm https://raw.githubusercontent.com/IsuruMaduranga/one-code/master/install.ps1 | iex"
#
# What it does, in order:
#   1. Finds a Node.js 22.19 or later on your PATH. When there is none, it
#      downloads the current Node LTS for your CPU from nodejs.org as a zip,
#      checks the download against nodejs.org's SHASUMS256.txt, unpacks it to
#      %LOCALAPPDATA%\onecode\node\current and adds that folder to your user
#      PATH. Nothing is installed system-wide and no installer runs.
#   2. Runs `npm install -g @one-ai/one-code`, the same package the guide
#      installs by hand, and makes sure npm's global folder is on your PATH.
#   3. Checks for git and Git for Windows and tells you how to add them when
#      they are missing. One Code works without them: PowerShell is the
#      primary shell tool on Windows.
#
# Knobs, all environment variables, because `irm | iex` cannot pass parameters:
#   ONECODE_INSTALL_NODE=1     download the standalone Node even when one exists
#   ONECODE_NODE_VERSION=x.y.z pin the Node version to download (default: newest LTS)
#   ONECODE_PACKAGE_SPEC=...   what to hand to npm install (default: @one-ai/one-code)
#   ONECODE_INSTALL_GIT=1      install Git for Windows through winget when git is missing
#   ONECODE_NO_PATH_UPDATE=1   never touch the user PATH (the script prints what to add)
#
# Windows PowerShell 5.1 and PowerShell 7 both run it. Everything lives in
# functions and the script never calls `exit`, so pasting it into an open
# shell cannot close that shell.

$ErrorActionPreference = 'Stop'

$OneCodeMinNodeVersion = [version]'22.19.0'
$OneCodeNodeDist = 'https://nodejs.org/dist'

function Write-OneCodeStep {
    param([string]$Message)
    Write-Host "onecode: $Message"
}

function Write-OneCodeNote {
    param([string]$Message)
    Write-Host "onecode: $Message" -ForegroundColor Yellow
}

function Test-OneCodeIsWindows {
    if ($PSVersionTable.PSVersion.Major -ge 6) { return [bool]$IsWindows }
    return $true
}

function Get-OneCodeNodeArch {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw "onecode: unsupported CPU architecture '$arch'. Install Node.js 22.19+ from https://nodejs.org and rerun." }
    }
}

# The version of the `node` on PATH, or $null when there is none or it does not answer.
function Get-OneCodeNodeVersion {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    try {
        $raw = (& $node.Source --version 2>$null | Select-Object -First 1)
        if ($raw -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    } catch { }
    return $null
}

# The newest Node LTS release (major >= 22) listed by nodejs.org, as "vX.Y.Z".
function Resolve-OneCodeNodeVersion {
    if ($env:ONECODE_NODE_VERSION) {
        $pinned = $env:ONECODE_NODE_VERSION.TrimStart('v')
        if ($pinned -notmatch '^\d+\.\d+\.\d+$') { throw "onecode: ONECODE_NODE_VERSION must look like 24.9.0 (got '$env:ONECODE_NODE_VERSION')." }
        return "v$pinned"
    }
    $index = Invoke-RestMethod -Uri "$OneCodeNodeDist/index.json" -UseBasicParsing
    foreach ($release in $index) {
        if (-not $release.lts) { continue }
        if ($release.lts -is [bool]) { continue }
        if ($release.version -match '^v(\d+)\.') {
            if ([int]$Matches[1] -ge $OneCodeMinNodeVersion.Major) { return $release.version }
        }
    }
    throw 'onecode: nodejs.org lists no LTS release at 22 or later; install Node.js by hand and rerun.'
}

function Install-OneCodeStandaloneNode {
    $arch = Get-OneCodeNodeArch
    $version = Resolve-OneCodeNodeVersion
    $folder = "node-$version-win-$arch"
    $zipName = "$folder.zip"
    $root = Join-Path $env:LOCALAPPDATA 'onecode\node'
    $target = Join-Path $root 'current'
    $staging = Join-Path $root "staging-$([guid]::NewGuid().ToString('N'))"

    Write-OneCodeStep "downloading Node.js $version ($arch) from nodejs.org"
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $zipPath = Join-Path $staging $zipName
    Invoke-WebRequest -Uri "$OneCodeNodeDist/$version/$zipName" -OutFile $zipPath -UseBasicParsing
    $sums = Invoke-RestMethod -Uri "$OneCodeNodeDist/$version/SHASUMS256.txt" -UseBasicParsing

    $expected = $null
    foreach ($line in ($sums -split "`n")) {
        if ($line -match "^([0-9a-fA-F]{64})\s+$([regex]::Escape($zipName))\s*$") { $expected = $Matches[1]; break }
    }
    if (-not $expected) { throw "onecode: SHASUMS256.txt for Node $version has no entry for $zipName." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash
    if ($actual.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
        Remove-Item -Recurse -Force $staging
        throw "onecode: checksum mismatch for $zipName (expected $expected, got $actual). Nothing was installed."
    }
    Write-OneCodeStep 'checksum verified'

    Expand-Archive -Path $zipPath -DestinationPath $staging -Force
    $unpacked = Join-Path $staging $folder
    if (-not (Test-Path (Join-Path $unpacked 'node.exe'))) { throw "onecode: the Node zip did not contain $folder\node.exe." }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item -Path $unpacked -Destination $target
    Remove-Item -Recurse -Force $staging
    Write-OneCodeStep "Node.js $version unpacked to $target"
    return $target
}

# Adds a folder to the front of the user PATH (registry, keeping %VAR% entries
# unexpanded) and to this session's PATH. Returns $true when the registry changed.
function Add-OneCodeUserPath {
    param([string]$Folder)
    $folderTrimmed = $Folder.TrimEnd('\')
    $sessionEntries = $env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }
    if ($sessionEntries -notcontains $folderTrimmed) { $env:Path = "$folderTrimmed;$env:Path" }

    if ($env:ONECODE_NO_PATH_UPDATE -eq '1') {
        Write-OneCodeNote "ONECODE_NO_PATH_UPDATE=1: add this folder to your PATH yourself: $folderTrimmed"
        return $false
    }
    $key = Get-Item -Path 'HKCU:\Environment'
    $current = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $expandedEntries = ($current -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
    if ($expandedEntries -contains $folderTrimmed) { return $false }
    $updated = if ($current) { "$folderTrimmed;$current" } else { $folderTrimmed }
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $updated -Type ExpandString
    Write-OneCodeStep "added to your user PATH: $folderTrimmed"
    return $true
}

# Tells Explorer and new terminals that the environment changed (WM_SETTINGCHANGE).
function Send-OneCodeEnvironmentChange {
    try {
        $signature = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
        $type = Add-Type -MemberDefinition $signature -Name 'NativeMethods' -Namespace 'OneCodeInstaller' -PassThru
        $result = [UIntPtr]::Zero
        $type::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
    } catch {
        # Purely a courtesy; a new terminal reads the registry anyway.
    }
}

function Install-OneCode {
    if (-not (Test-OneCodeIsWindows)) {
        throw 'onecode: this installer is for Windows. On macOS and Linux run: npm install -g @one-ai/one-code'
    }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }

    $pathChanged = $false

    # 1. Node.js
    $nodeDir = $null
    $existing = Get-OneCodeNodeVersion
    if ($env:ONECODE_INSTALL_NODE -eq '1' -or -not $existing -or $existing -lt $OneCodeMinNodeVersion) {
        if ($existing) { Write-OneCodeStep "found Node.js $existing, need $OneCodeMinNodeVersion or later" }
        else { Write-OneCodeStep 'no Node.js on PATH' }
        $nodeDir = Install-OneCodeStandaloneNode
        if (Add-OneCodeUserPath -Folder $nodeDir) { $pathChanged = $true }
    } else {
        $nodeDir = Split-Path -Parent (Get-Command node -CommandType Application).Source
        Write-OneCodeStep "using Node.js $existing at $nodeDir"
    }

    $npm = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $npm)) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npmCommand) { throw "onecode: found node in $nodeDir but no npm.cmd next to it or on PATH." }
        $npm = $npmCommand.Source
    }

    # 2. The app
    $spec = if ($env:ONECODE_PACKAGE_SPEC) { $env:ONECODE_PACKAGE_SPEC } else { '@one-ai/one-code' }
    Write-OneCodeStep "npm install -g $spec"
    & $npm install -g $spec
    if ($LASTEXITCODE -ne 0) { throw "onecode: npm install -g $spec failed with exit code $LASTEXITCODE." }

    $prefix = (& $npm prefix -g | Select-Object -First 1).Trim()
    if ($prefix -and (Test-Path (Join-Path $prefix 'onecode.cmd'))) {
        if (Add-OneCodeUserPath -Folder $prefix) { $pathChanged = $true }
    }

    # 3. git and Git for Windows
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
    if (-not $git) {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($env:ONECODE_INSTALL_GIT -eq '1' -and $winget) {
            Write-OneCodeStep 'installing Git for Windows through winget'
            & $winget.Source install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { Write-OneCodeNote "winget exited with $LASTEXITCODE; install Git for Windows from https://git-scm.com/download/win" }
        } else {
            Write-OneCodeNote 'git is not on your PATH. One Code uses it for the branch in the footer, /init and worktrees, and Git for Windows also gives the model a bash tool.'
            if ($winget) { Write-OneCodeNote '  winget install --id Git.Git -e   (or set ONECODE_INSTALL_GIT=1 and rerun this installer)' }
            else { Write-OneCodeNote '  https://git-scm.com/download/win' }
        }
    }

    if ($pathChanged) { Send-OneCodeEnvironmentChange }

    # 4. Report
    $onecode = Get-Command onecode.cmd -ErrorAction SilentlyContinue
    if ($onecode) {
        $version = (& $onecode.Source --version 2>&1 | Select-Object -First 1)
        Write-Host ''
        Write-Host "One Code is installed: $version" -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host 'One Code is installed.' -ForegroundColor Green
    }
    if ($pathChanged) { Write-Host 'Open a new terminal so it picks up the PATH change, then:' }
    else { Write-Host 'Next:' }
    Write-Host '  cd your-project'
    Write-Host '  onecode'
    Write-Host 'Inside One Code, run /login to connect a provider. Guide: https://github.com/IsuruMaduranga/one-code/blob/master/docs/guide/windows.md'
}

Install-OneCode
