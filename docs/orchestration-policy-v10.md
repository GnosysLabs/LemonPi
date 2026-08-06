# LemonPi orchestration policy v10

Policy v10 removes destructive hidden productivity limits and makes interruption recovery a filesystem guarantee. It supersedes policy v9 while preserving the direct one-repository UI fast path.

## User-owned optional limits

Token, assistant-turn, tool-call, and productive wall-clock limits are disabled by default. Disabled launches omit `turnBudget`, `toolBudget`, `usageBudget`, and absolute runtime timeout fields instead of substituting arbitrary large values. Only all-project user settings under `subagents.agentLimits[agent]` can enable warnings or hard limits. Prompts, repositories, skills, heuristics, Main Pi, and children cannot enable or lower them. LemonPi displays and persists the effective source before launch.

Cumulative billed tokens are cost telemetry, not model-context size. Context pressure is handled through compaction or a checkpointed fresh continuation. Default safety remains bounded records/output/disk, capability and credential isolation, writer-conflict prevention, explicit user stops, shutdown cleanup, and inactivity supervision backed by failed health checks. Productive total runtime is never a hang signal.

## Safe boundaries and durable checkpoints

An enabled hard limit is supervised by LemonPi rather than passed to package counters that can interrupt an active tool. LemonPi first captures the complete owned-path binary patch in private durable storage, records its SHA-256 digest and exact base, creates a hidden commit at `refs/lemonpi/checkpoints/<runId>`, and enters finalization. Git status/diff, bounded formatting, and the declared focused validation remain legal. LemonPi pauses or stops only when no child tool is active and records `optional_budget`, never `user`.

Partial, interrupted, failed, or shutdown implementation work is checkpointed before its structured v3 handoff is written. A continuation verifies repository identity, base, patch digest, ownership, writer conflicts, checkpoint ref/commit, and changed paths. Its isolated worktree is created at the checkpoint commit; a physical base-to-HEAD diff check must show the previous files before the worker starts. A promised checkpoint that cannot be materialized blocks launch.

Continuation prompts are rendered from immutable original objective/task, completed and unresolved conditions, checkpoint identity, relevant paths, latest diagnostics, recorded validations, and one exact next action. No previous continuation prompt is embedded, so repeated prompt size stays bounded. Standalone lanes set `reads: false`, preventing nonexistent `context.md` or `plan.md` instructions.

## Progress, ownership, state, and Git

Targeted typed telemetry remains isolated from fleet projections. Progress supervision observes new evidence, current path/tool, owned diff fingerprint, diagnostics, validations, checkpoints, repeated unchanged work, inactivity, and health-check failures. Unchanged work is nudged and checkpointed; only inactivity combined with repeated failed health checks can invoke the inactivity watchdog.

Owned paths are concurrency metadata. `lemonpi_expand_ownership` atomically adds exact compiler, registration, lockfile, directly affected test, or formatting paths after checking active writers and records the reason. Genuine overlaps remain blocked. Material product, security, migration, public API, or architecture expansion still requires the user.

Mission state v5 deduplicates unchanged snapshots, keeps heartbeats outside the transcript, and projects partial work as partial. Unresolved outcomes prevent mission completion; focused validation (including reused identical evidence) completes a validated integration. Main Pi records Git baselines, stages exact owned paths, preserves unrelated dirt, integrates cumulative checkpoint chains once, and archives a successfully integrated checkpoint ref.

Task navigation is a passive operation. Startup, reload, resume, fork, and session-tree restoration may replay mission state and reconcile status artifacts, but they never enqueue a prompt or authorize a model turn. Automatic turns require either a real user message in the open task or a live worker event from a run started in that same session runtime; restored stale state, todo snapshots, timers, and status polling carry no turn authority.

LemonPi pins `pi-subagents@0.40.0`, verifies that exact installed version, and applies a version-locked compatibility patch from LemonPi's compiled Rust supervisor before either development or packaged Pi starts. Compatibility v1 makes the package RPC persist the structured stop cause and makes the package runner write the truthful cause into `status.json` instead of hardcoding a user cancellation. The patch is exact-match, verified, and idempotent; a changed or incompatible package source blocks startup clearly. LemonPi then requires RPC protocol v1 with `ping`, `status`, `spawn`, `steer`, `stop`, and lifecycle artifact v3 before launching a worker.
