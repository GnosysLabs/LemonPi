# LemonPi narration

First-party Pi extension bundled with LemonPi. It adds visible narration and supervisor/worker orchestration contracts to every Pi turn, defaults top-level `pi-subagents` delegations to background execution, and requests one guarded repair response if a run settles after tool activity without a closing explanation.

The async policy uses the public mutable `tool_call` extension hook and the package's existing `async` option. It does not patch or fork `pi-subagents`, and it does not rewrite timeout or budget arguments. Explicit `async: false` remains available for a genuine integration gate. Main Pi is instructed to avoid tight limits for substantive work and to distinguish a `subagent_wait` timeout—which does not stop the child—from a run timeout that does.

Dispatch is risk- and scope-based rather than file-count-based. Bounded low-risk work—including cohesive UI changes that touch markup, styles, and state—uses a direct fast path with one proportionate validation pass. A single configured `worker` is reserved for work that is genuinely broad, uncertain, specialized, long-running, or materially benefits from a separate coding context. LemonPi intentionally does not hard-code a provider or model: `pi-subagents` resolves roles through each user's settings.

Reviewers and other specialists are optional tools, not pipeline stages. An independent reviewer requires an explicit user request, a material risk boundary, or a concrete `Review justification: ...`; LemonPi mechanically blocks ceremonial review calls and blocks a second reviewer pass unless the user explicitly requested multiple reviews. Routine delegations disable `pi-subagents`' automatically inferred structured acceptance report because Main Pi owns integration and validation. Only blocker-level findings justify a repair pass, and Main Pi validates that repair directly instead of creating a review-repair-review loop.

The runtime also prevents serial writer relays: one implementation owner is allowed per user request in a shared checkout. One replacement is available after a real failed launch, or one repair owner after a justified review blocker; a third automatic writer launch is stopped so repeated failure becomes an explicit blocker instead of an invisible loop. Parallel writers require explicit isolated worktrees.

If a delegated tool call fails and no corrected delegation follows, LemonPi queues one hidden recovery turn requiring Main Pi to diagnose the cause, preserve partial work, and re-delegate the remaining slice when retrying can help.

The extension also handles LemonPi's private RPC control message for direct child steering. It validates the target and calls `pi-subagents`' public `subagents:rpc:v1` `steer` method, so Command Center guidance reaches the selected child without an LLM relay or transcript pollution.

LemonPi loads `extensions/narration.ts` explicitly for every managed Pi process. It is not installed into the user's global Pi configuration.
