export type RecentProject = {
  path: string;
  trusted: boolean;
  lastOpened: number;
  pinned?: boolean;
};

export type ProjectDescription = {
  name: string;
  qualifier?: string;
  displayName: string;
  shortPath: string;
};

export const RECENT_PROJECTS_KEY = "lemonpi.recent-projects.v2";
export const LEGACY_RECENT_PROJECTS_KEY = "lemonpi.recent-projects.v1";
export const MAX_RECENT_PROJECTS = 100;

function sortProjects(projects: RecentProject[]): RecentProject[] {
  return [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastOpened - a.lastOpened);
}

export function parseRecentProjects(raw: string | null): RecentProject[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const projects = value.filter((entry): entry is RecentProject => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<RecentProject>;
      if (
        typeof candidate.path !== "string"
        || candidate.path.length === 0
        || typeof candidate.trusted !== "boolean"
        || typeof candidate.lastOpened !== "number"
        || (candidate.pinned !== undefined && typeof candidate.pinned !== "boolean")
        || seen.has(candidate.path)
      ) return false;
      seen.add(candidate.path);
      return true;
    });
    return trimProjects(sortProjects(projects));
  } catch {
    return [];
  }
}

export function loadRecentProjects(): RecentProject[] {
  try {
    const current = window.localStorage.getItem(RECENT_PROJECTS_KEY);
    return parseRecentProjects(current ?? window.localStorage.getItem(LEGACY_RECENT_PROJECTS_KEY));
  } catch {
    return [];
  }
}

export function rememberProject(
  projects: RecentProject[],
  project: Omit<RecentProject, "pinned"> & { pinned?: boolean },
): RecentProject[] {
  const existing = projects.find((entry) => entry.path === project.path);
  const next = projects.filter((entry) => entry.path !== project.path);
  next.push({ ...project, pinned: project.pinned ?? existing?.pinned });
  return trimProjects(sortProjects(next));
}

export function toggleProjectPinned(projects: RecentProject[], path: string): RecentProject[] {
  return sortProjects(projects.map((project) => project.path === path ? { ...project, pinned: !project.pinned } : project));
}

export function forgetProject(projects: RecentProject[], path: string): RecentProject[] {
  return projects.filter((project) => project.path !== path);
}

function trimProjects(projects: RecentProject[]): RecentProject[] {
  const pinned = projects.filter((project) => project.pinned);
  const recent = projects.filter((project) => !project.pinned).slice(0, Math.max(0, MAX_RECENT_PROJECTS - pinned.length));
  return [...pinned, ...recent];
}

export function projectPathForDisplay(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (/^\/\/\?\/UNC\//i.test(normalized)) return normalized.replace(/^\/\/\?\/UNC\//i, "//");
  return normalized.replace(/^\/\/\?\//, "");
}

function pathSegments(path: string): string[] {
  return projectPathForDisplay(path).split("/").filter(Boolean);
}

export function shortProjectPath(path: string): string {
  const normalized = projectPathForDisplay(path);
  return normalized.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

export function describeProjects(paths: string[]): Map<string, ProjectDescription> {
  const uniquePaths = [...new Set(paths)];
  const segmentMap = new Map(uniquePaths.map((path) => [path, pathSegments(path)]));
  const descriptions = new Map<string, ProjectDescription>();

  for (const path of uniquePaths) {
    const segments = segmentMap.get(path) ?? [path];
    const name = segments.at(-1) ?? path;
    const collisions = uniquePaths.filter((candidate) => (segmentMap.get(candidate)?.at(-1) ?? candidate) === name);
    let qualifier: string | undefined;

    if (collisions.length > 1) {
      const maxDepth = Math.max(...collisions.map((candidate) => Math.max(1, (segmentMap.get(candidate)?.length ?? 1) - 1)));
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        const own = segments.slice(Math.max(0, segments.length - 1 - depth), -1).join("/");
        const unique = collisions.every((candidate) => {
          if (candidate === path) return true;
          const candidateSegments = segmentMap.get(candidate) ?? [candidate];
          return candidateSegments.slice(Math.max(0, candidateSegments.length - 1 - depth), -1).join("/") !== own;
        });
        if (unique) {
          qualifier = own;
          break;
        }
      }
    }

    descriptions.set(path, {
      name,
      qualifier,
      displayName: qualifier ? `${name} · ${qualifier}` : name,
      shortPath: shortProjectPath(path),
    });
  }

  return descriptions;
}
