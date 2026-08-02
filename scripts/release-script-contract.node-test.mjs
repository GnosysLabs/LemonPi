import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(resolve(path), "utf8");
}

const macos = source("scripts/release-macos.sh");
const windows = source("scripts/release-windows.ps1");
const remote = source("scripts/release-windows-remote.sh");
const workflow = source(".github/workflows/release.yml");
const windowsWorkflow = source(".github/workflows/release-windows.yml");
const finalizeKeyScript = remote.match(/cat > "\$finalize_key_script" <<'PS'\n([\s\S]*?)\nPS\n/);

describe("release script contracts", () => {
  it("uses the signer path variable only for direct macOS signer commands", () => {
    assert.equal((macos.match(/export TAURI_SIGNING_PRIVATE_KEY_PATH="\$updater_key"/g) ?? []).length, 2);
    assert.equal((macos.match(/trap 'unset TAURI_SIGNING_PRIVATE_KEY_PATH' EXIT/g) ?? []).length, 2);
    assert.equal((macos.match(/tauri signer sign --password ""/g) ?? []).length, 2);
    assert.match(macos, /unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
    assert.match(macos, /export TAURI_SIGNING_PRIVATE_KEY="\$updater_key"/);
    assert.match(macos, /tauri build --ci --bundles app/);
  });

  it("separates Windows preflight and build signer environments and preserves line-ending-only hygiene", () => {
    assert.match(windows, /\$env:TAURI_SIGNING_PRIVATE_KEY_PATH = \$UpdaterKeyPath/);
    assert.match(windows, /Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue/);
    assert.match(windows, /\$env:TAURI_SIGNING_PRIVATE_KEY = \$UpdaterKeyPath/);
    assert.match(windows, /"sign", "--password=", \$preflightFile/);
    assert.doesNotMatch(windows, /"sign", "--password", "", \$preflightFile/);
    assert.match(windows, /"build", "--ci", "--bundles", "nsis"/);
    assert.match(windows, /git -C \$worktree diff --quiet --ignore-space-at-eol/);
    assert.match(windows, /\$untrackedPaths = @\(\$worktreeStatus/);
  });

  it("uses an absolute config path, a keepalive build channel, fail-closed key cleanup, and early local output rejection", () => {
    assert.match(remote, /readFileSync\(process\.argv\[1\], "utf8"\).*"\$repo_root\/src-tauri\/tauri\.conf\.json"/);
    assert.match(remote, /run_remote_build\(\)/);
    assert.match(remote, /ServerAliveInterval=20 -o ServerAliveCountMax=30/);
    assert.match(remote, /Set-And-TestPrivateKeyAcl/);
    assert.match(remote, /\[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User/);
    assert.match(remote, /IdentityReference\.Translate\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/);
    assert.doesNotMatch(remote, /System\.Security\.Principal\.NTAccount/);
    assert.doesNotMatch(remote, /\$env:USERDOMAIN/);
    assert.match(remote, /if \(\$privateMoved\) \{ Remove-Item -LiteralPath \$keyPath/);
    assert.match(remote, /if \[\[ -e "\$local_assets" \]\]; then/);
    assert.ok(remote.indexOf('if [[ -e "$local_assets" ]]') < remote.indexOf("bootstrap_command="));
  });

  it("uploads a parameterized temporary finalize script and cleans it up through EXIT", () => {
    assert.match(remote, /finalize_key_script="\$temporary_dir\/finalize-updater-key\.ps1"/);
    assert.match(remote, /remote_stamp="\$\(date -u \+%Y%m%dT%H%M%SZ\)-\$\$"/);
    assert.match(remote, /remote_finalize_script="C:\/Users\/cmcel\/AppData\/Local\/Temp\/lemonpi-finalize-updater-key-\$short_revision-\$remote_stamp\.ps1"/);
    assert.match(remote, /remote_finalize_script_uploaded=false/);
    assert.match(remote, /remote_finalize_script_uploaded=true\n    scp -q "\$finalize_key_script" "\$windows_host:\$remote_finalize_script"/);
    assert.match(remote, /is_safe_remote_cleanup_target\(\) \{[\s\S]*"\$target" != "\/"[\s\S]*\^\[A-Za-z\]:\[\\\\\/\]\*\$/);
    assert.match(remote, /if \[\[ "\$remote_finalize_script_uploaded" == true \]\] && is_safe_remote_cleanup_target "\$remote_finalize_script"; then/);
    assert.match(remote, /remove_remote_file "\$remote_finalize_script" >\/dev\/null/);
    assert.match(remote, /finalize_result=\$\(run_remote "& \$\(ps_quote "\$remote_finalize_script"\) -Temporary \$\(ps_quote "\$remote_key_temp"\) -ExpectedHash \$\(ps_quote "\$expected_public_hash"\)" \| tr -d '\\r'\)/);
    assert.doesNotMatch(remote, /finalize_key_command=\$\(cat/);
    assert.doesNotMatch(remote, /run_remote "\$finalize_key_command"/);
    assert.ok(finalizeKeyScript, "the local finalize script must be generated with a literal heredoc");
    assert.match(finalizeKeyScript[1], /\[Parameter\(Mandatory = \$true\)\]\n  \[string\]\$Temporary/);
    assert.match(finalizeKeyScript[1], /\[Parameter\(Mandatory = \$true\)\]\n  \[string\]\$ExpectedHash/);
    assert.doesNotMatch(finalizeKeyScript[1], /expected_public_hash|remote_key_temp|ps_quote/);
  });

  it("uses noninteractive Tauri build signing in the manual fallback workflow", () => {
    assert.match(workflow, /args: --ci --target \$\{\{ matrix\.target \}\} --bundles \$\{\{ matrix\.bundles \}\}/);
  });

  it("makes the hosted Windows candidate an explicitly dispatched, SHA-scoped job", () => {
    assert.match(windowsWorkflow, /^on:\n  workflow_dispatch:\n    inputs:\n/m);
    assert.match(windowsWorkflow, /revision:\n        description: Exact 40-character lowercase commit SHA to build\.\n        required: true\n        type: string/);
    assert.match(windowsWorkflow, /expected_version:\n        description: Expected LemonPi version for this candidate\.\n        required: true\n        type: string/);
    assert.doesNotMatch(windowsWorkflow, /^\s+(?:push|pull_request|schedule):/m);
    assert.match(windowsWorkflow, /contents: read/);
    assert.match(windowsWorkflow, /id-token: write/);
    assert.match(windowsWorkflow, /attestations: write/);
    assert.match(windowsWorkflow, /group: lemonpi-windows-nsis-\$\{\{ inputs\.revision \}\}/);
    assert.match(windowsWorkflow, /cancel-in-progress: false/);
    assert.match(windowsWorkflow, /runs-on: windows-2022/);
    assert.match(windowsWorkflow, /timeout-minutes: 60/);
    assert.match(windowsWorkflow, /uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ inputs\.revision \}\}\n          fetch-depth: 0/);
    assert.match(windowsWorkflow, /\$revision -cnotmatch "\^\[0-9a-f\]\{40\}\$"/);
    assert.match(windowsWorkflow, /git rev-parse HEAD/);
    assert.match(windowsWorkflow, /git merge-base --is-ancestor \$revision origin\/main/);
    assert.match(windowsWorkflow, /git status --porcelain --untracked-files=all/);
    assert.match(windowsWorkflow, /\$expectedVersion -cne "0\.1\.2"/);
    assert.match(windowsWorkflow, /verify-release-version\.mjs --tag "v\$env:INPUT_EXPECTED_VERSION"/);
  });

  it("uses the exact signed NSIS build toolchain without password, release, or AV paths", () => {
    assert.match(windowsWorkflow, /uses: pnpm\/action-setup@v4\n        with:\n          version: 10\.30\.3/);
    assert.match(windowsWorkflow, /uses: actions\/setup-node@v4\n        with:\n          node-version: 22/);
    assert.match(windowsWorkflow, /pnpm install --frozen-lockfile/);
    assert.match(windowsWorkflow, /uses: dtolnay\/rust-toolchain@stable\n        with:\n          targets: x86_64-pc-windows-msvc/);
    assert.doesNotMatch(windowsWorkflow, /toolchain: stable-x86_64-pc-windows-msvc/);
    assert.match(windowsWorkflow, /\$rustcVersion = @\(rustc -vV\)/);
    assert.match(windowsWorkflow, /\$hostLines = @\(\$rustcVersion \| Where-Object \{ \$_ -match "\^host:\\s\*\\S\+\\s\*\$" \}\)/);
    assert.match(windowsWorkflow, /\$rustHost -cne "x86_64-pc-windows-msvc"/);
    assert.match(windowsWorkflow, /pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis/);
    assert.doesNotMatch(windowsWorkflow, /--bundles\s+msi/);
    assert.match(windowsWorkflow, /-Filter "\*\.msi"/);
    assert.match(windowsWorkflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
    assert.equal((windowsWorkflow.match(/\$\{\{\s*secrets\./g) ?? []).length, 1);
    assert.doesNotMatch(windowsWorkflow, /password/i);
    assert.doesNotMatch(windowsWorkflow, /\bgh\s+(?:release|api)\b|tauri-action|actions\/create-release/i);
    assert.doesNotMatch(windowsWorkflow, /defender|antivirus|antimalware|mpcmdrun/i);
  });

  it("requires exact NSIS artifacts, validates both PEs, and retains only safe evidence", () => {
    assert.match(windowsWorkflow, /Expected exactly one NSIS installer and one updater signature/);
    assert.match(windowsWorkflow, /Installer and updater signature must be nonempty/);
    assert.match(windowsWorkflow, /\$expectedInstallerName = "LemonPi_\$\(\$env:INPUT_EXPECTED_VERSION\)_x64-setup\.exe"/);
    assert.match(windowsWorkflow, /Installer ProductVersion must be 0\.1\.2/);
    assert.match(windowsWorkflow, /0x10b \{ \$optionalHeader \+ 68; break \}/);
    assert.match(windowsWorkflow, /0x20b \{ \$optionalHeader \+ 68; break \}/);
    assert.doesNotMatch(windowsWorkflow, /\$optionalHeader \+ 88/);
    assert.match(windowsWorkflow, /Installer must be a GUI PE; an x86 NSIS stub or x64 PE is required/);
    assert.match(windowsWorkflow, /Built lemonpi\.exe is missing/);
    assert.match(windowsWorkflow, /lemonpi\.exe must be an AMD64 PE32\+ GUI executable/);
    assert.match(windowsWorkflow, /windows-build-metadata\.json/);
    assert.match(windowsWorkflow, /\$summaryRows \| Add-Content -LiteralPath \$env:GITHUB_STEP_SUMMARY -Encoding utf8/);
    for (const label of ["Revision", "Version", "Installer name", "Installer SHA-256", "Signature SHA-256", "Payload architecture", "Runner OS \/ architecture", "Run ID", "UTC build time"]) {
      assert.ok(windowsWorkflow.includes(`"| ${label} |`), `missing safe summary row: ${label}`);
    }
    for (const field of ["revision", "version", "name", "hashes", "run", "runner", "time"]) {
      assert.match(windowsWorkflow, new RegExp(`\\b${field}\\s=`));
    }
    assert.match(windowsWorkflow, /uses: actions\/upload-artifact@v4/);
    assert.match(windowsWorkflow, /retention-days: 7/);
    assert.match(windowsWorkflow, /if-no-files-found: error/);
    assert.match(windowsWorkflow, /continue-on-error: true\n        uses: actions\/attest-build-provenance@v2/);
  });
});
