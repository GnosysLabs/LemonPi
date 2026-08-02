param(
    [Parameter(Mandatory = $true)]
    [string]$Revision,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$Repository = (Join-Path $env:USERPROFILE "LemonPi"),
    [string]$UpdaterKeyPath = (Join-Path $env:USERPROFILE ".tauri\lemonpi-updater.key"),
    [int]$CargoBuildJobs = 4
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ExpectedOrigin = "https://github.com/GnosysLabs/LemonPi.git"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Get-PeSubsystem {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $reader = [System.IO.BinaryReader]::new($stream)
    try {
        $stream.Position = 0x3c
        $peOffset = $reader.ReadUInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "$Path is not a valid PE executable"
        }
        $stream.Position = $peOffset + 24 + 68
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

foreach ($command in @("git", "node", "pnpm", "cargo", "rustc")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $command"
    }
}

if (-not (Test-Path -LiteralPath $Repository -PathType Container)) {
    throw "Windows LemonPi checkout is missing: $Repository"
}
$origin = (git -C $Repository remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -ne $ExpectedOrigin) {
    throw "Windows checkout origin does not match $ExpectedOrigin"
}
if (-not (Test-Path -LiteralPath $UpdaterKeyPath -PathType Leaf) -or -not (Test-Path -LiteralPath "$UpdaterKeyPath.pub" -PathType Leaf)) {
    throw "Windows updater key and public companion are required."
}

Invoke-Checked git -Arguments @("-C", $Repository, "fetch", "--prune", "origin")
Invoke-Checked git -Arguments @("-C", $Repository, "cat-file", "-e", "$Revision^{commit}")
$resolvedRevision = (git -C $Repository rev-parse "$Revision^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or -not $resolvedRevision) {
    throw "Could not resolve Windows build revision: $Revision"
}
& git -C $Repository merge-base --is-ancestor $resolvedRevision origin/main
if ($LASTEXITCODE -ne 0) {
    throw "Windows build revision is not available from origin/main"
}

$shortRevision = $resolvedRevision.Substring(0, 12)
$worktreeRoot = Join-Path $env:LOCALAPPDATA "lemonpi-release-worktrees"
$worktree = Join-Path $worktreeRoot "build-$shortRevision-$PID"
$cargoTarget = Join-Path $Repository "src-tauri\target"
$bundleDirectory = Join-Path $cargoTarget "release\bundle\nsis"
$worktreeAdded = $false
New-Item -ItemType Directory -Force -Path $worktreeRoot | Out-Null

try {
    Invoke-Checked git -Arguments @("-C", $Repository, "worktree", "add", "--detach", $worktree, $resolvedRevision)
    $worktreeAdded = $true

    $tauriConfigPath = Join-Path $worktree "src-tauri\tauri.conf.json"
    $packagePath = Join-Path $worktree "package.json"
    $cargoManifestPath = Join-Path $worktree "src-tauri\Cargo.toml"
    $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $cargoManifest = Get-Content -LiteralPath $cargoManifestPath -Raw
    $cargoVersionMatch = [regex]::Match($cargoManifest, '(?m)^version\s*=\s*"([^"]+)"\s*$')
    if (-not $cargoVersionMatch.Success) {
        throw "Could not read the Rust package version"
    }

    $version = [string]$tauriConfig.version
    $cargoVersion = $cargoVersionMatch.Groups[1].Value
    if ($version -ne "0.1.1" -or $package.version -ne $version -or $cargoVersion -ne $version) {
        throw "Version mismatch or unsupported release version: package=$($package.version), Tauri=$version, Cargo=$cargoVersion"
    }

    $configuredPublicKey = ([string]$tauriConfig.plugins.updater.pubkey).Trim()
    $keyPublicKey = (Get-Content -LiteralPath "$UpdaterKeyPath.pub" -Raw).Trim()
    if ($configuredPublicKey -ne $keyPublicKey) {
        throw "The Windows updater key does not match tauri.conf.json"
    }

    Invoke-Checked pnpm -Arguments @("--dir", $worktree, "install", "--frozen-lockfile")
    $env:CARGO_BUILD_JOBS = [string]$CargoBuildJobs
    $env:CARGO_TARGET_DIR = $cargoTarget
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

    $preflightFile = Join-Path $env:TEMP "lemonpi-updater-preflight-$PID"
    try {
        # `tauri signer sign` consumes the explicit path variable, not the
        # build-time private-key variable.
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $UpdaterKeyPath
        Set-Content -LiteralPath $preflightFile -Value "lemonpi updater signing preflight" -NoNewline
        Invoke-Checked pnpm -Arguments @("--dir", $worktree, "tauri", "signer", "sign", "--password=", $preflightFile)
        if (-not (Test-Path -LiteralPath "$preflightFile.sig" -PathType Leaf) -or (Get-Item -LiteralPath "$preflightFile.sig").Length -eq 0) {
            throw "Updater signing preflight did not produce a signature"
        }
    }
    finally {
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $preflightFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$preflightFile.sig" -Force -ErrorAction SilentlyContinue
    }

    Remove-Item -LiteralPath $bundleDirectory -Recurse -Force -ErrorAction SilentlyContinue
    # Tauri build supports a private-key path or contents in this variable; use
    # the protected path so PowerShell never reads or logs the key contents.
    $env:TAURI_SIGNING_PRIVATE_KEY = $UpdaterKeyPath
    Invoke-Checked pnpm -Arguments @("--dir", $worktree, "tauri", "build", "--ci", "--bundles", "nsis")

    $installers = @(Get-ChildItem -LiteralPath $bundleDirectory -Filter "LemonPi_0.1.1_*-setup.exe" -File)
    if ($installers.Count -ne 1) {
        throw "Expected one LemonPi 0.1.1 NSIS installer, found $($installers.Count)"
    }
    $installer = $installers[0]
    $signaturePath = "$($installer.FullName).sig"
    if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf) -or (Get-Item -LiteralPath $signaturePath).Length -eq 0) {
        throw "Updater signature is missing or empty: $signaturePath"
    }

    $fileVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($installer.FullName).FileVersion
    if (-not $fileVersion.StartsWith($version)) {
        throw "Installer version $fileVersion does not match release $version"
    }
    if ((Get-PeSubsystem -Path $installer.FullName) -ne 2) {
        throw "Installer is not a Windows GUI subsystem executable"
    }

    $worktreeStatus = @(git -C $worktree status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not verify the Windows release worktree"
    }
    if ($worktreeStatus.Count -ne 0) {
        # Tauri may normalize restored Cargo files to Windows line endings.
        # Permit only that byte-level difference; source changes and any
        # untracked file remain release blockers.
        & git -C $worktree diff --quiet --ignore-space-at-eol
        $semanticDiffExit = $LASTEXITCODE
        if ($semanticDiffExit -gt 1) {
            throw "Could not compare the Windows release worktree"
        }
        $untrackedPaths = @($worktreeStatus | Where-Object { $_.StartsWith("??") })
        if ($semanticDiffExit -eq 1 -or $untrackedPaths.Count -ne 0) {
            $changedPaths = ($worktreeStatus | ForEach-Object {
                if ($_.Length -gt 3) { $_.Substring(3) } else { $_ }
            }) -join ", "
            throw "The Windows release worktree changed during the build: $changedPaths"
        }
    }

    if (Test-Path -LiteralPath $OutputDirectory) {
        if (@(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -ne 0) {
            throw "Windows output directory is not empty: $OutputDirectory"
        }
    }
    else {
        New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    }

    $outputInstaller = Join-Path $OutputDirectory $installer.Name
    $outputSignature = "$outputInstaller.sig"
    Copy-Item -LiteralPath $installer.FullName -Destination $outputInstaller
    Copy-Item -LiteralPath $signaturePath -Destination $outputSignature
    $installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputInstaller).Hash.ToLowerInvariant()
    $signatureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputSignature).Hash.ToLowerInvariant()
    $authenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $outputInstaller).Status

    Write-Output "RESULT_REVISION=$resolvedRevision"
    Write-Output "RESULT_VERSION=$version"
    Write-Output "RESULT_INSTALLER=$outputInstaller"
    Write-Output "RESULT_SIGNATURE=$outputSignature"
    Write-Output "RESULT_INSTALLER_SHA256=$installerHash"
    Write-Output "RESULT_SIGNATURE_SHA256=$signatureHash"
    Write-Output "RESULT_AUTHENTICODE_STATUS=$authenticodeStatus"
}
finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue

    if ($worktreeAdded) {
        & git -C $Repository worktree remove --force $worktree
        & git -C $Repository worktree prune
    }
}
