import { describe, expect, it } from "vitest";
import {
  describeProjects,
  MAX_RECENT_PROJECTS,
  parseRecentProjects,
  rememberProject,
  toggleProjectPinned,
} from "./projects";

describe("recent projects", () => {
  it("keeps a large, newest-first project history instead of truncating at eight", () => {
    const projects = Array.from({ length: 24 }, (_, index) => ({
      path: `/tmp/project-${index}`,
      trusted: index % 2 === 0,
      lastOpened: index,
    }));

    const parsed = parseRecentProjects(JSON.stringify(projects));
    expect(parsed).toHaveLength(24);
    expect(parsed[0]?.path).toBe("/tmp/project-23");
  });

  it("preserves pinned projects when the recent limit is reached", () => {
    const projects = Array.from({ length: MAX_RECENT_PROJECTS }, (_, index) => ({
      path: `/tmp/project-${index}`,
      trusted: false,
      lastOpened: index,
      pinned: index === 0,
    }));

    const next = rememberProject(projects, { path: "/tmp/new", trusted: true, lastOpened: MAX_RECENT_PROJECTS + 1 });
    expect(next).toHaveLength(MAX_RECENT_PROJECTS);
    expect(next.some((project) => project.path === "/tmp/project-0")).toBe(true);
    expect(next.some((project) => project.path === "/tmp/new")).toBe(true);
  });

  it("sorts pinned workspaces ahead of recent workspaces", () => {
    const projects = [
      { path: "/tmp/new", trusted: false, lastOpened: 20 },
      { path: "/tmp/pinned", trusted: true, lastOpened: 1 },
    ];
    expect(toggleProjectPinned(projects, "/tmp/pinned")[0]?.path).toBe("/tmp/pinned");
  });
});

describe("project descriptions", () => {
  it("disambiguates projects that share the same folder name", () => {
    const descriptions = describeProjects([
      "/Users/me/Dev/client/web",
      "/Users/me/Dev/internal/web",
      "/Users/me/Dev/LemonPi",
    ]);

    expect(descriptions.get("/Users/me/Dev/client/web")?.displayName).toBe("web · client");
    expect(descriptions.get("/Users/me/Dev/internal/web")?.displayName).toBe("web · internal");
    expect(descriptions.get("/Users/me/Dev/LemonPi")?.displayName).toBe("LemonPi");
    expect(descriptions.get("/Users/me/Dev/LemonPi")?.shortPath).toBe("~/Dev/LemonPi");
  });
});
