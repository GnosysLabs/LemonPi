# Orchestration policy v7

Policy v7 makes latency, scope, recovery, integration, wake ordering, and progress runtime invariants rather than prompt conventions.

## Direct UI work

An ordinary one-repository UI request uses Main Pi's direct fast path. A dispatch attempt for an eligible lane is converted to that path without launching a worker or returning an orchestration error. No todo is required. After five minutes or twelve exploratory tool calls, LemonPi blocks roadmap, worker, worktree, reviewer, and broad-validation detours until the visible slice is implemented or one concrete blocker is raised. Backend, protocol, synchronization, and cross-platform lanes require corresponding scope in the current human-authored request.

## Outcomes, not audit steps

Mission state v3 separates current product outcomes from worker and recovery history. New work projects at most three current outcomes in the task panel; retries, reviews, conflicts, validation, commits, and recovery remain audit events attached to those outcomes. Migrating an older policy compacts its stale todo-driven progress and does not resume a historical procedural todo as new work. `todoId` remains optional and receives automatic lifecycle updates when supplied.

## Deterministic, transactional integration

Every completed implementation with a recorded worktree receives a runtime-generated manifest containing its exact base, worktree, and owned paths. Integration captures the complete base-to-worker change, including dependent parent commits, and applies it in an isolated temporary worktree based on the target HEAD. The real checkout advances only through a final fast-forward after the transaction commits. Conflicts and verification failures remove the temporary transaction and leave the real checkout unchanged. Missing package metadata automatically falls back to the recorded inspected worktree.

## Wake ordering

The desktop no longer submits terminal prompts from its activity poller. The extension is the sole terminal authority. Worker status polling records terminal evidence and queues reconciliation through the mission barrier; a wake cannot be delivered while Main Pi or a tool is running, before `agent_settled`, or behind another queued wake. Repeated wake-delivery failure becomes one visible needs-attention outcome instead of silently pausing the mission.

## Persistent evidence and controller identity

Passing validation evidence is stored in LemonPi's private Pi state and keyed by repository identity, revision, diff hash, command, relevant paths, and dependency hash. Identical evidence is reusable across session reloads and fresh tasks. Internal contract-failure counts live in mission state, survive ordinary user retries, and permit action-specific automatic fallback after two failures.

Each Pi process is bound to the SHA-256 identity of the bundled narration and orchestration runtime plus policy version 7. Commands are rejected if those files change underneath the process. Reopening the project stops the stale process and starts one with the current controller while preserving on-disk task and mission history.
