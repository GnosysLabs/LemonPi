export interface ToolActivity {
  name: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "complete" | "error";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string, length = 96): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function shortPath(value: unknown): string | undefined {
  const path = text(value)?.replace(/\\/g, "/");
  if (!path) return undefined;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 3) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

function taskCount(args: Record<string, unknown>): number {
  if (Array.isArray(args.tasks)) return args.tasks.length;
  if (Array.isArray(args.chain)) return args.chain.length;
  return 1;
}

function commandActivity(command: string, complete: boolean): string {
  const normalized = command.toLowerCase();
  if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/.test(normalized)) return complete ? "Ran the tests" : "I'm running the tests";
  if (/\b(build|tsc|cargo check)\b/.test(normalized)) return complete ? "Built the project" : "I'm building the project";
  if (/\b(clippy|lint|eslint|biome|prettier|fmt)\b/.test(normalized)) return complete ? "Checked code quality" : "I'm checking code quality";
  if (/\b(git (status|diff|log|show))\b/.test(normalized)) return complete ? "Checked the working tree" : "I'm checking the working tree";
  if (/\b(rg|grep|find)\b/.test(normalized)) return complete ? "Searched the project" : "I'm searching the project";
  if (/\b(install|add)\b/.test(normalized)) return complete ? "Installed dependencies" : "I'm installing dependencies";
  return complete ? "Ran a command" : "I'm running a command";
}

export function summarizeSurfacedThinking(thinking: string): string | undefined {
  for (const line of thinking.split("\n")) {
    const match = line.trim().match(/^\*\*(.+?)\*\*$/);
    if (match?.[1]) return match[1].replace(/[.:]$/, "");
  }
  return undefined;
}

export function describeToolActivity(tool: ToolActivity, complete = false): string {
  const path = shortPath(tool.args.path);
  const command = text(tool.args.command);
  const pattern = text(tool.args.pattern) ?? text(tool.args.query);
  const suffix = complete ? "" : "…";

  switch (tool.name) {
    case "read":
      return complete ? `Read ${path ?? "a file"}` : `I'm reading ${path ?? "a file"}${suffix}`;
    case "grep":
      return complete
        ? `Searched for ${pattern ? `“${truncate(pattern, 48)}”` : "matching code"}`
        : `I'm searching${path ? ` ${path}` : " the project"} for ${pattern ? `“${truncate(pattern, 48)}”` : "matching code"}${suffix}`;
    case "find":
      return complete ? "Located relevant files" : `I'm locating the relevant files${suffix}`;
    case "ls":
      return complete ? `Inspected ${path ?? "the project structure"}` : `I'm inspecting ${path ?? "the project structure"}${suffix}`;
    case "edit":
      return complete ? `Updated ${path ?? "the implementation"}` : `I'm updating ${path ?? "the implementation"}${suffix}`;
    case "write":
      return complete ? `Created ${path ?? "a new file"}` : `I'm creating ${path ?? "a new file"}${suffix}`;
    case "bash":
      return `${commandActivity(command ?? "", complete)}${suffix}`;
    case "subagent": {
      const count = taskCount(tool.args);
      const agent = text(tool.args.agent);
      const task = text(tool.args.task);
      const background = tool.args.async === true;
      if (background) {
        if (complete) return count > 1 ? `Launched ${count} delegated agents in the background` : `Launched ${agent ?? "a delegated agent"} in the background`;
        return count > 1
          ? `I'm launching ${count} delegated agents in the background${suffix}`
          : `I'm launching ${agent ?? "a delegated agent"} in the background${suffix}`;
      }
      if (complete) return count > 1 ? `Collected findings from ${count} delegated agents` : `Collected ${agent ? `${agent} ` : "delegated "}findings`;
      if (count > 1) return `I'm waiting for ${count} delegated agents to finish${suffix}`;
      return `I'm waiting for ${agent ?? "a delegated agent"}${task ? ` to ${truncate(task, 74)}` : " to report back"}${suffix}`;
    }
    case "subagent_wait":
      return complete ? "Delegated results reached the integration point" : `I'm waiting at the integration point for delegated results${suffix}`;
    case "multi_tool_use.parallel":
      return complete ? "Finished the parallel checks" : `I'm running several checks in parallel${suffix}`;
    default: {
      const label = tool.name.replace(/^functions\./, "").replace(/[_-]+/g, " ");
      return complete ? `Finished ${label}` : `I'm using ${label}${suffix}`;
    }
  }
}
