# LemonPi narration

First-party Pi extension bundled with LemonPi. It supplies visible narration, a direct low-risk UI fast path, independent delegated-run scheduling for broader work, durable mission recovery, and direct steering/stop controls. The Rust supervisor pins `pi-subagents@0.40.0` and reproducibly applies compatibility v1 before Pi starts so the package preserves structured stop provenance in its own status artifacts.

## Main Pi operating manual

The `before_agent_start` hook injects a versioned operating manual into Main Pi's system prompt on every Main Pi turn, including the first turn of a new task and synthetic recovery wakes. `PI_SUBAGENT_CHILD=1` explicitly suppresses it in workers, so children receive their own role contract instead of supervisor instructions. The manual teaches the complete decision flow: fast path versus one read-only child versus independent dispatch, exact lane fields, settings-owned model/thinking and budgets, asynchronous handoff behavior, every terminal state's required next action, partial continuation, deterministic integration, exact-path fast-path Git finalization, validation reuse, Git boundaries, passive UI snapshots, and the two-failure infrastructure fallback. Runtime enforcement remains authoritative when old conversation text conflicts with the manual.

## Direct UI fast path

One-repository changes to one to five ordinary UI files run directly in Main Pi through `lemonpi_fast_path`. The runtime permits edits only to the declared paths and one focused `lemonpi_validate` check. This path has no worktree, delegation, roadmap gate, reviewer, wave check, or final holistic check. Eligible UI dispatches are converted directly to the fast path so the slower path cannot be selected accidentally or cost another tool-negotiation turn.

A visible UI request cannot silently dispatch backend, protocol, database, or synchronization work. LemonPi requires the local visible slice first and treats synchronization as an explicit second phase.

## Independent dispatch

`lemonpi_dispatch` is the path for multi-repository, genuinely parallel, materially risky, or otherwise non-fast-path work. One tool call may describe many lanes, but LemonPi submits every lane through the stable `pi-subagents` RPC `spawn` method as a separate asynchronous run.

Near-simultaneous terminal events are coalesced for 300 ms. A terminal event only queues reconciliation; its synthetic wake cannot begin until Main Pi's current turn and every active tool have settled. Run IDs and single-child widths are persisted with mission state, so reload, session switching, and context compaction preserve the same completion behavior.

Opening or navigating to a task is passive. Session startup, resume, reload, fork, and tree restoration can refresh visible mission/status state but have no authority to enqueue a hidden prompt. Only a real user message or a live completion from a run started after that session opened can authorize an automatic model turn.

Grouped `subagent.tasks` and chains are rejected by default because their package result is delivered only when the aggregate finishes. They remain available for the rare case where partial results are genuinely unusable and the task declares `Atomic aggregate: required`. There is no hard minimum agent count, fixed role-diversity quota, prompt-length gate, or singleton-writer exception ritual. Main Pi must launch every useful ready lane, but it must not manufacture ceremonial work.

Every independently dispatched implementation lane is represented internally as a one-child package worktree run. This keeps each lifecycle independent while reusing `pi-subagents`' existing clean-base worktree creation, patch capture, cleanup, and versioned `parallelHandoff` manifest. Command Center presents one-child runs as `single`, not as a misleading one-item parallel group.

Implementation lanes must declare exact repo-relative `Owned paths:`. LemonPi performs a fresh Git preflight for each target repository, rejects overlapping ownership within the same repository, and defers only the invalid or dirty lane. Valid read-only and other-repository lanes still launch. LemonPi never discards or hides user changes to make a checkout clean.

Main Pi integrates each completed writer slice individually. `lemonpi_git integrate_worker_result` accepts the exact run ID and uses a runtime-generated repository manifest. The complete base-to-worker change is applied and committed in a temporary integration worktree; only then may the real target fast-forward. Conflicts therefore leave the real checkout untouched. Missing package metadata automatically uses the recorded inspected worktree without another model.

## Agent behavior

For work outside the fast path, Main Pi briefly maps the useful dependency graph and keeps the ready queue full as results arrive. It selects from the live built-in and custom agent roster by capability. Planners, designers, scouts, context builders, reviewers, and other specialists are used when their output changes a real decision; neither familiar-role monoculture nor artificial diversity is a goal.

Todos are optional and never gate dispatch. Mission state projects one to three current product outcomes for simple work while retaining workers, retries, reviews, conflicts, and recovery as attached audit history. A lane can declare `todoId`; LemonPi updates that item automatically. Partial work is projected truthfully as partial with its checkpoint handoff attached.

Every `lemonpi_dispatch` lane includes a concrete summary of eight words or fewer. LemonPi preserves it as worker metadata, compiles semantic tasks into role-neutral run contracts, forces acceptance off, and generates ownership/artifact metadata itself. The public schema has no model or thinking override, and runtime preflight rejects those fields on stale dispatches and direct subagent spawns. Each fresh child uses the exact model and thinking in the user-level `subagents.agentOverrides[agent]`; availability is checked without fallback and the immutable binding is persisted before spawn. Repository settings are ignored for routing unless the user explicitly enables `subagents.allowProjectAgentRouting`, and populated user fields still win.

Per-agent productivity limits live only in all-project user settings at `subagents.agentLimits[agent]` and default to disabled. Disabled launches omit token, turn, tool, and absolute runtime fields. Optional warnings and hard limits are supervised by LemonPi rather than passed to destructive package counters. An enabled hard boundary captures a SHA-256 patch and hidden `refs/lemonpi/checkpoints/<runId>` commit, permits the declared validation and bounded formatting, then pauses or stops only at a completed tool boundary with `optional_budget` provenance. Cumulative tokens remain cost telemetry, separate from model-context pressure.

Progress supervision watches exact targeted status, inspected evidence, diff fingerprints, diagnostics, validation movement, repeated unchanged operations, inactivity, and failed health checks. Productive total runtime is never treated as a hang. Standalone lanes explicitly disable bundled `defaultReads`, so nonexistent `context.md` and `plan.md` instructions are never injected. Continuations render one bounded prompt from immutable objective, completed/unresolved conditions, checkpoint, diagnostics, validation state, and exact next action; prompt size does not grow recursively.

Owned paths prevent concurrent writer collisions. Main Pi may atomically expand them through `lemonpi_expand_ownership` for mechanically required compiler, registration, lockfile, direct-test, or formatting paths when no active lane conflicts. After two failures of the same internal contract, a third retry is blocked in favor of the direct UI or inspected-worktree fallback.

Main Pi stays interruptible. `subagent_wait` is blocked, background launches end the current turn after concise narration, and user messages can be answered or used to steer a child immediately. Only terminal or `needs_attention` lifecycle changes wake Main Pi; ordinary progress/status updates do not. Direct steering and stopping use the public `subagents:rpc:v1` bridge.

Validation evidence is persisted in LemonPi's private Pi state and keyed by the shared repository identity, HEAD revision, exact diff hash, command, relevant paths, and dependency state. Scope labels do not create a new cache entry, so an unchanged passing suite is reused across reloads and fresh tasks instead of rerun.

## Recovery and mission state

Mission state records runtime-owned product outcomes separately from its append-only worker/recovery audit, plus immutable model/thinking bindings, user-owned limit policy, targeted usage, truthful stop provenance, durable checkpoints, validation, and persistent contract failures. Writes are content-hashed and coalesced; heartbeat data stays in private files outside the transcript. Partial, integrated, validated, and unresolved states project consistently. After reload or compaction LemonPi reconciles recorded runs through authoritative runtime status and migrates stale procedural plans into at most three current outcomes. The desktop activity poller never submits completion prompts; the extension is the sole terminal authority, and its synthetic wake barrier requires Main Pi and every tool to settle first.

If a run fails, LemonPi asks Main Pi to inspect the exact error and partial output, preserve useful work, and retry only a smaller corrected lane when that can help. Empty-output sessions are not revived with bloated context. Main Pi owns user clarification, final integration, focused validation, Git management, and visible progress narration.
