#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
windows_host=${LEMONPI_WINDOWS_HOST:-noise-windows}
windows_repo=${LEMONPI_WINDOWS_REPO:-'C:\Users\cmcel\LemonPi'}
revision=${1:-$(git -C "$repo_root" rev-parse HEAD)}
revision=$(git -C "$repo_root" rev-parse "$revision^{commit}")
short_revision=${revision:0:12}
version=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$repo_root/src-tauri/tauri.conf.json")
updater_key=${LEMONPI_UPDATER_KEY_PATH:-"$HOME/.tauri/lemonpi-updater.key"}
local_assets="$repo_root/src-tauri/target/release/windows-assets"
temporary_dir=$(mktemp -d /tmp/lemonpi-windows-release.XXXXXX)
remote_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
remote_script="C:/Users/cmcel/AppData/Local/Temp/lemonpi-release-windows-$short_revision.ps1"
remote_script_uploaded=false
remote_finalize_script="C:/Users/cmcel/AppData/Local/Temp/lemonpi-finalize-updater-key-$short_revision-$remote_stamp.ps1"
remote_finalize_script_uploaded=false
remote_key_temp=""
expected_origin='https://github.com/GnosysLabs/LemonPi.git'

fail() {
  echo "release-windows-remote: $*" >&2
  exit 1
}

ps_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

encode_powershell() {
  iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n'
}

run_remote() {
  local command=$1
  local encoded
  encoded=$(printf '%s' "$command" | encode_powershell)
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$windows_host" \
    "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

run_remote_build() {
  local command=$1
  local encoded
  encoded=$(printf '%s' "$command" | encode_powershell)
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 \
    -o ServerAliveInterval=20 -o ServerAliveCountMax=30 "$windows_host" \
    "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

is_safe_remote_cleanup_target() {
  local target=${1:-}
  [[ -n "$target" && "$target" != "/" && "$target" != $'\\' && ! "$target" =~ ^[A-Za-z]:[\\/]*$ ]]
}

remove_remote_file() {
  local target=${1:-}
  is_safe_remote_cleanup_target "$target" || return 1
  run_remote "\$path = $(ps_quote "$target"); if (Test-Path -LiteralPath \$path) { Remove-Item -LiteralPath \$path -Force -ErrorAction Stop }"
}

cleanup() {
  rm -rf "$temporary_dir"
  if is_safe_remote_cleanup_target "$remote_key_temp"; then
    run_remote "Remove-Item -LiteralPath $(ps_quote "$remote_key_temp") -Recurse -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_finalize_script_uploaded" == true ]] && is_safe_remote_cleanup_target "$remote_finalize_script"; then
    remove_remote_file "$remote_finalize_script" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_script_uploaded" == true ]] && is_safe_remote_cleanup_target "$remote_script"; then
    remove_remote_file "$remote_script" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -e "$local_assets" ]]; then
  [[ -d "$local_assets" ]] || fail "Windows output path is not a directory: $local_assets"
  [[ -z $(find "$local_assets" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail "Windows output directory is not empty: $local_assets"
fi

for command in git iconv node pnpm scp shasum ssh; do
  command -v "$command" >/dev/null 2>&1 || fail "Missing required command: $command"
done
[[ -f "$updater_key" && -f "$updater_key.pub" ]] || fail "Updater key and public companion are required."
[[ -z ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-} ]] || fail "LemonPi's updater key is passwordless; unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD."
if [[ -n $(git -C "$repo_root" status --porcelain) ]]; then
  fail "The release candidate must be fully committed and clean."
fi
git -C "$repo_root" fetch origin main >/dev/null
git -C "$repo_root" merge-base --is-ancestor "$revision" origin/main || fail "Revision $revision is not available from origin/main."
node "$repo_root/scripts/verify-release-version.mjs" --tag "v$version" >/dev/null

configured_public_key=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plugins.updater.pubkey)' "$repo_root/src-tauri/tauri.conf.json")
local_public_key=$(tr -d '\r\n' < "$updater_key.pub")
[[ "$configured_public_key" == "$local_public_key" ]] || fail "Updater public key does not match tauri.conf.json."
expected_public_hash=$(printf '%s' "$local_public_key" | shasum -a 256 | awk '{print $1}')

bootstrap_command=$(cat <<PS
\$repository = $(ps_quote "$windows_repo")
\$expectedOrigin = $(ps_quote "$expected_origin")
if (-not (Test-Path -LiteralPath \$repository -PathType Container)) {
  & git clone --origin origin \$expectedOrigin \$repository
  if (\$LASTEXITCODE -ne 0) { throw "Could not bootstrap the Windows LemonPi checkout" }
}
\$origin = (& git -C \$repository remote get-url origin).Trim()
if (\$LASTEXITCODE -ne 0 -or \$origin -ne \$expectedOrigin) { throw "Windows checkout origin does not match the approved LemonPi repository" }
& git -C \$repository fetch --prune origin
if (\$LASTEXITCODE -ne 0) { throw "Could not fetch the Windows LemonPi checkout" }
Write-Output "REMOTE_REPOSITORY_READY"
PS
)
bootstrap_result=$(run_remote "$bootstrap_command")
printf '%s\n' "$bootstrap_result" | tr -d '\r' | grep -Fx 'REMOTE_REPOSITORY_READY' >/dev/null || fail "Windows repository bootstrap did not complete."

key_probe_command=$(cat <<PS
\$keyPath = Join-Path \$env:USERPROFILE ".tauri\\lemonpi-updater.key"
\$publicPath = "\$keyPath.pub"
\$privateExists = Test-Path -LiteralPath \$keyPath -PathType Leaf
\$publicExists = Test-Path -LiteralPath \$publicPath -PathType Leaf
if (\$privateExists -xor \$publicExists) { throw "Windows updater key is incomplete; refusing to replace it" }
if (\$privateExists) {
  \$publicText = (Get-Content -LiteralPath \$publicPath -Raw).Trim()
  \$bytes = [Text.Encoding]::UTF8.GetBytes(\$publicText)
  \$hash = ([Security.Cryptography.SHA256]::Create().ComputeHash(\$bytes) | ForEach-Object ToString x2) -join ""
  Write-Output "KEY_STATUS=existing"
  Write-Output "PUBLIC_SHA256=\$hash"
} else {
  \$temporary = Join-Path \$env:TEMP ("lemonpi-updater-key-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path \$temporary | Out-Null
  Write-Output "KEY_STATUS=missing"
  Write-Output "TEMP_DIRECTORY=\$temporary"
}
PS
)
key_probe=$(run_remote "$key_probe_command" | tr -d '\r')
key_status=$(printf '%s\n' "$key_probe" | awk -F= '/^KEY_STATUS=/{print $2; exit}')
case "$key_status" in
  existing)
    remote_public_hash=$(printf '%s\n' "$key_probe" | awk -F= '/^PUBLIC_SHA256=/{print $2; exit}')
    [[ "$remote_public_hash" == "$expected_public_hash" ]] || fail "Existing Windows updater public key does not match LemonPi's configured key."
    ;;
  missing)
    remote_key_temp=$(printf '%s\n' "$key_probe" | sed -n 's/^TEMP_DIRECTORY=//p' | head -1)
    is_safe_remote_cleanup_target "$remote_key_temp" || fail "Windows key provisioning returned an unsafe temporary path."
    remote_private_temp="$remote_key_temp/lemonpi-updater.key"
    remote_public_temp="$remote_key_temp/lemonpi-updater.key.pub"
    remote_private_scp=${remote_private_temp//\\//}
    remote_public_scp=${remote_public_temp//\\//}
    scp -q "$updater_key" "$windows_host:$remote_private_scp"
    scp -q "$updater_key.pub" "$windows_host:$remote_public_scp"
    finalize_key_script="$temporary_dir/finalize-updater-key.ps1"
    cat > "$finalize_key_script" <<'PS'
param(
  [Parameter(Mandatory = $true)]
  [string]$Temporary,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedHash
)

$keyDirectory = Join-Path $env:USERPROFILE ".tauri"
$keyPath = Join-Path $keyDirectory "lemonpi-updater.key"
$publicPath = "$keyPath.pub"
$temporaryKey = Join-Path $Temporary "lemonpi-updater.key"
$temporaryPublic = "$temporaryKey.pub"
function Set-And-TestPrivateKeyAcl([string]$path) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $sid) { throw "Current Windows identity has no SID" }
  $acl = Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $fullControl, $allow)))
  Set-Acl -LiteralPath $path -AclObject $acl
  $verified = Get-Acl -LiteralPath $path
  $rules = @($verified.Access | Where-Object { $_.AccessControlType -eq $allow })
  $verifiedSid = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
  return $verified.AreAccessRulesProtected -and $rules.Count -eq 1 -and $verifiedSid.Value -eq $sid.Value -and (($rules[0].FileSystemRights -band $fullControl) -eq $fullControl)
}
if ((Test-Path -LiteralPath $keyPath) -or (Test-Path -LiteralPath $publicPath)) { throw "Windows updater key appeared during provisioning; refusing to overwrite it" }
if (-not (Test-Path -LiteralPath $temporaryKey -PathType Leaf) -or -not (Test-Path -LiteralPath $temporaryPublic -PathType Leaf)) { throw "Transferred updater key files are incomplete" }
$publicText = (Get-Content -LiteralPath $temporaryPublic -Raw).Trim()
$bytes = [Text.Encoding]::UTF8.GetBytes($publicText)
$actualHash = ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object ToString x2) -join ""
if ($actualHash -ne $ExpectedHash) { throw "Transferred updater public key does not match the approved key" }
$privateMoved = $false
$publicMoved = $false
try {
  if (-not (Set-And-TestPrivateKeyAcl $temporaryKey)) { throw "Could not restrict and verify the Windows updater key ACL" }
  New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
  Move-Item -LiteralPath $temporaryKey -Destination $keyPath
  $privateMoved = $true
  Move-Item -LiteralPath $temporaryPublic -Destination $publicPath
  $publicMoved = $true
  if (-not (Set-And-TestPrivateKeyAcl $keyPath)) { throw "Final Windows updater key ACL verification failed" }
} catch {
  if ($privateMoved) { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }
  if ($publicMoved) { Remove-Item -LiteralPath $publicPath -Force -ErrorAction SilentlyContinue }
  throw
} finally {
  Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "WINDOWS_UPDATER_KEY_PROVISIONED"
PS
    remote_finalize_script_uploaded=true
    scp -q "$finalize_key_script" "$windows_host:$remote_finalize_script"
    finalize_result=$(run_remote "& $(ps_quote "$remote_finalize_script") -Temporary $(ps_quote "$remote_key_temp") -ExpectedHash $(ps_quote "$expected_public_hash")" | tr -d '\r')
    printf '%s\n' "$finalize_result" | grep -Fx 'WINDOWS_UPDATER_KEY_PROVISIONED' >/dev/null || fail "Windows updater key provisioning did not complete."
    remove_remote_file "$remote_finalize_script" >/dev/null
    remote_key_temp=""
    ;;
  *) fail "Windows key probe returned an invalid status." ;;
esac

remote_output="C:\\Users\\cmcel\\AppData\\Local\\lemonpi-release-assets\\$version-$short_revision-$remote_stamp"
remote_script_uploaded=true
scp -q "$repo_root/scripts/release-windows.ps1" "$windows_host:$remote_script"
remote_build_command="& $(ps_quote "$remote_script") -Repository $(ps_quote "$windows_repo") -Revision $(ps_quote "$revision") -OutputDirectory $(ps_quote "$remote_output")"
remote_result=$(run_remote_build "$remote_build_command" | tr -d '\r')

result_revision=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_REVISION=/{sub(/^[^=]*=/, ""); print; exit}')
result_version=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_VERSION=/{sub(/^[^=]*=/, ""); print; exit}')
remote_installer=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_INSTALLER=/{sub(/^[^=]*=/, ""); print; exit}')
remote_signature=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_SIGNATURE=/{sub(/^[^=]*=/, ""); print; exit}')
remote_installer_hash=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_INSTALLER_SHA256=/{sub(/^[^=]*=/, ""); print; exit}')
remote_signature_hash=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_SIGNATURE_SHA256=/{sub(/^[^=]*=/, ""); print; exit}')
authenticode_status=$(printf '%s\n' "$remote_result" | awk -F= '/^RESULT_AUTHENTICODE_STATUS=/{sub(/^[^=]*=/, ""); print; exit}')

[[ "$result_revision" == "$revision" && "$result_version" == "$version" ]] || fail "Windows build result did not match the requested revision and version."
[[ -n "$remote_installer" && -n "$remote_signature" && -n "$remote_installer_hash" && -n "$remote_signature_hash" ]] || fail "Windows build did not return complete signed artifact metadata."
remote_installer_scp=${remote_installer//\\//}
remote_signature_scp=${remote_signature//\\//}
installer_name=$(basename "$remote_installer_scp")
signature_name=$(basename "$remote_signature_scp")
[[ "$installer_name" == "LemonPi_${version}_x64-setup.exe" && "$signature_name" == "$installer_name.sig" ]] || fail "Windows build returned unexpected artifact names."
scp -q "$windows_host:$remote_installer_scp" "$temporary_dir/"
scp -q "$windows_host:$remote_signature_scp" "$temporary_dir/"

local_installer_hash=$(shasum -a 256 "$temporary_dir/$installer_name" | awk '{print $1}')
local_signature_hash=$(shasum -a 256 "$temporary_dir/$signature_name" | awk '{print $1}')
[[ "$local_installer_hash" == "$remote_installer_hash" ]] || fail "Windows installer hash changed during transfer."
[[ "$local_signature_hash" == "$remote_signature_hash" ]] || fail "Windows updater signature hash changed during transfer."

mkdir -p "$local_assets"
mv "$temporary_dir/$installer_name" "$local_assets/$installer_name"
mv "$temporary_dir/$signature_name" "$local_assets/$signature_name"

printf 'RESULT_REVISION=%s\n' "$revision"
printf 'RESULT_VERSION=%s\n' "$version"
printf 'RESULT_WINDOWS_INSTALLER=%s\n' "$local_assets/$installer_name"
printf 'RESULT_WINDOWS_SIGNATURE=%s\n' "$local_assets/$signature_name"
printf 'RESULT_WINDOWS_INSTALLER_SHA256=%s\n' "$local_installer_hash"
printf 'RESULT_WINDOWS_SIGNATURE_SHA256=%s\n' "$local_signature_hash"
printf 'RESULT_AUTHENTICODE_STATUS=%s\n' "$authenticode_status"
