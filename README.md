# LemonPi

A native desktop workspace for the [Pi coding agent](https://pi.dev), built with Tauri v2, React, TypeScript, and Rust.

## Current vertical slice

- Detects an existing Pi installation.
- Opens a project with an explicit trust decision.
- Runs the real `pi --mode rpc` process in that project.
- Streams assistant text, thinking, tool calls, tool output, queues, and lifecycle events.
- Supports prompt, steer, follow-up, abort, model cycling, and thinking-level cycling.
- Handles Pi extension dialogs and notifications through the RPC extension UI protocol.
- Displays session context and cost statistics.
- Shows a live Command center with child role, task, model, effort, elapsed time, token usage, current tool, child-visible output, direct steering, and stop controls on active agents.
- Narrates the main agent's live work with current actions, auto-expanded running tools, and a transient token-by-token stream of provider-surfaced reasoning.
- Keeps Main Pi in a read-only supervisor role while dependency-ready implementation lanes run concurrently in managed worktrees, with deterministic Git checkpoints, per-result integration, and deduplicated validation.
- Lists saved Pi sessions for the active project and reopens them through Pi's `switch_session` RPC without copying or migrating session data.
- Remembers recent projects, their trust choices, and the last active workspace across launches.
- Exposes Pi's user and project settings in a native categorized GUI, with a raw JSON escape hatch for new or extension-defined settings.
- Manages user and project Pi packages through Pi's own install, update, list, and remove commands.
- Treats `npm:pi-subagents`, `npm:pi-web-access`, `npm:@juicesharp/rpiv-ask-user-question`, and `npm:@juicesharp/rpiv-todo` as required core packages and installs them automatically through Pi before the first LemonPi session when needed.
- Renders structured agent questions as native choice cards, multi-select controls, custom-answer fields, and rich option previews instead of exposing Pi's flattened RPC fallback strings.
- Renders `rpiv-todo`'s structured, session-persistent task snapshots as a native progress panel above the composer.

The app intentionally uses Pi's subprocess RPC boundary instead of reimplementing Pi. This preserves the user's existing authentication, models, settings, skills, extensions, and session files.

## Requirements

- macOS, Windows, or Linux
- [Pi](https://pi.dev) available on `PATH`, in a common installation location, or configured through `LEMONPI_PI_PATH`. Internet access is required on first launch if Pi has not already installed LemonPi's required packages.
- Node.js and pnpm for development
- Rust toolchain and Tauri platform prerequisites

## Development

```bash
pnpm install
pnpm tauri dev
```

Validation:

```bash
pnpm test
pnpm test:orchestration-runtime
pnpm build
cd src-tauri && cargo test
```

The orchestration replay is a deterministic synthetic fixture, not a wall-clock benchmark of every repository. It exercises policy migration, dirty-tree recovery, worktree ownership, fresh-worker rules, launch preflight, review/validation deduplication, failure recovery, and visible mission progress. See [Orchestration policy v5](docs/orchestration-policy-v5.md) for the current runtime contract and operator details.

## Signed releases and updates

LemonPi verifies every updater artifact against the public key embedded in `src-tauri/tauri.conf.json`. The private updater key is deliberately not in this repository. Keep `~/.tauri/lemonpi-updater.key` owner-readable only, retain an encrypted backup, and never commit, print, or share it. Losing that key after a public release would prevent installed clients from accepting future updates.

### Manual v0.1.2 release procedure

The v0.1.2 candidate is assembled from a detached, locally built Apple Silicon macOS app and a GitHub-hosted Windows x64 NSIS build. Do **not** tag, upload, or publish until both native outputs and the assembled hashes have been independently verified. The source candidate must be fully committed, clean, and already reachable from `origin/main`; both builders use the same exact 40-character commit SHA.

Prerequisites:

- macOS Apple Silicon with the `Developer ID Application: Christopher McElvogue (4PDUNTF69S)` identity, the `AC_NOTARY` keychain profile, at least 10 GiB free, and the passwordless LemonPi updater key plus `.pub` companion at `~/.tauri/lemonpi-updater.key`.
- A repository maintainer permitted to manually dispatch GitHub Actions and access the `TAURI_SIGNING_PRIVATE_KEY` Actions secret. The hosted workflow uses that signing key only; it neither accepts a key password nor creates or edits a GitHub Release.
- `pnpm`, Rust, Git, and the macOS platform prerequisites.

After the v0.1.2 candidate is committed and pushed, record its SHA and build macOS in a unique detached `/tmp` worktree so the main checkout remains untouched:

```bash
revision=$(git rev-parse HEAD)
repo_root=$(git rev-parse --show-toplevel)
git -C "$repo_root" fetch origin main
worktree=$(mktemp -d /tmp/lemonpi-v0.1.2.XXXXXX)
rmdir "$worktree"
git -C "$repo_root" worktree add --detach "$worktree" "$revision"
(
  set -e
  cd "$worktree"
  git merge-base --is-ancestor "$revision" origin/main
  pnpm install --frozen-lockfile
  node scripts/verify-release-version.mjs --tag v0.1.2
  scripts/release-macos.sh v0.1.2 "$revision"
)
printf 'Retain release worktree: %s\n' "$worktree"
```

Record the printed worktree path and keep that detached worktree through the Windows artifact download, assembly, draft re-download verification, and publication; do not remove it automatically after the macOS build.

In GitHub Actions, manually dispatch `.github/workflows/release-windows.yml` (the **Build LemonPi Windows x64 NSIS candidate** workflow) with `revision` set to that exact lowercase 40-character SHA and `expected_version` set to `0.1.2`. It checks out that SHA with full history, rejects a dirty or non-`origin/main` candidate, runs the NSIS-only Windows x64 build, and uploads a seven-day artifact named `lemonpi-windows-x64-nsis-<revision>` where `<revision>` is the full SHA. Download and extract that artifact without changing its contents. Before assembly, inspect `windows-build-metadata.json`: its `revision`, `version`, and `name` must be the requested SHA, `0.1.2`, and `LemonPi_0.1.2_x64-setup.exe`; recompute and compare both SHA-256 values in `hashes`. Keep the recorded `run`, `runner`, and `time` fields with the release evidence. After verification, preserve `windows-build-metadata.json` in that evidence location outside the assembler input directory, then copy only the verified `.exe` and `.exe.sig` into a fresh Windows assembler directory.

Assemble only the verified macOS output and downloaded Windows artifact:

```bash
node scripts/assemble-desktop-release.mjs \
  --macos-directory src-tauri/target/release/release-assets \
  --windows-directory /path/to/windows-assembler-input \
  --output-directory src-tauri/target/release/release-staging \
  --published-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(cd src-tauri/target/release/release-staging && shasum -a 256 -c SHA256SUMS.txt)
```

The staging directory must contain exactly these release assets plus `latest.json` and `SHA256SUMS.txt`:

- `LemonPi_0.1.2_macOS-Apple-Silicon.zip` — the human macOS download.
- `LemonPi_0.1.2_macOS-Apple-Silicon_aarch64.app.tar.gz` and `.sig` — the signed macOS updater artifact; the `_aarch64` token is required by the updater manifest.
- `LemonPi_0.1.2_x64-setup.exe` and `.sig` — the signed Windows updater artifact.

Only after the staged manifest, asset names, and checksums are independently checked should a maintainer create and push an annotated `v0.1.2` tag at that exact SHA, create a **draft** GitHub Release, upload the staged files, and download the draft assets again for a second `SHA256SUMS.txt` verification. Publish the draft only after that re-download succeeds. For example, the release sequence is `git tag -a v0.1.2 "$revision"`, `git push origin v0.1.2`, draft creation/upload, authenticated draft re-download, checksum verification, then publication. The release scripts and hosted Windows workflow never tag, push, upload release assets, or publish.

After publication and preservation of the release evidence, remove the retained worktree and prune stale worktree metadata:

```bash
git -C "$repo_root" worktree remove --force "$worktree"
git -C "$repo_root" worktree prune
```

The Windows NSIS installer is updater-signed but may be Authenticode `NotSigned`, so Microsoft SmartScreen can still warn users. The hosted build deliberately performs no prepublication antivirus scan or sample submission; do not treat an AV verdict as a publication gate or upload release candidates to third-party scanners from this procedure. Release `v0.1.1` remains an unpublished draft retained as incident evidence and must not be deleted, altered, or republished. The retired `scripts/release-windows.ps1` and `scripts/release-windows-remote.sh` procedures are pinned to v0.1.1 and must not be used for v0.1.2 or later.

`.github/workflows/release.yml` is unchanged: it remains an optional manually dispatched all-platform fallback with the macOS Intel/Apple Silicon, Windows x64, and Linux x64 matrix and draft-first manifest publishing. Pushing a tag does not trigger it, and it is not part of this primary two-platform procedure.

## Architecture

```text
React UI
   ↕ Tauri commands/events
Rust process supervisor
   ↕ strict LF-delimited JSONL over stdin/stdout
pi --mode rpc
```

LemonPi verifies the required `npm:pi-subagents`, `npm:pi-web-access`, `npm:@juicesharp/rpiv-ask-user-question`, and `npm:@juicesharp/rpiv-todo` packages before launching Pi and asks Pi's native package manager to install any missing member. Subagents supply orchestration and machine-readable lifecycle artifacts; web access registers research tools; ask-user-question gives the model a structured clarification tool; and rpiv-todo supplies persistent task snapshots. LemonPi turns the question package's RPC fallback into a native questionnaire and the todo package's public tool-result envelope into a native progress panel. Terminal rendering is never scraped.

Main Pi keeps the persistent `rpiv-todo` task plan above the composer. Delegated-agent cards stay focused on purpose, lifecycle, steering, and live activity instead of requiring each short worker to maintain a second checklist.

LemonPi orchestration policy v5 is enforced by the extension runtime rather than model prose alone. Historical session summaries keep product facts and user decisions, but old scheduler instructions are explicitly superseded. Ordinary one-repository UI changes take a direct fast path; broader `lemonpi_dispatch` work uses the live agent roster, runtime-owned child budgets and telemetry, exact owned paths, unique output artifacts, and managed worktrees. `lemonpi_git` owns safe local inspection, recovery checkpoints, deterministic worker-result integration, commits, and worktree retirement; it never resets, cleans, force-pushes, changes remotes, or pushes. `lemonpi_validate` records content-aware evidence and reuses an unchanged passing result instead of rerunning it. The session task panel exposes append-only milestones, active workers, validation, and recovery work as durable mission progress.

## Project trust

LemonPi never silently approves project-local Pi resources. Opening a project requires choosing one of:

- **Trust and open**: launches Pi with `--approve`.
- **Open safely**: launches Pi with `--no-approve`, ignoring project-local Pi settings, extensions, skills, and packages.

Pi and its extensions still execute with the user's operating-system permissions. LemonPi is a UI and process boundary, not a sandbox.
