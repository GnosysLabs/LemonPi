# LemonPi narration

First-party Pi extension bundled with LemonPi. It supplies visible narration, a read-only Main Pi supervisor contract, independent delegated-run scheduling, durable mission recovery, and direct steering/stop controls without patching `pi-subagents`.

## Independent dispatch

`lemonpi_dispatch` is the normal execution path for implementation and for multiple dependency-ready read-only lanes. One tool call may describe many lanes, but LemonPi submits every lane through the stable `pi-subagents` RPC `spawn` method as a separate asynchronous run. There is no parent group barrier: the first completed lane produces its own completion event and wakes Main Pi for inspection and integration while siblings continue.

Near-simultaneous terminal events are coalesced for 300 ms into one integration wake so the chat does not repeat itself. This is only notification batching; it never waits for another run. A completion outside that tiny window wakes Main Pi independently. Run IDs and single-child widths are persisted with mission state, so reload, session switching, and context compaction preserve the same completion behavior.

Grouped `subagent.tasks` and chains are rejected by default because their package result is delivered only when the aggregate finishes. They remain available for the rare case where partial results are genuinely unusable and the task declares `Atomic aggregate: required`. There is no hard minimum agent count, fixed role-diversity quota, prompt-length gate, or singleton-writer exception ritual. Main Pi must launch every useful ready lane, but it must not manufacture ceremonial work.

Every independently dispatched implementation lane is represented internally as a one-child package worktree run. This keeps each lifecycle independent while reusing `pi-subagents`' existing clean-base worktree creation, patch capture, cleanup, and versioned `parallelHandoff` manifest. Command Center presents one-child runs as `single`, not as a misleading one-item parallel group.

Implementation lanes must declare exact repo-relative `Owned paths:`. LemonPi performs a fresh Git preflight for each target repository, rejects overlapping ownership within the same repository, and defers only the invalid or dirty lane. Valid read-only and other-repository lanes still launch. LemonPi never discards or hides user changes to make a checkout clean.

Main Pi integrates each completed writer patch individually. It reads `parallelHandoff.path`, checks the base revision, child status, patch health, and ownership boundary, then uses the guarded `git apply --check` followed by `git apply --3way` flow. Package-generated patches under `.pi-subagents/artifacts/worktree-diffs/` are the only project-file mutation Main Pi may perform.

## Agent behavior

Main Pi briefly maps the complete dependency graph, including later-step work whose inputs are already stable, then keeps the ready queue full as results arrive. It selects from the live built-in and custom agent roster by capability. Planners, designers, scouts, context builders, reviewers, and other specialists are used when their output changes a real decision; neither familiar-role monoculture nor artificial diversity is a goal.

For non-trivial work, Main Pi creates the entire known todo roadmap before the first implementation dispatch. The runtime rejects the one-item conveyor-belt pattern: a launch requires a fresh set of specific, described milestones with one current item, visible dependency ordering, and a validation outcome. Items are decomposed toward two-to-five-minute observable checkpoints, while normal progress only changes their statuses. Newly discovered scope is appended immediately rather than kept hidden until the current item finishes.

Every `lemonpi_dispatch` lane includes a model-authored, concrete summary of eight words or fewer. LemonPi preserves it as worker metadata so Command Center shows the lane's purpose instead of runner boilerplate. LemonPi also compiles semantic tasks into role-neutral run contracts, adds an explicit execution mode after the human-readable task, disables inferred acceptance unless runtime verification is explicitly configured, and strips model-authored timeout, turn, tool, and usage budgets. Five minutes remains a decomposition aspiration, not a timeout or mechanical rejection threshold.

Main Pi stays interruptible. `subagent_wait` is blocked, background launches end the current turn after concise narration, and user messages can be answered or used to steer a child immediately. Only terminal or `needs_attention` lifecycle changes wake Main Pi; ordinary progress/status updates do not. Direct steering and stopping use the public `subagents:rpc:v1` bridge.

## Recovery and mission state

Mission state records the phase, active run IDs, per-run widths, writer presence, and the next visible todo item. After reload or compaction LemonPi reconciles recorded runs through authoritative runtime status. Active work silently restores, terminal work wakes integration once, and paused, needs-attention, or unreadable state produces one actionable intervention. Synthetic plan/integration wakes are suppressed whenever the authoritative runtime reports active work.

If a run fails, LemonPi asks Main Pi to inspect the exact error and partial output, preserve useful work, and retry only a smaller corrected lane when that can help. Empty-output sessions are not revived with bloated context. Main Pi owns user clarification, final integration, focused validation, Git management, and visible progress narration.
