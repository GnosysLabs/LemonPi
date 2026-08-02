export type StartupGateDecision = "wait" | "finish" | "restore";

export function decideStartupGate({
  detectionSettled,
  hasPi,
  hasRecentProject,
  restorationInFlight,
  hasProject,
  hasCandidatePath,
}: {
  detectionSettled: boolean;
  hasPi: boolean;
  hasRecentProject: boolean;
  restorationInFlight: boolean;
  hasProject: boolean;
  hasCandidatePath: boolean;
}): StartupGateDecision {
  if (!detectionSettled || restorationInFlight) return "wait";
  if (!hasPi || !hasRecentProject || hasProject || hasCandidatePath) return "finish";
  return "restore";
}
