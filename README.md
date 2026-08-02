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
- Keeps Main Pi in a read-only supervisor role and requires broad implementation work to proceed through bounded, sequential worker chunks with an inspection checkpoint after each one.
- Lists saved Pi sessions for the active project and reopens them through Pi's `switch_session` RPC without copying or migrating session data.
- Remembers recent projects, their trust choices, and the last active workspace across launches.
- Exposes Pi's user and project settings in a native categorized GUI, with a raw JSON escape hatch for new or extension-defined settings.
- Manages user and project Pi packages through Pi's own install, update, list, and remove commands.
- Treats `npm:pi-subagents` as a required core package and installs it automatically through Pi before the first LemonPi session when needed.

The app intentionally uses Pi's subprocess RPC boundary instead of reimplementing Pi. This preserves the user's existing authentication, models, settings, skills, extensions, and session files.

## Requirements

- macOS, Windows, or Linux
- [Pi](https://pi.dev) available on `PATH`, in a common installation location, or configured through `LEMONPI_PI_PATH`. Internet access is required on first launch if Pi has not already installed `npm:pi-subagents`.
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
pnpm build
cd src-tauri && cargo test
```

## Signed releases and updates

LemonPi verifies every updater artifact against the public key embedded in `src-tauri/tauri.conf.json`. The private updater key is deliberately not in this repository. Keep `~/.tauri/lemonpi-updater.key` owner-readable only, retain an encrypted backup, and never commit, print, or share it. Losing that key after a public release would prevent installed clients from accepting future updates.

### Manual v0.1.1 release procedure

The first release is assembled from a locally built Apple Silicon macOS app and a remotely built Windows x64 installer. Do **not** push a tag before both native builds and assembly verification pass. The source candidate must be fully committed, clean, and available on `origin/main`; both builders receive the same commit SHA.

Prerequisites:

- macOS Apple Silicon with the `Developer ID Application: Christopher McElvogue (4PDUNTF69S)` identity, the `AC_NOTARY` keychain profile, at least 10 GiB free, and the passwordless LemonPi updater key plus `.pub` companion at `~/.tauri/lemonpi-updater.key`.
- SSH access to the Windows builder. The scripts default to `noise-windows` and `C:\Users\cmcel\LemonPi`; set `LEMONPI_WINDOWS_HOST` or `LEMONPI_WINDOWS_REPO` only when those defaults are intentionally different. The remote script bootstraps the checkout and provisions the updater key only when both remote key files are absent.
- `pnpm`, Rust, Git, and the platform build prerequisites on both machines.

After the v0.1.1 candidate is committed and pushed, record its SHA and build both platforms:

```bash
revision=$(git rev-parse HEAD)
scripts/release-macos.sh v0.1.1 "$revision"
scripts/release-windows-remote.sh "$revision"
node scripts/assemble-desktop-release.mjs \
  --macos-directory src-tauri/target/release/release-assets \
  --windows-directory src-tauri/target/release/windows-assets \
  --output-directory src-tauri/target/release/release-staging \
  --published-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

The staging directory must contain exactly these release assets plus `latest.json` and `SHA256SUMS.txt`:

- `LemonPi_0.1.1_aarch64.app.zip` — the human macOS download.
- `LemonPi_0.1.1_aarch64.app.tar.gz` and `.sig` — the signed macOS updater artifact.
- `LemonPi_0.1.1_x64-setup.exe` and `.sig` — the signed Windows updater artifact.

Only after the staged hashes and manifest have been independently checked should a maintainer create an annotated `v0.1.1` tag at that exact SHA, push it, create a **draft** GitHub Release, upload the staged files, download them again to verify `SHA256SUMS.txt`, and publish the draft. The release scripts never tag, push, or call GitHub Releases. Because this is the first baseline installation, the updater path itself cannot be demonstrated until a later version exists. The Windows NSIS installer is updater-signed but may be Authenticode `NotSigned`, so Microsoft SmartScreen can still warn users.

`.github/workflows/release.yml` is an optional manually dispatched all-platform fallback. It retains the four-platform macOS Intel/Apple Silicon, Windows x64, and Linux x64 matrix and draft-first manifest publishing; pushing a tag does not trigger it. It is not part of the primary two-platform release procedure.

## Architecture

```text
React UI
   ↕ Tauri commands/events
Rust process supervisor
   ↕ strict LF-delimited JSONL over stdin/stdout
pi --mode rpc
```

LemonPi verifies the required `npm:pi-subagents` package before launching Pi and asks Pi's native package manager to install it when missing. It reads the package's machine-readable lifecycle artifacts for live observability; terminal rendering is never scraped. The next integration milestone is a bundled LemonPi bridge extension using Pi's in-process `pi.events` bus and the stable `pi-subagents` v1 extension RPC. That bridge will add acknowledged steer, interrupt, stop, resume, and spawn controls over a private local IPC channel.

## Project trust

LemonPi never silently approves project-local Pi resources. Opening a project requires choosing one of:

- **Trust and open**: launches Pi with `--approve`.
- **Open safely**: launches Pi with `--no-approve`, ignoring project-local Pi settings, extensions, skills, and packages.

Pi and its extensions still execute with the user's operating-system permissions. LemonPi is a UI and process boundary, not a sandbox.
