import { describe, expect, it } from "vitest";
import { decideStartupGate } from "./startup-gate";

const restoringStartup = {
  detectionSettled: true,
  hasPi: true,
  hasRecentProject: true,
  restorationInFlight: true,
  hasProject: false,
  hasCandidatePath: false,
};

describe("startup splash gate", () => {
  it("keeps the splash up while an automatic restore hydrates, even after the project state is populated", () => {
    expect(decideStartupGate({ ...restoringStartup, hasProject: true })).toBe("wait");
    expect(decideStartupGate({ ...restoringStartup, hasCandidatePath: true })).toBe("wait");
  });

  it("releases the splash for the real no-project and detection-failure states", () => {
    expect(decideStartupGate({
      detectionSettled: true,
      hasPi: true,
      hasRecentProject: false,
      restorationInFlight: false,
      hasProject: false,
      hasCandidatePath: false,
    })).toBe("finish");
    expect(decideStartupGate({
      detectionSettled: true,
      hasPi: false,
      hasRecentProject: true,
      restorationInFlight: false,
      hasProject: false,
      hasCandidatePath: false,
    })).toBe("finish");
  });

  it("starts an automatic restore only after detection has settled", () => {
    expect(decideStartupGate({
      detectionSettled: false,
      hasPi: true,
      hasRecentProject: true,
      restorationInFlight: false,
      hasProject: false,
      hasCandidatePath: false,
    })).toBe("wait");
    expect(decideStartupGate({
      detectionSettled: true,
      hasPi: true,
      hasRecentProject: true,
      restorationInFlight: false,
      hasProject: false,
      hasCandidatePath: false,
    })).toBe("restore");
  });
});
