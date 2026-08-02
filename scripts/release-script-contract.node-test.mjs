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
});
