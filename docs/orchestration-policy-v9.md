# LemonPi orchestration policy v9

Policy v9 makes worker accounting target-specific and makes budget recovery durable. It supersedes policy v8 without changing the direct fast path for ordinary one-repository UI work.

## Typed worker status

Every targeted status observation is normalized at the RPC boundary into protocol v2 with one exact `target.runId`, `target.state`, `target.metrics`, and `target.terminal`. LemonPi reads only `target.metrics` for budget decisions. A fleet projection may accompany the response for UI purposes, but it is never traversed for tokens, turns, tools, runtime, or terminal state. Missing, malformed, stale, ambiguous, or mismatched targets are rejected.

LemonPi requires `pi-subagents@0.40.0`, RPC protocol v1, the `ping`, `status`, `spawn`, `steer`, and `stop` methods, and lifecycle artifact v3. The package version is verified from its installed manifest before Pi starts. The v1 package status artifact is adapted deterministically into LemonPi's v2 target contract until the upstream RPC exposes that shape directly.

## Stops, budgets, and continuations

Stops carry a structured cause, initiator, reason, and request timestamp. Only an explicit UI stop has cause `user`; budget enforcement records cause `budget` everywhere LemonPi projects the run.

At the work boundary, a worker enters `finalizing`. A child-only extension reads the exact run marker and blocks exploration, delegation, unrelated reads, and edits. It permits owned-path reads, bounded Git diff/status inspection, and the one declared validation target. The instruction is sent once. Before a hard stop, LemonPi writes a binary patch for the owned paths and then issues the stop.

Partial and budget-exhausted runs produce versioned handoffs containing the objective, completed and unresolved work, ownership, patch, validation, risks, stop provenance, progress fingerprint, and continuation identity. Non-user stops queue one bounded fresh continuation. For implementation work, LemonPi recreates an isolated worktree at the exact prior base and applies the trusted preserved patch before the continuation starts, so the next worker resumes from the existing diff instead of reconstructing completed work. Continuations preserve the original provider, model, thinking, agent, execution mode, ownership, validation, and checkpoint. Two continuations or a repeated progress fingerprint stop the loop and require attention.

## Lane, validation, and Git contracts

An implementation lane has at most eight exact paths across at most two narrow ownership boundaries, one primary validation, and one independently meaningful checkpoint. Oversized lanes are rejected before launch so Main Pi can split them into dependent slices.

Validation identity includes the normalized executable, arguments, checkout root, relevant environment hash, revision, diff/content fingerprint, relevant paths, dependency and lockfile state, and scope. Launch failures are not cached as test failures, so a failed `pnpm` launch does not block a corrected `pnpm.cmd` execution.

Mission state records repository baselines and path provenance. Unrelated baseline dirt is allowed, classified, and left untouched; only dirty paths overlapping a lane's ownership block dispatch. Fast-path changes are recorded as LemonPi-owned. Git actions stage explicit paths only.

Worker heartbeats live outside the transcript. Transcript mission snapshots are content-deduplicated and terminal partial or budget-exhausted outcomes project as pending continuation work rather than running children.
