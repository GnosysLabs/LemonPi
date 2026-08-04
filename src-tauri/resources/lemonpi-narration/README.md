# LemonPi narration

First-party Pi extension bundled with LemonPi. It supplies visible narration, a direct low-risk UI fast path, independent delegated-run scheduling for broader work, durable mission recovery, and direct steering/stop controls without patching `pi-subagents`.

## Direct UI fast path

One-repository changes to one to five ordinary UI files run directly in Main Pi through `lemonpi_fast_path`. The runtime permits edits only to the declared paths and one focused `lemonpi_validate` check. This path has no worktree, delegation, roadmap gate, reviewer, wave check, or final holistic check. Eligible UI work is rejected by `lemonpi_dispatch` so the slower path cannot be selected accidentally.

A visible UI request cannot silently dispatch backend, protocol, database, or synchronization work. LemonPi requires the local visible slice first and treats synchronization as an explicit second phase.

## Independent dispatch

`lemonpi_dispatch` is the path for multi-repository, genuinely parallel, materially risky, or otherwise non-fast-path work. One tool call may describe many lanes, but LemonPi submits every lane through the stable `pi-subagents` RPC `spawn` method as a separate asynchronous run.

Near-simultaneous terminal events are coalesced for 300 ms. A terminal event only queues reconciliation; its synthetic wake cannot begin until Main Pi's current turn and every active tool have settled. Run IDs and single-child widths are persisted with mission state, so reload, session switching, and context compaction preserve the same completion behavior.

Grouped `subagent.tasks` and chains are rejected by default because their package result is delivered only when the aggregate finishes. They remain available for the rare case where partial results are genuinely unusable and the task declares `Atomic aggregate: required`. There is no hard minimum agent count, fixed role-diversity quota, prompt-length gate, or singleton-writer exception ritual. Main Pi must launch every useful ready lane, but it must not manufacture ceremonial work.

Every independently dispatched implementation lane is represented internally as a one-child package worktree run. This keeps each lifecycle independent while reusing `pi-subagents`' existing clean-base worktree creation, patch capture, cleanup, and versioned `parallelHandoff` manifest. Command Center presents one-child runs as `single`, not as a misleading one-item parallel group.

Implementation lanes must declare exact repo-relative `Owned paths:`. LemonPi performs a fresh Git preflight for each target repository, rejects overlapping ownership within the same repository, and defers only the invalid or dirty lane. Valid read-only and other-repository lanes still launch. LemonPi never discards or hides user changes to make a checkout clean.

Main Pi integrates each completed writer slice individually. `lemonpi_git integrate_worker_result` accepts the exact run ID, reads the runtime-generated handoff manifest, verifies repository identity and owned paths, applies the patch, and creates the integration commit atomically without another model. `integrate_worktree` remains the inspected fallback. Clean managed worktrees are retired after passing slice validation. A malformed model-authored artifact description or acceptance object cannot invalidate inspected code.

## Agent behavior

Main Pi briefly maps the complete dependency graph, including later-step work whose inputs are already stable, then keeps the ready queue full as results arrive. It selects from the live built-in and custom agent roster by capability. Planners, designers, scouts, context builders, reviewers, and other specialists are used when their output changes a real decision; neither familiar-role monoculture nor artificial diversity is a goal.

Delegated work uses one to three meaningful todo milestones for simple requests. A lane can declare `todoId`; LemonPi updates that item to in-progress when the worker starts, completed when it succeeds, and pending when it genuinely fails or is stopped. Partial and budget-exhausted work stays in progress with its handoff attached. Mission todo history is append-only: corrections supersede earlier items instead of deleting them. The lifecycle snapshot is persisted and restored without relying on the model to remember status updates.

Every `lemonpi_dispatch` lane includes a concrete summary of eight words or fewer. LemonPi preserves it as worker metadata, compiles semantic tasks into role-neutral run contracts, forces acceptance off, and generates ownership/artifact metadata itself. The public schema has no model or thinking override, and runtime preflight rejects those fields on stale dispatches and direct subagent spawns. Each fresh child uses the exact model and thinking in the user-level `subagents.agentOverrides[agent]`; availability is checked without fallback and the immutable binding is persisted before spawn. Repository settings are ignored for routing unless the user explicitly enables `subagents.allowProjectAgentRouting`, and populated user fields still win.

Per-agent budgets live in user settings at `subagents.agentBudgets[agent]`. Each profile separates warning, work, and finalization thresholds. At the tool-work limit all normal tools are blocked while reserved assistant turns remain available to return the result. Terminal precedence treats a clean exit with useful output as completed even when a racing budget event reports failure; useful unfinished output or patches become partial, an empty hard-limit stop becomes budget exhausted, and only genuine unusable execution errors become failed. Partial and budget-exhausted runs receive a deterministic handoff and fresh continuations consume only its unresolved scope. After two failures of the same internal contract, a third retry is blocked in favor of the direct UI or inspected-worktree fallback.

Main Pi stays interruptible. `subagent_wait` is blocked, background launches end the current turn after concise narration, and user messages can be answered or used to steer a child immediately. Only terminal or `needs_attention` lifecycle changes wake Main Pi; ordinary progress/status updates do not. Direct steering and stopping use the public `subagents:rpc:v1` bridge.

Validation evidence is keyed by the shared repository identity, HEAD revision, exact diff hash, command, relevant paths, and dependency state. Scope labels do not create a new cache entry, so an unchanged passing suite is reused instead of rerun.

## Recovery and mission state

Mission state records the phase, active run IDs, immutable model/thinking bindings, per-run widths, live usage and budget phase, terminal precedence result, partial handoff, writer presence, and the next visible todo item. Writes are content-hashed and coalesced, so identical rapid state transitions produce one durable event instead of a transcript flood. Command Center overlays package status with that authoritative mission result so a valid boundary response is not shown as failed. After reload or compaction LemonPi reconciles recorded runs through authoritative runtime status. Active work silently restores, terminal work wakes integration once, and paused, needs-attention, or unreadable state produces one actionable intervention. Synthetic plan/integration wakes are suppressed whenever the authoritative runtime reports active work or Main Pi's current turn/tools have not settled.

If a run fails, LemonPi asks Main Pi to inspect the exact error and partial output, preserve useful work, and retry only a smaller corrected lane when that can help. Empty-output sessions are not revived with bloated context. Main Pi owns user clarification, final integration, focused validation, Git management, and visible progress narration.
