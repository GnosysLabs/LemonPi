# LemonPi implementation plan

## Product boundary

LemonPi is a native GUI client for Pi. It does not fork or reimplement Pi. The desktop app owns presentation, process supervision, and narrowly scoped native capabilities; the Pi process remains the source of truth for models, tools, extensions, sessions, and agent behavior.

## Architecture

```text
React + TypeScript
        ↕ Tauri commands and ordered events
Rust process supervisor
        ↕ strict LF-delimited JSONL over stdin/stdout
pi --mode rpc
        ↕ process-local pi.events (bridge milestone)
pi-subagents
```

### Current vertical slice

- Discover an existing `pi` executable, including common macOS and Windows npm locations.
- Ask for an explicit project-trust choice before process launch.
- Spawn one Pi RPC process per active LemonPi window.
- Correlate command responses by generated request id.
- Stream assistant, thinking, tool, queue, retry, compaction, extension UI, and process events.
- Keep the WebView away from direct process and filesystem access.

### Subagent bridge

The stable `pi-subagents` v1 RPC is process-local to `pi.events`; Pi's external RPC protocol does not expose it directly. LemonPi will load a small bridge extension with `-e` alongside normal extension discovery. The bridge will connect to a private OS-local IPC endpoint created by Rust:

- Unix domain socket with owner-only permissions on macOS.
- Named pipe scoped to the current user on Windows.
- Per-launch random authentication token.
- Bounded LF-delimited JSON records with request correlation.

Live display data comes from the package's machine-readable lifecycle artifacts (`status.json`, bounded recent activity, and public transcript paths). The bridge will add control-plane capabilities and call only public versioned channels:

- `subagents:rpc:v1:ready`
- `subagents:rpc:v1:request`
- `subagents:rpc:v1:reply:<requestId>`
- the capability-advertised async completion and process-terminal events

Supported controls will be capability-driven: `ping`, `status`, `spawn`, `steer`, `interrupt`, `stop`, and `resume`. Fleet summary keys remain opaque; controls use package-owned run targets and stable `(runId, index)` correlation from status details. Lifecycle artifacts remain the read-only observability source; terminal rendering is never scraped.

## Milestones

### M0: RPC vertical slice (current)

- [x] Tauri/React/Rust scaffold
- [x] Pi discovery and version check
- [x] Explicit project trust
- [x] Bounded strict-LF JSONL parser
- [x] Streaming transcript and tool cards
- [x] Prompt, steer, follow-up, and abort
- [x] Model/thinking controls and session statistics
- [x] Extension dialogs, notifications, statuses, and editor text
- [x] Frontend and Rust tests
- [ ] Manual packaged-app validation on Windows

### M1: First-class agent fleet

- [ ] Private local IPC server in Rust
- [ ] Bundled LemonPi Pi extension
- [ ] Capability handshake and graceful no-plugin state
- [x] Live Agent Activity drawer
- [x] Active/recent child status, tools, usage, and visible output from lifecycle artifacts
- [ ] Full child transcript inspection
- [ ] Steer, stop, interrupt, and resume controls
- [ ] Direct async delegation form

### M2: Sessions

- [ ] Session browser and search
- [ ] Session tree visualization
- [ ] Fork, clone, rename, compact, export
- [ ] Multiple project windows
- [ ] Durable local workspace preferences

### Settings and packages

- [x] Full user/project Pi settings surface with typed controls
- [x] Advanced JSON editor that preserves extension-defined settings
- [x] Pi-native package install, update, list, and remove UI
- [x] Required `npm:pi-subagents` bootstrap before Pi launch
- [ ] Package gallery discovery and metadata previews

### M3: Distribution

- [ ] macOS signing, notarization, and updater
- [ ] Windows code signing and updater
- [ ] Guided Pi installation
- [ ] Optional pinned bundled Pi/Node runtime
- [ ] System-Pi compatibility mode

## Safety and testing rules

- Never launch with `--approve` without a direct trust choice.
- Never parse RPC with a Unicode-aware generic line reader; LF is the only frame delimiter.
- Bound every cross-process record and diagnostic buffer.
- Never expose arbitrary shell or filesystem commands to the WebView.
- Tag events by Pi process id so stale process output cannot mutate a replacement session.
- Reject pending requests when a process exits or their deadline expires.
- Keep one writer in the shared worktree; use fresh read-only reviewers for independent checks.
