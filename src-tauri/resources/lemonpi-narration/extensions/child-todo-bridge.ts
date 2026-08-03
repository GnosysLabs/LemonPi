import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEED_TAG = "lemonpi-child-todo-seed";
const SEED_ENTRY = "lemonpi-child-todos";
const CHILD_TODO_TOOL = "child_todo";

type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

interface TodoTask {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TodoStatus;
  blockedBy: number[];
  owner?: string;
}

interface TodoState {
  tasks: TodoTask[];
  nextId: number;
}

interface SeedPayload extends TodoState {
  version: 1;
  seedId?: string;
  seededAt?: number;
  owner: string;
}

interface ReplayedTodoState {
  state: TodoState;
  seedKey: string;
}

interface TodoStoreModule {
  replaceState(sessionId: string, state: TodoState): void;
}

interface TodoProviderModule {
  default(pi: ExtensionAPI): void;
}

// Pi gives each explicitly loaded extension its own module-loader scope. Loading
// rpiv-todo as one extension and importing its store from another therefore
// creates two Maps even when the specifier is identical. The bridge owns the
// provider load so index.js and store.js share one graph and one session store.
const todoPackageRoot = path.join(getAgentDir(), "npm/node_modules/@juicesharp/rpiv-todo");
const todoProvider = await import(pathToFileURL(path.join(todoPackageRoot, "index.js")).href) as TodoProviderModule;
const todoStateStore = await import(pathToFileURL(path.join(todoPackageRoot, "state/store.js")).href) as TodoStoreModule;

function validTask(value: unknown): value is TodoTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return Number.isInteger(task.id)
    && typeof task.subject === "string"
    && ["pending", "in_progress", "completed", "deleted"].includes(String(task.status))
    && Array.isArray(task.blockedBy)
    && task.blockedBy.every(Number.isInteger);
}

function seedPayload(value: unknown): SeedPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1 || typeof payload.owner !== "string" || !Array.isArray(payload.tasks)) return undefined;
  if (payload.tasks.length < 1 || payload.tasks.length > 5 || !payload.tasks.every(validTask)) return undefined;
  if (!Number.isInteger(payload.nextId)) return undefined;
  return {
    version: 1,
    ...(typeof payload.seedId === "string" && payload.seedId ? { seedId: payload.seedId } : {}),
    ...(typeof payload.seededAt === "number" && Number.isFinite(payload.seededAt) ? { seededAt: payload.seededAt } : {}),
    owner: payload.owner,
    tasks: payload.tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })),
    nextId: payload.nextId as number,
  };
}

function seedKey(seed: SeedPayload): string {
  return seed.seedId ?? JSON.stringify({ owner: seed.owner, tasks: seed.tasks, nextId: seed.nextId });
}

function normalizeSeedOwner(seed: SeedPayload): SeedPayload {
  const owner = process.env.PI_SUBAGENT_CHILD_AGENT?.trim() || seed.owner;
  return {
    ...seed,
    seededAt: Date.now(),
    owner,
    tasks: seed.tasks.map((task) => ({ ...task, owner, blockedBy: [...task.blockedBy] })),
  };
}

function todoDetails(value: unknown): TodoState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  if (!Array.isArray(details.tasks) || !details.tasks.every(validTask) || !Number.isInteger(details.nextId)) return undefined;
  return {
    tasks: details.tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })),
    nextId: details.nextId as number,
  };
}

function replaySeededState(branch: Iterable<unknown>): ReplayedTodoState | undefined {
  let state: TodoState | undefined;
  let latestSeedKey: string | undefined;
  let sawSeed = false;
  for (const value of branch) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry.type === "custom" && entry.customType === SEED_ENTRY) {
      const seed = seedPayload(entry.data);
      if (seed) {
        state = { tasks: seed.tasks, nextId: seed.nextId };
        latestSeedKey = seedKey(seed);
        sawSeed = true;
      }
      continue;
    }
    if (!sawSeed || entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message?.role !== "toolResult" || ![CHILD_TODO_TOOL, "todo"].includes(String(message.toolName))) continue;
    state = todoDetails(message.details) ?? state;
  }
  return state && latestSeedKey ? { state, seedKey: latestSeedKey } : undefined;
}

function removeSeedTags(text: string, seeds: SeedPayload[]): string {
  return text.replace(new RegExp(`<${SEED_TAG}>([\\s\\S]*?)</${SEED_TAG}>`, "g"), (_match, json: string) => {
    try {
      const seed = seedPayload(JSON.parse(json));
      if (seed) seeds.push(seed);
    } catch {
      // A malformed marker is ignored and removed from provider context.
    }
    return "";
  });
}

function extractSeeds(messages: unknown[]): { messages: unknown[]; seeds: SeedPayload[] } {
  const seeds: SeedPayload[] = [];
  const next = messages.map((value) => {
    if (!value || typeof value !== "object") return value;
    const message = value as Record<string, unknown>;
    if (typeof message.content === "string") {
      return { ...message, content: removeSeedTags(message.content, seeds) };
    }
    if (!Array.isArray(message.content)) return value;
    return {
      ...message,
      content: message.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const record = part as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string"
          ? { ...record, text: removeSeedTags(record.text, seeds) }
          : part;
      }),
    };
  });
  return { messages: next, seeds };
}

export default function (pi: ExtensionAPI) {
  const childPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          target.registerTool({
            ...tool,
            name: CHILD_TODO_TOOL,
            promptGuidelines: tool.promptGuidelines?.map((line) => line.replaceAll("`todo`", "`child_todo`")),
          });
        };
      }
      if (property === "registerCommand") {
        return (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
          target.registerCommand(`child-${name}`, options);
        };
      }
      if (property === "registerShortcut") return () => undefined;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  todoProvider.default(childPi);
  const appliedSeedBySession = new Map<string, string>();

  const restore = async (ctx: { sessionManager: { getSessionId(): string; getBranch(): Iterable<unknown> } }) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const replayed = replaySeededState(ctx.sessionManager.getBranch());
    if (!sessionId || !replayed) return;
    todoStateStore.replaceState(sessionId, replayed.state);
    appliedSeedBySession.set(sessionId, replayed.seedKey);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => appliedSeedBySession.delete(ctx.sessionManager.getSessionId()));

  pi.on("context", async (event, ctx) => {
    const extracted = extractSeeds(event.messages as unknown[]);
    const rawSeed = extracted.seeds.at(-1);
    const seed = rawSeed ? normalizeSeedOwner(rawSeed) : undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (seed && sessionId && appliedSeedBySession.get(sessionId) !== seedKey(seed)) {
      todoStateStore.replaceState(sessionId, { tasks: seed.tasks, nextId: seed.nextId });
      pi.appendEntry<SeedPayload>(SEED_ENTRY, seed);
      appliedSeedBySession.set(sessionId, seedKey(seed));
    }
    return extracted.seeds.length > 0 ? { messages: extracted.messages as typeof event.messages } : undefined;
  });
}
