import type { PiSessionSummary } from "./pi-types";

export type SessionGroup = {
  key: string;
  label: string;
  sessions: PiSessionSummary[];
};

export function sessionTitle(session: PiSessionSummary): string {
  return session.name?.trim() || session.firstMessage.trim() || "Untitled session";
}

export function filterSessions(sessions: PiSessionSummary[], query: string): PiSessionSummary[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const haystack = `${sessionTitle(session)} ${session.firstMessage} ${session.path}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function groupSessions(sessions: PiSessionSummary[], now = Date.now()): SessionGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 7 * 86_400_000;
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const groups = new Map<string, SessionGroup>();

  for (const session of sessions) {
    let key: string;
    let label: string;
    if (session.modified >= todayStart) {
      key = "today";
      label = "Today";
    } else if (session.modified >= yesterdayStart) {
      key = "yesterday";
      label = "Yesterday";
    } else if (session.modified >= weekStart) {
      key = "week";
      label = "Previous 7 days";
    } else if (session.modified >= monthStart) {
      key = "month";
      label = "This month";
    } else {
      const date = new Date(session.modified);
      key = `${date.getFullYear()}-${date.getMonth()}`;
      label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
    }

    const group = groups.get(key) ?? { key, label, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }

  return [...groups.values()];
}
