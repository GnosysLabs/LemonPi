import {
  ArrowClockwise,
  BracketsCurly,
  CaretUpDown,
  Check,
  CheckCircle,
  Lightning,
  MagnifyingGlass,
  Package,
  Plus,
  Robot,
  Sparkle,
  Trash,
  Warning,
  WifiHigh,
  Wrench,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  getPiPackages,
  getPiSettings,
  getSubagentSettings,
  replacePiSettings,
  runPiPackageAction,
  setPiSetting,
  setSubagentOverride,
} from "../lib/pi-client";
import { RemoteAccessSettings } from "./remote/RemoteAccessSettings";
import type {
  PiModel,
  PiPackagesSnapshot,
  PiSettingsScope,
  PiSettingsSnapshot,
  SubagentSettingInfo,
  SubagentSettingSource,
  SubagentSettingsSnapshot,
  ThinkingLevel,
} from "../lib/pi-types";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
type Section = "general" | "behavior" | "resources" | "agents" | "packages" | "remote" | "advanced";
type FieldKind = "boolean" | "number" | "text" | "select" | "list" | "json";

interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
}

interface ChoiceGroup {
  label: string;
  options: ChoiceOption[];
}

interface SettingField {
  path: string;
  label: string;
  description: string;
  kind: FieldKind;
  options?: ChoiceOption[];
  groups?: ChoiceGroup[];
  min?: number;
  max?: number;
  userOnly?: boolean;
  rows?: number;
}

/* Runtime: only settings that genuinely apply to LemonPi's desktop RPC sessions.
 * Pi's terminal/TUI-only keys (theme, editor padding, tree filters, hardware cursor,
 * branch summaries, model cycling, …) stay available through Advanced JSON. */
const FLOW_FIELDS: SettingField[] = [
  { path: "steeringMode", label: "Steering delivery", description: "How messages you send while Pi is still responding are delivered.", kind: "select", options: queueOptions() },
  { path: "followUpMode", label: "Follow-up delivery", description: "How messages queued after a response finishes are delivered.", kind: "select", options: queueOptions() },
  { path: "transport", label: "Provider transport", description: "Preferred connection when a provider offers more than one transport.", kind: "select", options: ["auto", "sse", "websocket", "websocket-cached"].map((value) => ({ value, label: sentenceCase(value) })) },
];

const CONTEXT_FIELDS: SettingField[] = [
  { path: "compaction.enabled", label: "Automatic compaction", description: "Summarize older context as the model window fills.", kind: "boolean" },
  { path: "compaction.reserveTokens", label: "Response reserve", description: "Tokens reserved for the model's reply when compacting.", kind: "number", min: 0 },
  { path: "compaction.keepRecentTokens", label: "Recent context to keep", description: "Recent tokens kept verbatim through compaction.", kind: "number", min: 0 },
];

const RELIABILITY_FIELDS: SettingField[] = [
  { path: "retry.enabled", label: "Automatic retry", description: "Retry transient provider and rate-limit failures.", kind: "boolean" },
  { path: "retry.maxRetries", label: "Agent retries", description: "Maximum agent-level retry attempts.", kind: "number", min: 0 },
  { path: "retry.baseDelayMs", label: "Retry base delay", description: "Starting exponential backoff delay, in milliseconds.", kind: "number", min: 0 },
  { path: "retry.provider.timeoutMs", label: "Provider timeout", description: "Provider request timeout in milliseconds.", kind: "number", min: 0 },
  { path: "retry.provider.maxRetries", label: "Provider retries", description: "Low-level SDK retries. Pi recommends leaving this at zero.", kind: "number", min: 0 },
  { path: "retry.provider.maxRetryDelayMs", label: "Maximum retry delay", description: "Longest server-requested delay Pi will accept, in milliseconds.", kind: "number", min: 0 },
  { path: "httpIdleTimeoutMs", label: "HTTP idle timeout", description: "Header/body stream idle timeout in milliseconds; zero disables it.", kind: "number", min: 0 },
  { path: "websocketConnectTimeoutMs", label: "WebSocket connect timeout", description: "Open-handshake timeout in milliseconds; zero disables it.", kind: "number", min: 0 },
];

const CONNECTION_FIELDS: SettingField[] = [
  { path: "httpProxy", label: "HTTP proxy", description: "Global HTTP/HTTPS proxy URL used by Pi.", kind: "text", userOnly: true },
  { path: "enableInstallTelemetry", label: "Install telemetry", description: "Allow Pi's anonymous install and update version ping.", kind: "boolean", userOnly: true },
  { path: "enableAnalytics", label: "Usage analytics", description: "Opt into Pi analytics data sharing.", kind: "boolean", userOnly: true },
];

const SHELL_FIELDS: SettingField[] = [
  { path: "shellPath", label: "Shell path", description: "Custom shell executable used by Pi's bash tool.", kind: "text" },
  { path: "shellCommandPrefix", label: "Shell command prefix", description: "Prefix prepended to every bash command.", kind: "text" },
  { path: "sessionDir", label: "Session directory", description: "Custom directory for Pi session files.", kind: "text" },
  { path: "npmCommand", label: "npm command", description: "JSON argv used for all Pi npm package operations.", kind: "json", rows: 3 },
];

const AGENT_RESOURCE_FIELDS: SettingField[] = [
  { path: "enableSkillCommands", label: "Skill slash commands", description: "Register loaded skills as /skill:name commands.", kind: "boolean" },
  { path: "extensions", label: "Extension paths", description: "One local extension path or glob per line.", kind: "list", rows: 4 },
  { path: "skills", label: "Skill paths", description: "One local skill path or glob per line.", kind: "list", rows: 4 },
  { path: "prompts", label: "Prompt template paths", description: "One local prompt path or glob per line.", kind: "list", rows: 4 },
];

function queueOptions() {
  return [
    { value: "one-at-a-time", label: "One at a time" },
    { value: "all", label: "All queued messages" },
  ];
}

function sourceLabel(source: SubagentSettingSource): string {
  switch (source) {
    case "project": return "Project";
    case "user": return "All projects";
    case "agent-file": return "Agent file";
    case "project-default": return "Project default";
    case "user-default": return "User default";
    default: return "Session";
  }
}

function modelKey(model: PiModel): string { return `${model.provider}/${model.id}`; }
function modelLabel(model: PiModel): string { return model.name?.trim() || model.id; }
function sentenceCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " "); }

function formatEffective(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getPath(object: Record<string, unknown>, path: string): unknown {
  let current: unknown = object;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

interface FlatChoice extends ChoiceOption {
  key: string;
  group?: string;
}

interface MenuPlacement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  above: boolean;
}

/** Desktop-quality replacement for native <select>: a button-triggered listbox
 * rendered in a portal so it can never be clipped by panels or rows. Focus
 * stays on the trigger; arrow keys move the active option. */
function ChoicePicker({
  value,
  unsetLabel,
  unsetHint,
  options = [],
  groups = [],
  disabled,
  busy,
  ariaLabel,
  onChange,
}: {
  value?: string;
  unsetLabel: string;
  unsetHint?: string;
  options?: ChoiceOption[];
  groups?: ChoiceGroup[];
  disabled?: boolean;
  busy?: boolean;
  ariaLabel: string;
  onChange: (value?: string) => void;
}) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState<MenuPlacement>();

  const items = useMemo<FlatChoice[]>(() => {
    const flat: FlatChoice[] = [];
    options.forEach((option, index) => flat.push({ ...option, key: `o:${index}:${option.value}` }));
    for (const group of groups) {
      group.options.forEach((option, index) => flat.push({ ...option, group: group.label, key: `g:${group.label}:${index}:${option.value}` }));
    }
    return flat;
  }, [options, groups]);

  const entryCount = items.length + 1;
  const selectedIndex = value === undefined ? 0 : items.findIndex((item) => item.value === value) + 1;
  const selected = value === undefined ? undefined : items.find((item) => item.value === value);
  const currentLabel = value === undefined ? unsetLabel : selected?.label ?? value;
  const currentHint = value === undefined ? unsetHint : selected?.hint;

  const openMenu = (nextHighlight?: number) => {
    if (disabled || busy) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const width = Math.max(rect.width, 220);
    const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
    const spaceBelow = window.innerHeight - rect.bottom - gutter;
    const spaceAbove = rect.top - gutter;
    const above = spaceBelow < 190 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, Math.min(320, (above ? spaceAbove : spaceBelow) - 4));
    setPlacement({
      left,
      width,
      above,
      maxHeight,
      top: above ? undefined : rect.bottom + 6,
      bottom: above ? window.innerHeight - rect.top + 6 : undefined,
    });
    setHighlight(nextHighlight ?? Math.max(0, selectedIndex));
    setOpen(true);
  };

  const choose = (index: number) => {
    onChange(index <= 0 ? undefined : items[index - 1]?.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || busy) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(event.key === "ArrowUp" ? entryCount - 1 : 0);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlight((current) => (current + 1) % entryCount);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => (current - 1 + entryCount) % entryCount);
        break;
      case "Home":
        event.preventDefault();
        setHighlight(0);
        break;
      case "End":
        event.preventDefault();
        setHighlight(entryCount - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(highlight);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const now = Date.now();
          const buffer = (now - typeahead.current.at < 700 ? typeahead.current.text : "") + event.key;
          typeahead.current = { text: buffer, at: now };
          const needle = buffer.toLocaleLowerCase();
          if (unsetLabel.toLocaleLowerCase().startsWith(needle)) {
            setHighlight(0);
          } else {
            const match = items.findIndex((item) => item.label.toLocaleLowerCase().startsWith(needle));
            if (match >= 0) setHighlight(match + 1);
          }
        }
    }
  };

  let optionIndex = -1;
  const menu = open && placement ? createPortal(
    <div
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      className="choice-picker__menu"
      data-above={placement.above || undefined}
      style={{
        left: placement.left,
        width: placement.width,
        top: placement.top,
        bottom: placement.bottom,
        maxHeight: placement.maxHeight,
      }}
    >
      {(() => {
        const entries: ReactNode[] = [];
        const renderOption = (item: FlatChoice | undefined, key: string, label: string, hint: string | undefined, isUnset: boolean) => {
          optionIndex += 1;
          const index = optionIndex;
          const isSelected = isUnset ? value === undefined : item?.value === value;
          return (
            <div
              key={key}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={isSelected}
              className="choice-picker__option"
              data-highlighted={highlight === index || undefined}
              data-muted={isUnset || undefined}
              onMouseMove={() => { if (highlight !== index) setHighlight(index); }}
              onClick={() => choose(index)}
            >
              <span className="choice-picker__check" aria-hidden="true"><Check size={13} weight="bold" /></span>
              <span className="choice-picker__option-label">{label}</span>
              {hint && <span className="choice-picker__option-hint">{hint}</span>}
            </div>
          );
        };
        entries.push(renderOption(undefined, "unset", unsetLabel, unsetHint, true));
        let lastGroup: string | undefined;
        for (const item of items) {
          if (item.group && item.group !== lastGroup) {
            lastGroup = item.group;
            entries.push(<div key={`group:${item.group}`} className="choice-picker__group-label" aria-hidden="true">{item.group}</div>);
          }
          entries.push(renderOption(item, item.key, item.label, item.hint, false));
        }
        return entries;
      })()}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="choice-picker" data-open={open || undefined} data-busy={busy || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="choice-picker__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-option-${highlight}` : undefined}
        aria-label={ariaLabel}
        data-inherited={value === undefined || undefined}
        title={currentLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="choice-picker__value">
          <span className="choice-picker__label">{currentLabel}</span>
          {currentHint && <span className="choice-picker__hint">{currentHint}</span>}
        </span>
        <CaretUpDown size={13} weight="bold" className="choice-picker__caret" aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}

function SettingRow({
  field,
  snapshot,
  busy,
  onSave,
}: {
  field: SettingField;
  snapshot: PiSettingsSnapshot;
  busy: boolean;
  onSave: (path: string, value?: unknown) => Promise<void>;
}) {
  const controlId = useId();
  const explicit = getPath(snapshot.settings, field.path);
  const effective = getPath(snapshot.effectiveSettings, field.path);
  const inherited = snapshot.scope === "project" && explicit === undefined;
  const disabled = busy || (snapshot.scope === "project" && field.userOnly);
  const stacked = field.kind === "list" || field.kind === "json";
  const textValue = field.kind === "list"
    ? (Array.isArray(explicit) ? explicit : []).join("\n")
    : field.kind === "json"
      ? explicit === undefined ? "" : JSON.stringify(explicit, null, 2)
      : explicit === undefined ? "" : String(explicit);
  const [draft, setDraft] = useState(textValue);
  const [localError, setLocalError] = useState<string>();

  useEffect(() => {
    setDraft(textValue);
    setLocalError(undefined);
  }, [textValue]);

  const saveDraft = async () => {
    if (draft === textValue) return;
    try {
      let value: unknown = draft.trim() || undefined;
      if (field.kind === "number") value = draft.trim() ? Number(draft) : undefined;
      if (field.kind === "list") value = draft.split("\n").map((line) => line.trim()).filter(Boolean);
      if (field.kind === "json") value = draft.trim() ? JSON.parse(draft) : undefined;
      if (field.kind === "number" && typeof value === "number" && !Number.isFinite(value)) throw new Error("Enter a valid number.");
      await onSave(field.path, value);
      setLocalError(undefined);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const effectiveLabel = formatEffective(effective);
  const unsetLabel = inherited
    ? `Inherit${effectiveLabel === undefined ? "" : ` · ${effectiveLabel}`}`
    : "Pi default";

  let control: ReactNode;
  if (field.kind === "boolean" || field.kind === "select") {
    control = (
      <ChoicePicker
        ariaLabel={field.label}
        value={explicit === undefined ? undefined : String(explicit)}
        unsetLabel={unsetLabel}
        options={field.kind === "boolean"
          ? [{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }]
          : field.options ?? []}
        groups={field.groups}
        disabled={disabled}
        busy={busy}
        onChange={(next) => {
          if (field.kind === "boolean") void onSave(field.path, next === undefined ? undefined : next === "true");
          else void onSave(field.path, next);
        }}
      />
    );
  } else if (stacked) {
    control = (
      <textarea
        id={controlId}
        value={draft}
        rows={field.rows ?? 3}
        disabled={disabled}
        placeholder={inherited && effective !== undefined ? `Inherited: ${JSON.stringify(effective)}` : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void saveDraft()}
      />
    );
  } else {
    control = (
      <input
        id={controlId}
        type={field.kind === "number" ? "number" : "text"}
        min={field.min}
        max={field.max}
        value={draft}
        disabled={disabled}
        placeholder={inherited && effective !== undefined ? `Inherited: ${String(effective)}` : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void saveDraft()}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    );
  }

  return (
    <div className="setting-row" data-stacked={stacked || undefined} data-inherited={inherited || undefined} data-busy={busy || undefined}>
      <div className="setting-row__copy">
        <div className="setting-row__label-row">
          {field.kind === "boolean" || field.kind === "select"
            ? <span className="setting-row__label">{field.label}</span>
            : <label className="setting-row__label" htmlFor={controlId}>{field.label}</label>}
          {inherited && <span className="setting-row__badge">Inherited</span>}
          {field.userOnly && <span className="setting-row__badge">All projects</span>}
        </div>
        <p>{field.description}</p>
      </div>
      <div className="setting-row__control">
        {control}
        {localError && <small className="setting-row__error" role="alert">{localError}</small>}
      </div>
    </div>
  );
}

function SettingsPanel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-panel">
      <header className="settings-panel__header">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      <div className="settings-panel__shell">
        <div className="settings-panel__body">{children}</div>
      </div>
    </section>
  );
}

function FieldList({
  fields,
  snapshot,
  saving,
  onSave,
}: {
  fields: SettingField[];
  snapshot: PiSettingsSnapshot;
  saving: Record<string, boolean>;
  onSave: (path: string, value?: unknown) => Promise<void>;
}) {
  return <>{fields.map((field) => <SettingRow field={field} snapshot={snapshot} busy={Boolean(saving[field.path])} onSave={onSave} key={field.path} />)}</>;
}

const NAV_GROUPS: Array<{ label: string; items: Array<{ key: Section; icon: Icon; label: string }> }> = [
  {
    label: "Preferences",
    items: [
      { key: "general", icon: Sparkle, label: "Model & thinking" },
      { key: "behavior", icon: Lightning, label: "Runtime" },
    ],
  },
  {
    label: "Capabilities",
    items: [
      { key: "resources", icon: Wrench, label: "Tools & resources" },
      { key: "agents", icon: Robot, label: "Agents" },
      { key: "packages", icon: Package, label: "Packages" },
    ],
  },
  {
    label: "Desktop",
    items: [
      { key: "remote", icon: WifiHigh, label: "Remote Access" },
    ],
  },
];

export function SettingsSurface({
  hasProject,
  models,
  activeAgents,
  onClose,
  onNotice,
}: {
  hasProject: boolean;
  models: PiModel[];
  activeAgents: Set<string>;
  onClose: () => void;
  onNotice: (message: string, tone?: "info" | "warning" | "error") => void;
}) {
  const [scope, setScope] = useState<PiSettingsScope>("user");
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<PiSettingsSnapshot>();
  const [agentSnapshot, setAgentSnapshot] = useState<SubagentSettingsSnapshot>();
  const [packages, setPackages] = useState<PiPackagesSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [packageSource, setPackageSource] = useState("");
  const [packageBusy, setPackageBusy] = useState<string>();
  const [advancedDraft, setAdvancedDraft] = useState("");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const providerGroups = useMemo<ChoiceGroup[]>(() => {
    const grouped = new Map<string, PiModel[]>();
    for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    return [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        label: provider,
        options: entries
          .sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)))
          .map((model) => ({ value: modelKey(model), label: modelLabel(model) })),
      }));
  }, [models]);

  /* defaultModel stores only the model id per Pi's schema, so it needs its own
   * groups; agent overrides keep the provider/id form via providerGroups. */
  const defaultModelGroups = useMemo<ChoiceGroup[]>(() => {
    const grouped = new Map<string, PiModel[]>();
    for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    return [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        label: provider,
        options: entries
          .sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)))
          .map((model) => ({ value: model.id, label: modelLabel(model) })),
      }));
  }, [models]);

  const sessionFields = useMemo<SettingField[]>(() => [
    { path: "defaultProvider", label: "Default provider", description: "Provider used when a new session has no explicit model.", kind: "select", options: [...new Set(models.map((model) => model.provider))].sort().map((value) => ({ value, label: value })) },
    { path: "defaultModel", label: "Default model", description: "Model used for new sessions, grouped by provider.", kind: "select", groups: defaultModelGroups },
    { path: "defaultThinkingLevel", label: "Default thinking", description: "Reasoning depth used for new sessions.", kind: "select", options: THINKING_LEVELS.map((value) => ({ value, label: sentenceCase(value) })) },
  ], [models, defaultModelGroups]);

  const reasoningFields = useMemo<SettingField[]>(() => [
    { path: "thinkingBudgets", label: "Thinking budgets", description: "Optional JSON token budgets for minimal, low, medium, and high reasoning.", kind: "json", rows: 5 },
  ], []);

  const filteredAgents = useMemo(() => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const agents = agentSnapshot?.agents ?? [];
    if (!terms.length) return agents;
    return agents.filter((agent) => terms.every((term) => `${agent.name} ${agent.description} ${agent.effectiveModel ?? ""} ${agent.effectiveThinking ?? ""}`.toLocaleLowerCase().includes(term)));
  }, [query, agentSnapshot?.agents]);

  const agentGroups = useMemo(() => [
    { key: "builtin", label: "Built-in agents", agents: filteredAgents.filter((agent) => agent.source === "builtin") },
    { key: "custom", label: "Custom agents", agents: filteredAgents.filter((agent) => agent.source !== "builtin") },
  ].filter((group) => group.agents.length), [filteredAgents]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void Promise.all([getPiSettings(scope), getSubagentSettings(scope)]).then(([nextSettings, nextAgents]) => {
      if (!disposed) {
        setSettings(nextSettings);
        setAgentSnapshot(nextAgents);
        setAdvancedDraft(JSON.stringify(nextSettings.settings, null, 2));
        setLoading(false);
      }
    }).catch((reason) => {
      if (!disposed) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    });
    return () => { disposed = true; };
  }, [scope]);

  useEffect(() => {
    if (section !== "packages" || packages) return;
    void getPiPackages().then(setPackages).catch((reason) => onNotice(reason instanceof Error ? reason.message : String(reason), "error"));
  }, [onNotice, packages, section]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.code === "KeyW")) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !surfaceRef.current) return;
      const focusable = [...surfaceRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", handleKeyDown); previous?.focus(); };
  }, [onClose]);

  const saveSetting = async (path: string, value?: unknown) => {
    setSaving((current) => ({ ...current, [path]: true }));
    try {
      const next = await setPiSetting(scope, path, value);
      setSettings(next);
      setAdvancedDraft(JSON.stringify(next.settings, null, 2));
      onNotice(`${path} ${value === undefined ? "reset to inherit" : "saved"}. Applies to new Pi sessions after reload.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      onNotice(message, "error");
      throw reason;
    } finally {
      setSaving((current) => { const next = { ...current }; delete next[path]; return next; });
    }
  };

  const updateAgent = async (agent: SubagentSettingInfo, field: "model" | "thinking", value?: string) => {
    const key = `${agent.name}:${field}`;
    setSaving((current) => ({ ...current, [key]: true }));
    setRowErrors((current) => { const next = { ...current }; delete next[agent.name]; return next; });
    try {
      const next = await setSubagentOverride(scope, agent.name, field, value);
      setAgentSnapshot(next);
      onNotice(`${agent.name} ${field === "model" ? "model" : "thinking level"} ${value ? `set to ${value}` : "reset to inherit"}. Applies to new Pi sessions after reload.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setRowErrors((current) => ({ ...current, [agent.name]: message }));
      onNotice(message, "error");
    } finally {
      setSaving((current) => { const next = { ...current }; delete next[key]; return next; });
    }
  };

  const packageAction = async (action: "install" | "remove" | "update", source?: string) => {
    const key = `${action}:${source ?? "all"}`;
    setPackageBusy(key);
    try {
      const next = await runPiPackageAction(action, source, scope);
      setPackages(next);
      if (action === "install") setPackageSource("");
      onNotice(`${source ?? "Pi packages"} ${action === "remove" ? "removed" : action === "install" ? "installed" : "updated"}. Reload Pi to apply package changes.`);
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setPackageBusy(undefined);
    }
  };

  const handleSurfaceKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyF" && section === "agents") { event.preventDefault(); surfaceRef.current?.querySelector<HTMLInputElement>(".settings-search input")?.focus(); }
  };

  const sectionHeading: Record<Section, [string, string, string]> = {
    general: ["New sessions", "Model & thinking", "Choose the provider, model, and reasoning depth Pi starts with."],
    behavior: ["Sessions", "Runtime", "Tune message delivery, context management, retries, and connectivity."],
    resources: ["System", "Tools & resources", "Connect the shell and the local resources available to Pi."],
    agents: ["Delegation", "Agents", "Choose the model and reasoning depth for every delegated role."],
    packages: ["Extensions", "Packages", "Install, update, and remove packages through Pi's native package system."],
    remote: ["Desktop", "Remote Access", "Manage this computer's paired remote devices and TLS listener."],
    advanced: ["Raw configuration", "Advanced JSON", "Edit every setting in the selected file, including extension-defined values."],
  };
  const [eyebrow, title, description] = sectionHeading[section];

  return (
    <div className="settings-surface" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={surfaceRef} onKeyDown={handleSurfaceKeyDown}>
      <header className="settings-titlebar">
        <div className="settings-titlebar__identity"><span><Sparkle size={15} weight="fill" /></span><h1 id="settings-title">Settings</h1></div>
        <div className="settings-scope" role="group" aria-label="Settings scope">
          <button type="button" aria-pressed={scope === "user"} onClick={() => setScope("user")}>All projects</button>
          <button type="button" aria-pressed={scope === "project"} onClick={() => setScope("project")} disabled={!hasProject}>This project</button>
        </div>
        <button ref={closeRef} className="icon-button settings-close" type="button" onClick={onClose} aria-label="Close settings" title="Close settings (Esc)"><X size={15} /></button>
      </header>

      <div className="settings-layout">
        <aside className="settings-nav" aria-label="Settings categories">
          {NAV_GROUPS.map((group) => (
            <div className="settings-nav__group" key={group.label}>
              <span className="settings-nav__group-label">{group.label}</span>
              {group.items.map(({ key, icon: NavIcon, label }) => (
                <button
                  type="button"
                  className="settings-nav__item"
                  aria-current={section === key ? "page" : undefined}
                  onClick={() => setSection(key)}
                  key={key}
                >
                  <span className="settings-nav__icon" aria-hidden="true"><NavIcon size={15} weight="light" /></span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="settings-nav__footer">
            <span className="settings-nav__group-label">Advanced</span>
            <button
              type="button"
              className="settings-nav__item"
              aria-current={section === "advanced" ? "page" : undefined}
              onClick={() => setSection("advanced")}
            >
              <span className="settings-nav__icon" aria-hidden="true"><BracketsCurly size={15} weight="light" /></span>
              <span>Advanced JSON</span>
            </button>
          </div>
        </aside>

        <main className="settings-content">
          <div className="settings-content__inner">
            <div className="settings-heading">
              <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>
              {section === "agents" && <span className="settings-agent-count">{agentSnapshot?.agents.length ?? 0} agents</span>}
            </div>
            {section !== "remote" && <div className="settings-apply-note"><CheckCircle size={15} weight="fill" /><span>Changes save automatically and apply to new Pi sessions after reload. Running sessions are never changed.</span></div>}

            {loading && section !== "remote" && <div className="settings-loading" aria-label="Loading settings"><i /><i /><i /></div>}
            {error && section !== "remote" && <div className="settings-error" role="alert"><Warning size={19} /><strong>Couldn't load Pi settings</strong><span>{error}</span>{scope === "project" && <button type="button" onClick={() => setScope("user")}>Use all-project settings</button>}</div>}

            {section === "remote" && <RemoteAccessSettings onNotice={onNotice} />}

            {!loading && !error && settings && section === "general" && (
              <>
                <SettingsPanel title="New sessions" description="Used when a session starts without an explicit model.">
                  <FieldList fields={sessionFields} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
                <SettingsPanel title="Reasoning" description="Fine-tune how much thinking each level may use.">
                  <FieldList fields={reasoningFields} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
              </>
            )}

            {!loading && !error && settings && section === "behavior" && (
              <>
                <SettingsPanel title="Conversation flow" description="How queued messages and provider connections behave.">
                  <FieldList fields={FLOW_FIELDS} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
                <SettingsPanel title="Context management" description="What happens as sessions approach the context window.">
                  <FieldList fields={CONTEXT_FIELDS} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
                <SettingsPanel title="Reliability" description="Retries and timeouts for transient provider failures.">
                  <FieldList fields={RELIABILITY_FIELDS} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
                <SettingsPanel title="Connection & privacy" description="Proxying and optional telemetry.">
                  <FieldList fields={CONNECTION_FIELDS} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
              </>
            )}

            {!loading && !error && settings && section === "resources" && (
              <>
                <SettingsPanel title="Shell & sessions" description="Where Pi runs commands and stores session files.">
                  <FieldList fields={SHELL_FIELDS} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
                <SettingsPanel title="Agent resources" description="Local extensions, skills, and prompts loaded by Pi.">
                  <FieldList fields={AGENT_RESOURCE_FIELDS} snapshot={settings} saving={saving} onSave={saveSetting} />
                </SettingsPanel>
              </>
            )}

            {!loading && !error && section === "agents" && agentSnapshot && (
              <>
                <div className="settings-toolbar">
                  <label className="settings-search"><MagnifyingGlass size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents, models, or providers…" aria-label="Search agents" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={12} /></button>}</label>
                  <span>{scope === "project" ? agentSnapshot.projectRoutingEnabled ? "Project routing enabled" : "Project routing inactive" : "Authoritative user overrides"}</span>
                </div>
                {scope === "project" && !agentSnapshot.projectRoutingEnabled && (
                  <div className="package-security-note"><Warning size={15} /><span>Project model and thinking values do not affect launches. Enable <code>subagents.allowProjectAgentRouting</code> in All projects advanced settings to opt in; populated user agent overrides still win.</span></div>
                )}
                {!filteredAgents.length && <div className="settings-error settings-error--empty"><MagnifyingGlass size={19} /><strong>No matching agents</strong><span>Try a name, provider, or model id.</span><button type="button" onClick={() => setQuery("")}>Clear search</button></div>}
                {agentGroups.map((group) => (
                  <section className="agent-settings-group" aria-labelledby={`agent-settings-${group.key}`} key={group.key}>
                    <div className="agent-settings-group__heading" id={`agent-settings-${group.key}`}><span>{group.label}</span><i>{group.agents.length}</i></div>
                    <div className="settings-panel__shell">
                      <div className="settings-panel__body agent-settings-list">
                        {group.agents.map((agent) => {
                          const displayedModel = agent.effectiveModel ?? "Not configured — launch blocked";
                          const displayedThinking = agent.effectiveThinking ?? "Not configured — launch blocked";
                          const modelSaving = saving[`${agent.name}:model`]; const thinkingSaving = saving[`${agent.name}:thinking`];
                          const configuredModelMissing = agent.modelOverride && !models.some((model) => modelKey(model) === agent.modelOverride);
                          return (
                            <article className="agent-setting-row" data-live={activeAgents.has(agent.name) || undefined} data-shadowed={agent.shadowedByProject || undefined} key={agent.name}>
                              <span className="agent-setting-row__status" aria-hidden="true" />
                              <div className="agent-setting-row__identity"><div><strong>{agent.name}</strong><span className={`agent-source agent-source--${agent.source}`}>{sentenceCase(agent.source)}</span>{activeAgents.has(agent.name) && <span className="agent-live-chip">Running</span>}</div><p>{agent.description}</p>{agent.shadowedByProject && <small className="agent-shadow-notice">User-enabled project routing fills a missing user value here.</small>}</div>
                              <div className="agent-setting-control agent-setting-control--model" data-inherited={!agent.modelOverride || undefined} data-busy={modelSaving || undefined}>
                                <span>Provider / model <i>{agent.modelOverride ? agent.modelSource === "agent-file" ? "Agent file" : scope === "project" ? "Project" : "User" : sourceLabel(agent.modelSource)}</i></span>
                                <ChoicePicker
                                  ariaLabel={`Provider and model for ${agent.name}`}
                                  value={agent.modelOverride}
                                  unsetLabel={scope === "project" ? `Unset · ${displayedModel}` : displayedModel}
                                  options={configuredModelMissing ? [{ value: agent.modelOverride!, label: agent.modelOverride!, hint: "Unavailable" }] : []}
                                  groups={providerGroups}
                                  disabled={agent.modelLocked || modelSaving}
                                  busy={modelSaving}
                                  onChange={(next) => void updateAgent(agent, "model", next)}
                                />
                              </div>
                              <div className="agent-setting-control agent-setting-control--thinking" data-inherited={!agent.thinkingOverride || undefined} data-busy={thinkingSaving || undefined}>
                                <span>Thinking <i>{agent.thinkingOverride ? agent.thinkingSource === "agent-file" ? "Agent file" : scope === "project" ? "Project" : "User" : sourceLabel(agent.thinkingSource)}</i></span>
                                <ChoicePicker
                                  ariaLabel={`Thinking level for ${agent.name}`}
                                  value={agent.thinkingOverride}
                                  unsetLabel={scope === "project" ? `Unset · ${displayedThinking}` : displayedThinking}
                                  options={THINKING_LEVELS.map((level) => ({ value: level, label: sentenceCase(level) }))}
                                  disabled={agent.thinkingLocked || thinkingSaving}
                                  busy={thinkingSaving}
                                  onChange={(next) => void updateAgent(agent, "thinking", next)}
                                />
                              </div>
                              {rowErrors[agent.name] && <div className="agent-setting-row__error" role="alert">{rowErrors[agent.name]}</div>}
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                ))}
              </>
            )}

            {!loading && !error && section === "packages" && (
              <div className="package-manager">
                <SettingsPanel title="Add a package" description="Install from npm, git, or a local path.">
                  <div className="package-install-row">
                    <input value={packageSource} onChange={(event) => setPackageSource(event.target.value)} placeholder="npm:@scope/package or git:github.com/user/repo" aria-label="Package source" onKeyDown={(event) => { if (event.key === "Enter" && packageSource.trim()) void packageAction("install", packageSource.trim()); }} />
                    <button type="button" className="settings-primary-button" disabled={!packageSource.trim() || Boolean(packageBusy)} onClick={() => void packageAction("install", packageSource.trim())}><Plus size={14} /> Install</button>
                    <button type="button" disabled={Boolean(packageBusy)} onClick={() => void packageAction("update")}><ArrowClockwise size={14} /> Update all</button>
                  </div>
                  <div className="package-security-note"><Warning size={15} /><span>Pi packages can execute code with your user permissions. Install only sources you trust.</span></div>
                </SettingsPanel>
                <SettingsPanel title={scope === "project" ? "Project packages" : "User packages"} description="Packages can add extensions, skills, prompts, and themes to Pi.">
                  {!packages && <div className="settings-loading settings-loading--inline" aria-label="Loading packages"><i /><i /></div>}
                  {packages && !packages.packages.filter((entry) => entry.scope === scope).length && <div className="settings-empty"><Package size={19} /><strong>No {scope === "project" ? "project" : "user"} packages</strong><span>Install a package source above.</span></div>}
                  {packages?.packages.filter((entry) => entry.scope === scope).map((entry) => (
                    <article className="package-row" key={`${entry.scope}:${entry.source}`}>
                      <div className="package-row__icon"><Package size={18} weight={entry.required ? "fill" : "light"} /></div>
                      <div className="package-row__identity"><strong>{entry.source}</strong><span>{entry.required ? "Required by LemonPi" : entry.installed ? entry.location ?? "Installed" : "Configured · install pending"}</span></div>
                      <span className={`package-state package-state--${entry.installed ? "ready" : "pending"}`}>{entry.installed ? "Ready" : "Pending"}</span>
                      <button type="button" className="package-icon-button" title={`Update ${entry.source}`} aria-label={`Update ${entry.source}`} disabled={Boolean(packageBusy)} onClick={() => void packageAction("update", entry.source)}><ArrowClockwise size={15} /></button>
                      <button type="button" className="package-icon-button package-icon-button--danger" title={entry.required ? "Required by LemonPi" : `Remove ${entry.source}`} aria-label={`Remove ${entry.source}`} disabled={entry.required || Boolean(packageBusy)} onClick={() => void packageAction("remove", entry.source)}><Trash size={15} /></button>
                    </article>
                  ))}
                </SettingsPanel>
              </div>
            )}

            {!loading && !error && settings && section === "advanced" && (
              <SettingsPanel title={scope === "project" ? "Raw settings · this project" : "Raw settings · all projects"} description="Unknown keys are preserved exactly as written.">
                <div className="advanced-settings">
                  <div className="advanced-settings__warning"><Warning size={16} /><div><strong>Direct Pi configuration</strong><span>This replaces the selected settings file after validating that it is a JSON object. Package and auth credentials are not stored here.</span></div></div>
                  <textarea value={advancedDraft} onChange={(event) => setAdvancedDraft(event.target.value)} spellCheck={false} aria-label="Raw Pi settings JSON" />
                  <div className="advanced-settings__actions"><button type="button" onClick={() => setAdvancedDraft(JSON.stringify(settings.settings, null, 2))}>Reset editor</button><button type="button" className="settings-primary-button" onClick={() => { try { const parsed = JSON.parse(advancedDraft) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Settings must be a JSON object."); void replacePiSettings(scope, parsed as Record<string, unknown>).then((next) => { setSettings(next); setAdvancedDraft(JSON.stringify(next.settings, null, 2)); onNotice("Pi settings JSON saved. Applies to new Pi sessions after reload."); }).catch((reason) => onNotice(reason instanceof Error ? reason.message : String(reason), "error")); } catch (reason) { onNotice(reason instanceof Error ? reason.message : String(reason), "error"); } }}>Apply JSON</button></div>
                </div>
              </SettingsPanel>
            )}
          </div>
        </main>
      </div>
      <footer className="settings-footer"><span>{settings?.path ?? (scope === "user" ? "~/.pi/agent/settings.json" : ".pi/settings.json")}</span><i>Unknown settings are preserved</i></footer>
    </div>
  );
}
