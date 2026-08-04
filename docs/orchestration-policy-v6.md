# Orchestration policy v6

Policy v6 makes user-selected agent routing and budget-boundary result preservation runtime invariants.

## Main Pi system prompt

LemonPi injects a versioned Main Pi operating manual through `before_agent_start` on every Main Pi turn. Child processes identified by `PI_SUBAGENT_CHILD=1` never receive it. The manual is procedural rather than aspirational: it starts with the fast-path/read-only-child/dispatch decision, enumerates legal dispatch fields, explains immutable settings and runtime budgets, maps every terminal state to its required next action, distinguishes same-context resume from fresh `continuationOf`, and closes with integration, validation reuse, Git, recovery, and communication rules. This prevents each new task from rediscovering the orchestration flow through tool errors. The runtime still enforces every safety and routing boundary independently of model compliance.

## Authoritative launch bindings

Fresh child runs resolve both model and thinking from the user-level `subagents.agentOverrides[agent]`. `lemonpi_dispatch` does not expose model, provider, thinking, reasoning, effort, or tier fields. Runtime preflight recursively rejects model or thinking fields on dispatch lanes and direct subagent spawns before any child exists. The configured provider/model must be authenticated and present in Pi's current model registry. Agent or repository `fallbackModels` are rejected before launch, so provider failure cannot silently substitute another model.

Repository `.pi/settings.json` values cannot replace populated user fields. Project routing is disabled unless the user sets `subagents.allowProjectAgentRouting: true` in the user settings file, and that opt-in only fills fields absent from the user agent override. LemonPi persists the resolved agent, model, exact thinking value, source, and settings hash in mission metadata before spawn. Fresh runs re-resolve current settings; resume keeps the original binding.

## Budget phases and terminal precedence

User settings may define deterministic per-agent profiles at `subagents.agentBudgets[agent]`. Profiles have warning thresholds, work limits, and a separate finalization allowance. Reaching the warning threshold sends an early wrap-up instruction. At the work tool limit the child cannot start normal tools, but reserved assistant turns remain available for a final result.

Terminal transitions are idempotent and monotonic: completed outranks partial, partial outranks budget exhausted, and none can be downgraded by a later failure or stop event. A clean exit with useful output or a valid structured result is completed even if a racing observer reports that the turn limit was crossed. Useful unfinished output, a handoff, or an implementation patch is partial. A hard limit with no usable output is budget exhausted. Manual stops and genuine execution failures remain distinct.

Partial and budget-exhausted runs get a runtime-generated JSON handoff containing the original task, immutable binding, inspected resources, latest useful output, artifact paths, completed and unresolved conditions, exact stop reason, and prior run ID. A `continuationOf` dispatch creates a fresh bounded child from only the handoff's unresolved task. Mission status and Command Center use the same authoritative terminal result and exact binding.
