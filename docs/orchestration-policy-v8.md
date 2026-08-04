# Orchestration policy v8

Policy v8 closes the terminal loop left between a completed direct UI slice, local Git finalization, and passive Command Center state publication. It retains all policy v7 latency, scope, budget, transactional-integration, validation, and wake-ordering invariants.

## Completed fast-path finalization

Finishing a fast path persists its exact repository, owned files, validation result, and outcome as a narrow Git-finalization capability. The five-minute implementation guard continues blocking new orchestration, but it permits one `lemonpi_git commit` or `checkpoint` for that exact completed slice. A completed slice cannot be reopened merely because its files are now dirty; LemonPi directs Main Pi to finalize the existing inspected work instead of repeating implementation.

The finalization capability survives session replay for 24 hours and is removed after a successful exact-path commit. A new task cannot use it to mutate code; it authorizes only local Git handling of the already-validated paths.

## Interrupted Git operations

If unrelated conflicts from an earlier cherry-pick, revert, or merge block the exact commit, Main Pi asks once about the complete unmerged set. After explicit confirmation to keep the current branch versions, `resolve_conflicts_to_head` requires the same complete path set in `paths` and `confirmedPaths`, verifies an operation is active, resolves only those files to `HEAD`, and preserves every other working change. The already-validated slice is then finalized once.

## Passive state cannot wake the model

Mission-outcome and todo-lifecycle snapshots are UI telemetry, not model prompts. While Main Pi or a tool is running, LemonPi retains only the newest snapshot by type. After `agent_settled`, it emits those snapshots with no follow-up delivery mode and with turn triggering disabled. They therefore cannot enter Pi's follow-up queue, start another model turn, clear final narration evidence, restart reconciliation, or produce repeated completion reports.

## Controller identity

Each Pi process is bound to the SHA-256 identity of the bundled narration and orchestration runtime plus policy version 8. Commands are rejected if those files change underneath the process. Reopening the project starts the current controller while preserving mission history and an eligible pending exact-path finalization.
