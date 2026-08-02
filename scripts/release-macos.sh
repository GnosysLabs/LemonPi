#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
config="$repo_root/src-tauri/tauri.conf.json"
version=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$config")
release_tag=${1:-"v$version"}
requested_revision=${2:-HEAD}
updater_key=${LEMONPI_UPDATER_KEY_PATH:-"$HOME/.tauri/lemonpi-updater.key"}
notary_profile=${APPLE_KEYCHAIN_PROFILE:-AC_NOTARY}
identity=${APPLE_SIGNING_IDENTITY:-"Developer ID Application: Christopher McElvogue (4PDUNTF69S)"}
assets_dir="$repo_root/src-tauri/target/release/release-assets"
bundle_dir="$repo_root/src-tauri/target/release/bundle/macos"
app_bundle="$bundle_dir/LemonPi.app"
zip_asset="$assets_dir/LemonPi_${version}_macOS-Apple-Silicon.zip"
updater_archive="$assets_dir/LemonPi_${version}_macOS-Apple-Silicon_aarch64.app.tar.gz"
temporary_dir=$(mktemp -d /tmp/lemonpi-release.XXXXXX)

cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

fail() {
  echo "release-macos: $*" >&2
  exit 1
}

[[ "$(uname -m)" == "arm64" ]] || fail "Apple Silicon (arm64) is required."
for command in cargo codesign ditto git node pnpm security spctl tar unzip xcrun; do
  command -v "$command" >/dev/null 2>&1 || fail "Missing required command: $command"
done
[[ -f "$updater_key" && -f "$updater_key.pub" ]] || fail "Updater key and public companion are required."
[[ -z ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-} ]] || fail "LemonPi's updater key is passwordless; unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD."

if [[ -n $(git -C "$repo_root" status --porcelain) ]]; then
  fail "The release candidate must be fully committed and clean."
fi
revision=$(git -C "$repo_root" rev-parse "$requested_revision^{commit}")
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$revision" ]] || fail "HEAD must equal the requested release revision."
git -C "$repo_root" fetch origin main >/dev/null
git -C "$repo_root" merge-base --is-ancestor "$revision" origin/main || fail "Release revision is not available from origin/main."
node "$repo_root/scripts/verify-release-version.mjs" --tag "$release_tag" >/dev/null

available_kb=$(df -Pk "$repo_root" | awk 'NR == 2 { print $4 }')
(( available_kb >= 10485760 )) || fail "At least 10 GiB of free disk space is required."

configured_public_key=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).plugins.updater.pubkey)' "$config")
key_public_key=$(tr -d '\r\n' < "$updater_key.pub")
[[ "$configured_public_key" == "$key_public_key" ]] || fail "Updater public key does not match tauri.conf.json."

security find-identity -v -p codesigning | grep -F "$identity" >/dev/null || fail "Developer ID identity is unavailable."
xcrun notarytool history --keychain-profile "$notary_profile" --output-format json >/dev/null || fail "Notary profile is unavailable."

preflight_file="$temporary_dir/updater-signing-preflight"
printf 'lemonpi updater signing preflight\n' > "$preflight_file"
(
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$updater_key"
  trap 'unset TAURI_SIGNING_PRIVATE_KEY_PATH' EXIT
  pnpm --dir "$repo_root" tauri signer sign --password "" "$preflight_file" >/dev/null
)
[[ -s "$preflight_file.sig" ]] || fail "Updater signing preflight did not produce a signature."

rm -rf "$assets_dir"
mkdir -p "$assets_dir"
(
  unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  # Tauri build accepts a private-key path through TAURI_SIGNING_PRIVATE_KEY.
  export TAURI_SIGNING_PRIVATE_KEY="$updater_key"
  export APPLE_SIGNING_IDENTITY="$identity"
  export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
  export CARGO_PROFILE_RELEASE_STRIP=${CARGO_PROFILE_RELEASE_STRIP:-false}
  pnpm --dir "$repo_root" tauri build --ci --bundles app
)
[[ -d "$app_bundle" ]] || fail "Tauri did not produce LemonPi.app."

notary_zip="$temporary_dir/LemonPi_${version}_notarization.zip"
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$notary_zip"
xcrun notarytool submit "$notary_zip" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$app_bundle"
xcrun stapler validate "$app_bundle"

rm -f "$zip_asset" "$updater_archive" "$updater_archive.sig"
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$zip_asset"
COPYFILE_DISABLE=1 tar -C "$bundle_dir" -czf "$updater_archive" "LemonPi.app"
(
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$updater_key"
  trap 'unset TAURI_SIGNING_PRIVATE_KEY_PATH' EXIT
  pnpm --dir "$repo_root" tauri signer sign --password "" "$updater_archive" >/dev/null
)
[[ -s "$updater_archive.sig" ]] || fail "Updater archive signature is missing."

codesign --verify --deep --strict --verbose=2 "$app_bundle"
spctl --assess --type execute --verbose=4 "$app_bundle"
unzip -tq "$zip_asset"
unzip -Z1 "$zip_asset" | grep -Fx 'LemonPi.app/' >/dev/null
tar -tzf "$updater_archive" | grep -Fx 'LemonPi.app/' >/dev/null

printf 'RESULT_REVISION=%s\n' "$revision"
printf 'RESULT_VERSION=%s\n' "$version"
printf 'RESULT_MACOS_ZIP=%s\n' "$zip_asset"
printf 'RESULT_MACOS_UPDATER=%s\n' "$updater_archive"
printf 'RESULT_MACOS_SIGNATURE=%s\n' "$updater_archive.sig"
