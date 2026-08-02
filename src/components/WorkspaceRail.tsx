import {
  ArrowClockwise,
  CaretDown,
  ChatCircle,
  Check,
  FolderOpen,
  FolderPlus,
  GitFork,
  GearSix,
  MagnifyingGlass,
  Plus,
  PushPin,
  ShieldCheck,
  ShieldWarning,
  SidebarSimple,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { describeProjects, shortProjectPath, type RecentProject } from "../lib/projects";
import { filterSessions, groupSessions, sessionTitle } from "../lib/sessions-view";
import type { PiSessionState, PiSessionSummary } from "../lib/pi-types";
import { BrandMark } from "./BrandMark";

function relativeAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function focusAt(refs: Array<HTMLButtonElement | null>, index: number) {
  const bounded = Math.min(Math.max(index, 0), refs.length - 1);
  refs[bounded]?.focus();
}

type SessionsStatus = "loading" | "ready" | "error";
type ConnectionState = "offline" | "launching" | "online" | "error";

export function WorkspaceRail({
  project,
  projectTrusted,
  projects,
  state,
  sessions,
  sessionsStatus,
  unreadConversationCount,
  piVersion,
  connection,
  collapsed,
  width,
  isStreaming,
  sessionSwitching,
  settingsOpen,
  onToggle,
  onWidthChange,
  onChooseProject,
  onOpenProject,
  onPinProject,
  onForgetProject,
  onNewSession,
  onSelectSession,
  onRetrySessions,
  onOpenSettings,
}: {
  project?: string;
  projectTrusted: boolean;
  projects: RecentProject[];
  state?: PiSessionState;
  sessions: PiSessionSummary[];
  sessionsStatus: SessionsStatus;
  unreadConversationCount: number;
  piVersion?: string;
  connection: ConnectionState;
  collapsed: boolean;
  width: number;
  isStreaming: boolean;
  sessionSwitching: boolean;
  settingsOpen: boolean;
  onToggle: () => void;
  onWidthChange: (width: number) => void;
  onChooseProject: () => void;
  onOpenProject: (path: string) => void;
  onPinProject: (path: string) => void;
  onForgetProject: (path: string) => void;
  onNewSession: () => void;
  onSelectSession: (path: string) => void;
  onRetrySessions: () => void;
  onOpenSettings: () => void;
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [now, setNow] = useState(Date.now);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const projectOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sessionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const allProjects = useMemo(() => {
    if (!project || projects.some((entry) => entry.path === project)) return projects;
    return [{ path: project, trusted: projectTrusted, lastOpened: Date.now() }, ...projects];
  }, [project, projectTrusted, projects]);
  const descriptions = useMemo(() => describeProjects(allProjects.map((entry) => entry.path)), [allProjects]);
  const currentDescription = project ? descriptions.get(project) : undefined;
  const activeName = currentDescription?.displayName ?? "Choose a project";
  const projectSwitching = connection === "launching";
  const sessionLocked = isStreaming || sessionSwitching || projectSwitching;
  const unreadConversationLabel = `${unreadConversationCount} unread conversation${unreadConversationCount === 1 ? "" : "s"}`;

  const filteredProjects = useMemo(() => {
    const terms = projectQuery.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return allProjects;
    return allProjects.filter((entry) => {
      const description = descriptions.get(entry.path);
      const haystack = `${description?.displayName ?? ""} ${entry.path}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [allProjects, descriptions, projectQuery]);
  const pinnedProjects = filteredProjects.filter((entry) => entry.pinned);
  const recentProjectOptions = filteredProjects.filter((entry) => !entry.pinned);

  const filteredSessions = useMemo(() => filterSessions(sessions, sessionQuery), [sessionQuery, sessions]);
  const sessionGroups = useMemo(() => groupSessions(filteredSessions, now), [filteredSessions, now]);
  const activeSessionIndex = filteredSessions.findIndex((session) => session.path === state?.sessionFile);
  const visibleSessionPaths = useMemo(() => new Set(filteredSessions.map((session) => session.path)), [filteredSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    const frame = window.requestAnimationFrame(() => projectSearchRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectMenuOpen]);

  const handleProjectOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(projectOptionRefs.current, index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) projectSearchRef.current?.focus();
      else focusAt(projectOptionRefs.current, index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(projectOptionRefs.current, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(projectOptionRefs.current, filteredProjects.length - 1);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => onWidthChange(Math.min(420, Math.max(228, moveEvent.clientX)));
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  };

  const renderProjectOption = (entry: RecentProject) => {
    const index = filteredProjects.findIndex((candidate) => candidate.path === entry.path);
    const description = descriptions.get(entry.path);
    const current = entry.path === project;
    const locked = projectSwitching && !current;
    return (
      <div className="project-option" data-current={current || undefined} key={entry.path}>
        <button
          className="project-option__main"
          type="button"
          ref={(node) => { projectOptionRefs.current[index] = node; }}
          aria-disabled={locked || undefined}
          onKeyDown={(event) => handleProjectOptionKeyDown(event, index)}
          onClick={() => {
            if (locked) return;
            setProjectMenuOpen(false);
            setProjectQuery("");
            if (!current) onOpenProject(entry.path);
          }}
        >
          <FolderOpen className="project-option__icon" size={16} weight="light" aria-hidden="true" />
          <span className="project-option__copy">
            <strong>{description?.displayName ?? entry.path}</strong>
            <small>{description?.shortPath ?? shortProjectPath(entry.path)}</small>
          </span>
          <span className={`project-trust ${entry.trusted ? "project-trust--trusted" : ""}`} title={entry.trusted ? "Trusted project" : "Safe mode"}>
            {entry.trusted ? <ShieldCheck size={12} weight="fill" /> : <ShieldWarning size={12} />}
            <span className="sr-only">{entry.trusted ? "Trusted" : "Safe mode"}</span>
          </span>
          {current && <Check className="project-option__check" size={13} weight="bold" aria-label="Current project" />}
        </button>
        <button
          className="project-option__action"
          type="button"
          aria-label={entry.pinned ? `Unpin ${description?.displayName}` : `Pin ${description?.displayName}`}
          aria-pressed={entry.pinned || false}
          onClick={() => onPinProject(entry.path)}
        >
          <PushPin size={13} weight={entry.pinned ? "fill" : "regular"} />
        </button>
        {!current && (
          <button
            className="project-option__action"
            type="button"
            aria-label={`Forget ${description?.displayName}`}
            onClick={() => onForgetProject(entry.path)}
          >
            <X size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <aside
      id="workspace-rail"
      className={`workspace-rail ${collapsed ? "workspace-rail--collapsed" : ""}`}
      aria-label="Workspace"
      style={{ "--workspace-rail-width": `${width}px` } as CSSProperties}
    >
      <div className="workspace-rail__top">
        <BrandMark compact={collapsed} />
        <button
          className="icon-button rail-collapse-button"
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="workspace-rail-body"
          title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘B)`}
        >
          <SidebarSimple size={16} weight="light" />
        </button>
      </div>

      <div className="project-switcher" ref={projectMenuRef}>
        <button
          className="project-switcher__trigger"
          type="button"
          onClick={() => setProjectMenuOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={projectMenuOpen}
          aria-label={`${activeName}. Switch project`}
        >
          <FolderOpen className="project-switcher__icon" size={18} weight="light" aria-hidden="true" />
          {!collapsed && (
            <>
              <span className="project-switcher__copy">
                <strong>{activeName}</strong>
                <small>{project ? `${shortProjectPath(project)} · ${projectTrusted ? "trusted" : "safe mode"}` : "Open or search your workspaces"}</small>
              </span>
              <span className={`project-connection project-connection--${connection}`} aria-label={`Pi ${connection}`} />
              <CaretDown className="project-switcher__caret" size={13} weight="bold" />
            </>
          )}
        </button>

        {projectMenuOpen && (
          <div className="project-switcher__popover" role="dialog" aria-label="Switch project">
            <div className="project-search">
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                ref={projectSearchRef}
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && filteredProjects.length > 0) {
                    event.preventDefault();
                    focusAt(projectOptionRefs.current, 0);
                  }
                }}
                placeholder="Search projects and paths…"
                aria-label="Search projects"
              />
              {projectQuery && (
                <button type="button" onClick={() => setProjectQuery("")} aria-label="Clear project search"><X size={12} /></button>
              )}
            </div>
            <div className="project-options">
              {pinnedProjects.length > 0 && (
                <section aria-labelledby="pinned-projects-heading">
                  <div className="project-options__heading" id="pinned-projects-heading"><span>Pinned</span><i>{pinnedProjects.length}</i></div>
                  {pinnedProjects.map(renderProjectOption)}
                </section>
              )}
              {recentProjectOptions.length > 0 && (
                <section aria-labelledby="recent-projects-heading">
                  <div className="project-options__heading" id="recent-projects-heading"><span>Recent</span><i>{recentProjectOptions.length}</i></div>
                  {recentProjectOptions.map(renderProjectOption)}
                </section>
              )}
              {filteredProjects.length === 0 && projectQuery.trim() && (
                <div className="project-options__empty">
                  <MagnifyingGlass size={17} weight="light" />
                  <strong>No matching projects</strong>
                  <span>Nothing matches “{projectQuery.trim()}”.</span>
                </div>
              )}
              {allProjects.length === 0 && !projectQuery.trim() && (
                <div className="project-options__empty project-options__empty--first">
                  <FolderPlus size={18} weight="light" />
                  <strong>No projects yet</strong>
                  <span>Open a folder to add your first project.</span>
                </div>
              )}
            </div>
            {projectSwitching && <div className="project-switcher__busy">Opening project…</div>}
            <button className="project-switcher__open" type="button" onClick={() => { setProjectMenuOpen(false); onChooseProject(); }}>
              <FolderPlus size={15} weight="light" />
              <span>{allProjects.length === 0 ? "Open a folder…" : "Open another folder…"}</span>
              <kbd>⌘O</kbd>
            </button>
          </div>
        )}
      </div>

      {collapsed ? (
        <div className="workspace-rail__compact-actions" id="workspace-rail-body">
          <button type="button" className="compact-rail-button" onClick={onNewSession} disabled={!project || sessionLocked} aria-label="New session" title="New session">
            <Plus size={17} />
          </button>
          <button type="button" className="compact-rail-button compact-rail-button--sessions" onClick={onToggle} aria-label={`Show ${unreadConversationLabel}`} title={`Show ${unreadConversationLabel}`}>
            <ChatCircle size={17} />
            {unreadConversationCount > 0 && <i aria-hidden="true">{unreadConversationCount > 99 ? "99+" : unreadConversationCount}</i>}
          </button>
        </div>
      ) : (
        <div className="workspace-rail__body" id="workspace-rail-body">
          <button className="rail-new-session" type="button" onClick={onNewSession} disabled={!project || sessionLocked}>
            <span className="rail-new-session__icon"><Plus size={14} weight="bold" /></span>
            <span>New session</span>
            <kbd>⌘N</kbd>
          </button>

          {project ? (
            <nav className="workspace-rail__sessions" aria-label="Sessions">
              <div className="session-list__heading">
                <span>History</span>
                <i aria-label={unreadConversationLabel} title={unreadConversationLabel}>{unreadConversationCount}</i>
              </div>
              {(sessions.length >= 5 || sessionQuery) && (
                <label className="session-search">
                  <MagnifyingGlass size={13} aria-hidden="true" />
                  <input
                    value={sessionQuery}
                    onChange={(event) => setSessionQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && filteredSessions.length > 0) {
                        event.preventDefault();
                        focusAt(sessionRefs.current, activeSessionIndex >= 0 ? activeSessionIndex : 0);
                      }
                    }}
                    placeholder="Find a session…"
                    aria-label="Find a session"
                  />
                  {sessionQuery && <button type="button" onClick={() => setSessionQuery("")} aria-label="Clear session search"><X size={11} /></button>}
                </label>
              )}

              <div className="session-list">
                {sessionsStatus === "loading" && sessions.length === 0 && (
                  <div className="session-list__loading" aria-label="Loading sessions">
                    <i /><i /><i />
                  </div>
                )}
                {sessionsStatus === "error" && (
                  <div className="session-list__state session-list__state--error">
                    <WarningMark />
                    <strong>Couldn’t read session history</strong>
                    <button type="button" onClick={onRetrySessions}><ArrowClockwise size={12} /> Retry</button>
                  </div>
                )}
                {sessionsStatus === "ready" && sessions.length === 0 && (
                  <div className="session-list__state">
                    <ChatCircle size={18} weight="light" />
                    <strong>No sessions yet</strong>
                    <span>Send a message to begin one.</span>
                  </div>
                )}
                {sessionsStatus === "ready" && sessions.length > 0 && filteredSessions.length === 0 && (
                  <div className="session-list__state">
                    <MagnifyingGlass size={17} weight="light" />
                    <strong>No matching sessions</strong>
                    <button type="button" onClick={() => setSessionQuery("")}>Clear search</button>
                  </div>
                )}
                {sessionGroups.map((group) => (
                  <section className="session-group" aria-labelledby={`session-group-${group.key}`} key={group.key}>
                    <div className="session-group__heading" id={`session-group-${group.key}`}>
                      <span>{group.label}</span><i>{group.sessions.length}</i>
                    </div>
                    <div>
                      {group.sessions.map((session) => {
                        const index = filteredSessions.findIndex((candidate) => candidate.path === session.path);
                        const current = session.path === state?.sessionFile;
                        const locked = (isStreaming || sessionSwitching) && !current;
                        const title = sessionTitle(session);
                        const isFork = Boolean(session.parentSessionPath && visibleSessionPaths.has(session.parentSessionPath));
                        return (
                          <button
                            className="session-row"
                            type="button"
                            aria-current={current ? "true" : undefined}
                            aria-disabled={locked || undefined}
                            tabIndex={current || (activeSessionIndex < 0 && index === 0) ? 0 : -1}
                            ref={(node) => { sessionRefs.current[index] = node; }}
                            onClick={() => !current && !locked && onSelectSession(session.path)}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowDown") {
                                event.preventDefault();
                                focusAt(sessionRefs.current, index + 1);
                              } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                focusAt(sessionRefs.current, index - 1);
                              } else if (event.key === "Home") {
                                event.preventDefault();
                                focusAt(sessionRefs.current, 0);
                              } else if (event.key === "End") {
                                event.preventDefault();
                                focusAt(sessionRefs.current, filteredSessions.length - 1);
                              }
                            }}
                            title={locked ? "Finish or stop the current response before switching sessions" : title}
                            key={session.path}
                          >
                            <span className="session-row__accent" aria-hidden="true" />
                            {isFork && <GitFork className="session-row__fork" size={12} aria-label="Forked session" />}
                            <span className="session-row__copy">
                              <strong>{title}</strong>
                              <small>
                                <span>{session.messageCount} {session.messageCount === 1 ? "message" : "messages"}</span>
                                <span aria-hidden="true">·</span>
                                <time dateTime={new Date(session.modified).toISOString()} title={new Date(session.modified).toLocaleString()}>{relativeAge(session.modified, now)}</time>
                              </small>
                            </span>
                            {current && isStreaming && <span className="session-row__live"><span className="sr-only">Generating</span></span>}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </nav>
          ) : (
            <div className="rail-empty-project">
              <FolderOpen size={20} weight="light" />
              <strong>Your projects live here</strong>
              <span>Open a folder to start working.</span>
              <button type="button" onClick={onChooseProject}>Open folder</button>
            </div>
          )}
        </div>
      )}

      <footer className="workspace-rail__footer">
        <button
          className="rail-settings-button"
          type="button"
          onClick={onOpenSettings}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-label="Settings"
          title="Settings (⌘,)"
        >
          <GearSix size={15} weight="light" />
          {!collapsed && <><strong>Settings</strong><span>{piVersion ? `Pi ${piVersion}` : "Pi unavailable"}</span></>}
          <i className={`project-connection project-connection--${connection}`} aria-label={`Pi ${connection}`} />
        </button>
      </footer>

      {!collapsed && (
        <div
          className="workspace-rail__resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={228}
          aria-valuemax={420}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => onWidthChange(272)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") onWidthChange(Math.max(228, width - (event.shiftKey ? 48 : 16)));
            if (event.key === "ArrowRight") onWidthChange(Math.min(420, width + (event.shiftKey ? 48 : 16)));
            if (event.key === "Home") onWidthChange(228);
            if (event.key === "End") onWidthChange(420);
          }}
        />
      )}
    </aside>
  );
}

function WarningMark() {
  return <span className="session-list__warning" aria-hidden="true">!</span>;
}
