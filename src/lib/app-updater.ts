import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriRuntime, stopPi } from "./pi-client";

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export type AppUpdaterPhase = "idle" | "available" | "downloading" | "installing" | "error";

export type AppUpdaterState = {
  phase: AppUpdaterPhase;
  version?: string;
  error?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

export type UpdaterResource = Pick<Update, "version" | "download" | "install" | "close">;
type CheckKind = "startup" | "hourly";
type IntervalHandle = ReturnType<typeof setInterval>;

export type AppUpdaterDependencies = {
  check: () => Promise<UpdaterResource | null>;
  stopPi: () => Promise<void>;
  relaunch: () => Promise<void>;
  onState: (state: AppUpdaterState) => void;
  onBackgroundError?: (error: unknown) => void;
  setInterval?: (callback: () => void, delay: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/i, "") || "Unknown updater error";
}

/**
 * A single-flight updater coordinator. It owns native updater resources so they
 * are closed when superseded or when the app unmounts, while its state remains
 * plain data for the UI and deterministic tests.
 */
export class AppUpdaterController {
  private state: AppUpdaterState = { phase: "idle" };
  private update?: UpdaterResource;
  private interval?: IntervalHandle;
  private operation?: "checking" | "installing";
  private dismissedVersion?: string;
  private disposed = false;

  constructor(private readonly dependencies: AppUpdaterDependencies) {}

  start(): void {
    if (this.interval !== undefined || this.disposed) return;
    void this.checkForUpdate("startup");
    const schedule = this.dependencies.setInterval ?? setInterval;
    this.interval = schedule(() => { void this.checkForUpdate("hourly"); }, UPDATE_CHECK_INTERVAL_MS);
  }

  async retry(): Promise<void> {
    await this.checkForUpdate("startup");
  }

  async installAndRestart(): Promise<void> {
    if (!this.update || this.operation || this.disposed) return;
    this.operation = "installing";
    let downloadedBytes = 0;
    let totalBytes: number | undefined;
    this.publish({ phase: "downloading", version: this.update.version, downloadedBytes, totalBytes });

    try {
      await this.update.download((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
        } else {
          return;
        }
        if (!this.disposed) {
          this.publish({ phase: "downloading", version: this.update?.version, downloadedBytes, totalBytes });
        }
      });
      if (this.disposed) return;

      // Keep LemonPi and its Pi subprocess available until the signed bundle is
      // fully downloaded. A stop failure is treated as an install failure rather
      // than installing while the managed subprocess is still alive.
      await this.dependencies.stopPi();
      if (this.disposed) return;

      this.publish({ phase: "installing", version: this.update.version });
      await this.update.install();
      // Windows installers can exit LemonPi before install() returns. Relaunch
      // only runs when the updater has left this process alive to receive it.
      await this.dependencies.relaunch();
    } catch (error) {
      if (!this.disposed) this.publish({ phase: "error", version: this.update?.version, error: errorMessage(error) });
    } finally {
      this.operation = undefined;
    }
  }

  dismiss(): void {
    if (this.state.version) this.dismissedVersion = this.state.version;
    this.publish({ phase: "idle" });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.interval !== undefined) {
      const cancel = this.dependencies.clearInterval ?? clearInterval;
      cancel(this.interval);
      this.interval = undefined;
    }
    const update = this.update;
    this.update = undefined;
    if (update) await update.close().catch(() => undefined);
  }

  private async checkForUpdate(kind: CheckKind): Promise<void> {
    if (this.operation || this.disposed) return;
    this.operation = "checking";
    try {
      const update = await this.dependencies.check();
      if (this.disposed) {
        if (update) await update.close().catch(() => undefined);
        return;
      }
      this.replaceUpdate(update);
      if (!update) {
        this.publish({ phase: "idle" });
        return;
      }
      if (kind === "startup") {
        this.operation = undefined;
        await this.installAndRestart();
        return;
      }
      if (update.version === this.dismissedVersion) {
        this.publish({ phase: "idle" });
      } else {
        this.publish({ phase: "available", version: update.version });
      }
    } catch (error) {
      if (kind === "hourly") {
        this.dependencies.onBackgroundError?.(error);
      } else if (!this.disposed) {
        this.publish({ phase: "error", error: errorMessage(error) });
      }
    } finally {
      if (this.operation === "checking") this.operation = undefined;
    }
  }

  private replaceUpdate(next: UpdaterResource | null): void {
    const previous = this.update;
    this.update = next ?? undefined;
    if (previous && previous !== next) void previous.close().catch(() => undefined);
  }

  private publish(state: AppUpdaterState): void {
    this.state = state;
    this.dependencies.onState(state);
  }
}

export function isProductionTauriUpdaterRuntime(): boolean {
  return import.meta.env.PROD && isTauriRuntime();
}

export function useAppUpdater(): AppUpdaterState & {
  installAndRestart: () => Promise<void>;
  retry: () => Promise<void>;
  dismiss: () => void;
} {
  const [state, setState] = useState<AppUpdaterState>({ phase: "idle" });
  const controllerRef = useRef<AppUpdaterController | undefined>(undefined);

  useEffect(() => {
    if (!isProductionTauriUpdaterRuntime()) return;
    const controller = new AppUpdaterController({
      check: () => check({ timeout: 30_000 }),
      stopPi,
      relaunch,
      onState: setState,
      onBackgroundError: (error) => console.warn("LemonPi update check failed", error),
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controllerRef.current = undefined;
      void controller.dispose();
    };
  }, []);

  const installAndRestart = useCallback(() => controllerRef.current?.installAndRestart() ?? Promise.resolve(), []);
  const retry = useCallback(() => controllerRef.current?.retry() ?? Promise.resolve(), []);
  const dismiss = useCallback(() => controllerRef.current?.dismiss(), []);

  return { ...state, installAndRestart, retry, dismiss };
}

