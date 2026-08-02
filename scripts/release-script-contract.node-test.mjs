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

describe("release script contracts", () => {
  it("uses the signer path variable only for direct macOS signer commands", () => {
    assert.equal((macos.match(/export TAURI_SIGNING_PRIVATE_KEY_PATH="\$updater_key"/g) ?? []).length, 2);
    assert.equal((macos.match(/trap 'unset TAURI_SIGNING_PRIVATE_KEY_PATH' EXIT/g) ?? []).length, 2);
    assert.match(macos, /unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
    assert.match(macos, /export TAURI_SIGNING_PRIVATE_KEY="\$updater_key"/);
  });

  it("separates Windows preflight and build signer environments and preserves line-ending-only hygiene", () => {
    assert.match(windows, /\$env:TAURI_SIGNING_PRIVATE_KEY_PATH = \$UpdaterKeyPath/);
    assert.match(windows, /Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue/);
    assert.match(windows, /\$env:TAURI_SIGNING_PRIVATE_KEY = \$UpdaterKeyPath/);
    assert.match(windows, /git -C \$worktree diff --quiet --ignore-space-at-eol/);
    assert.match(windows, /\$untrackedPaths = @\(\$worktreeStatus/);
  });

  it("uses an absolute config path, a keepalive build channel, fail-closed key cleanup, and early local output rejection", () => {
    assert.match(remote, /readFileSync\(process\.argv\[1\], "utf8"\).*"\$repo_root\/src-tauri\/tauri\.conf\.json"/);
    assert.match(remote, /run_remote_build\(\)/);
    assert.match(remote, /ServerAliveInterval=20 -o ServerAliveCountMax=30/);
    assert.match(remote, /Set-And-TestPrivateKeyAcl/);
    assert.match(remote, /if \(\\\$privateMoved\) \{ Remove-Item -LiteralPath \\\$keyPath/);
    assert.match(remote, /if \[\[ -e "\$local_assets" \]\]; then/);
    assert.ok(remote.indexOf('if [[ -e "$local_assets" ]]') < remote.indexOf("bootstrap_command="));
  });
});
