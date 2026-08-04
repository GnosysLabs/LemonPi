import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { finalizationToolIssue, type PrimaryValidationTarget } from "./orchestration-runtime.ts";

interface FinalizationMarker {
  version: 1;
  runId: string;
  phase: "finalizing";
  root?: string;
  ownedPaths: string[];
  primaryValidation?: PrimaryValidationTarget;
}

function activeMarker(): FinalizationMarker | undefined {
  const runId = process.env.PI_SUBAGENT_RUN_ID?.trim();
  if (!runId) return undefined;
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  try {
    const value = JSON.parse(readFileSync(resolve(homedir(), ".pi", "lemonpi", "finalization", `${safeRunId}.json`), "utf8")) as FinalizationMarker;
    if (value.version !== 1 || value.runId !== runId || value.phase !== "finalizing" || !Array.isArray(value.ownedPaths)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export default function lemonPiFinalizationGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const marker = activeMarker();
    if (!marker) return;
    const issue = finalizationToolIssue({
      toolName: event.toolName,
      toolInput: event.input,
      ownedPaths: marker.ownedPaths,
      root: marker.root,
      primaryValidation: marker.primaryValidation,
    });
    return issue ? { block: true, reason: issue } : undefined;
  });
}
