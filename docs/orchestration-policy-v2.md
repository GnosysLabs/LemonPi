# Orchestration policy v2

LemonPi policy v2 moves the delivery workflow out of accumulated conversation advice and into deterministic runtime controls. Main Pi remains the read-only supervisor and integration owner. It maps the outcome graph briefly, launches every independent dependency-ready lane, reacts to each completion separately, and keeps the visible mission progressing until the result is accepted and validated.

## Policy migration

Mission snapshots carry `policyVersion: 2`. Version 1 snapshots are migrated on replay without losing the user request, active run identifiers, task state, or product decisions. Before each model request LemonPi injects an authoritative policy notice. If an older user/session summary contains scheduler instructions such as “one writer at a time,” the runtime marks that workflow text as superseded while preserving the surrounding product facts.

The active policy has no arbitrary worker quota or concurrency ceiling. Independent lanes run concurrently when their dependencies and exact path ownership allow it. Only the concrete conflicting lane is deferred; a dirty checkout or one overlapping lane does not serialize unrelated work.

## Safe Git lifecycle

`lemonpi_git` is Main Pi's only project-mutation path. It supports:

- inspecting and classifying every dirty path;
- checkpointing safe intentional work on a local `codex/recovery-*` branch;
- exact-path commits with staged-path verification and `git diff --check`;
- managed mission worktree creation/removal;
- applying package-generated patches after `git apply --check`;
- local cherry-pick integration.

Tracked source/configuration, current mission work, reproducible generated output, and agent artifacts are distinguished from suspicious or ambiguous files. Any suspicious or unclassified dirty path stops checkpointing and produces one focused clarification instead of guessing. The tool does not discard files, reset, clean, force an operation, modify remotes, or push.

## Dispatch and worker context

`lemonpi_dispatch` requires a current executable agent roster, a concrete summary of eight words or fewer, an execution mode, and exact owned paths for implementation. It assigns a unique artifact path to every lane and chooses a reasoning level from role and risk outside the child prompt: low for ordinary scouting/research, medium for routine planning, writing, and review, and high only for unresolved architecture or material risk.

Implementation lanes use fresh sessions. Resume is allowed only for a bounded correction to the immediately preceding completed implementation slice, with a fresh purpose. Immediately before resume LemonPi reads the authoritative run status and actual session-file size/token totals. Empty, corrupt, failed, stopped, unrelated, wrong-mode, oversized, or repeatedly reused sessions are rejected and replaced by a concise fresh-context handoff. The defaults are 2 MB, 120,000 tokens, and two slices; operators may lower them with `LEMONPI_WORKER_MAX_TRANSCRIPT_BYTES`, `LEMONPI_WORKER_MAX_TOKENS`, and `LEMONPI_WORKER_MAX_SLICES`.

Preflight rejects missing agents, nonexistent repositories/worktrees, duplicate output paths, implementation roles known to be read-only, and missing owned paths before model execution. Model/provider availability remains authoritative at Pi's installed-provider boundary; LemonPi does not invent credentials or silently substitute a provider.

## Review and validation ledgers

Review records are keyed by repository, revision, diff hash, scope, and material-risk boundary. An accepted record prevents duplicate review of identical work. Independent review is reserved for an explicit request or material authentication, authorization, security, privacy, money, migration, cryptography, concurrency, public-protocol, or release boundary.

`lemonpi_validate` keys results by repository, base revision, diff hash, exact command, relevant paths, dependency state, and validation scope. A passing unchanged record is reused. Relevant path changes or dependency-state changes invalidate it; unrelated edits do not. Long validation emits heartbeat updates so the UI never looks idle. The intended cadence is focused validation per accepted slice, one broader validation per integration wave, and one final holistic validation.

## Recovery

Failures are classified as process disappearance, stale-run reconciliation, empty output, command syntax, test failure, needs-attention, capability preflight, or implementation failure. Recovery is bounded and deterministic:

- correct one malformed command in context;
- preserve work and rerun only a failed check;
- inspect and steer a needs-attention run once;
- reconcile stale state against authoritative runtime status;
- reject unavailable capabilities before launch;
- otherwise preserve partial work and launch a smaller fresh-context slice.

There are no model-authored turn, token, tool, or timeout budgets. User-configured package/provider limits remain authoritative.

## Visible mission progress

Multi-outcome dispatch is blocked until Main Pi exposes at least two real todo milestones. The composer panel renders the plan as a Mission, including accepted count and percentage, active worker count, validation state, and recovery-action count. Task states remain the source of truth for current, next, blocked, and accepted outcomes; the runtime does not replace them with a single generic spinning parent task.

## Deterministic fixture and replay

Run:

```bash
pnpm test:orchestration-runtime
```

The fixture creates a temporary Git repository and validates 16 scenarios: stale-policy migration, safe dirty checkpoints, suspicious-file preservation, three disjoint worktrees, conflict-only deferral, correct and incorrect resumes, no-write preflight, review and validation deduplication, path-aware invalidation, validation heartbeat, malformed-command recovery, unique artifacts, visible epic progress, logical integration commits, and destructive-command guards.

The reduced synthetic incident model reports these before/after values:

| Metric | Old policy | Policy v2 |
| --- | ---: | ---: |
| Critical-path minutes | 116 | 33 |
| Model turns | 248 | 82 |
| Worker runs | 13 | 11 |
| Reviewer runs | 19 | 2 |
| Failed launches | 3 | 0 |
| Duplicate validations | 9 | 0 |
| Context KB | 10,240 | 1,280 |
| Worker transcript reuses | 11 | 1 |
| Test minutes | 48 | 18 |
| Recovery checkpoints | 0 | 1 |
| Integration commits | 0 | 5 |

These numbers are deterministic outputs of the repository fixture, not measured promises for arbitrary real projects. Their purpose is regression detection: a policy change must not reintroduce the known pathological behavior.
