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
- Shows a live Agent Activity drawer with child role, task, model, effort, elapsed time, token usage, current tool, recent tools, and child-visible output.
- Narrates the main agent's live work with current actions, auto-expanded running tools, and a transient token-by-token stream of provider-surfaced reasoning.
- Lists saved Pi sessions for the active project and reopens them through Pi's `switch_session` RPC without copying or migrating session data.
- Remembers recent projects, their trust choices, and the last active workspace across launches.
- Exposes Pi's user and project settings in a native categorized GUI, with a raw JSON escape hatch for new or extension-defined settings.
- Manages user and project Pi packages through Pi's own install, update, list, and remove commands.
- Treats `npm:pi-subagents` as a required core package and installs it automatically through Pi before the first LemonPi session when needed.

The app intentionally uses Pi's subprocess RPC boundary instead of reimplementing Pi. This preserves the user's existing authentication, models, settings, skills, extensions, and session files.

## Requirements

- macOS or Windows
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
