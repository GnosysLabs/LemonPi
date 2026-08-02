import { describe, expect, it } from "vitest";
import { AppUpdaterController, UPDATE_CHECK_INTERVAL_MS, type AppUpdaterState, type UpdaterResource } from "./app-updater";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function update(version = "0.2.0", events: string[] = []): UpdaterResource {
  return {
    version,
    download: async (onEvent) => {
      events.push("download");
      onEvent?.({ event: "Started", data: { contentLength: 20 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 20 } });
      onEvent?.({ event: "Finished" });
    },
    install: async () => { events.push("install"); },
    close: async () => { events.push("close"); },
  };
}

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("AppUpdaterController", () => {
  it("checks immediately, schedules exactly hourly, and never overlaps a pending check", async () => {
    const pending = deferred<UpdaterResource | null>();
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const states: AppUpdaterState[] = [];
    const controller = new AppUpdaterController({
      check: () => pending.promise,
      stopPi: async () => undefined,
      relaunch: async () => undefined,
      onState: (state) => states.push(state),
      setInterval: (callback, delay) => {
        scheduled.push({ callback, delay });
        return 1 as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });

    controller.start();
    scheduled[0].callback();
    expect(scheduled[0].delay).toBe(UPDATE_CHECK_INTERVAL_MS);
    pending.resolve(null);
    await flush();

    expect(states).toEqual([{ phase: "idle" }]);
    await controller.dispose();
  });

  it("downloads before stopping Pi, then installs and relaunches a startup update", async () => {
    const events: string[] = [];
    const states: AppUpdaterState[] = [];
    const controller = new AppUpdaterController({
      check: async () => update("0.2.0", events),
      stopPi: async () => { events.push("stop-pi"); },
      relaunch: async () => { events.push("relaunch"); },
      onState: (state) => states.push(state),
      setInterval: () => 1 as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });

    controller.start();
    await flush();
    await flush();

    expect(events).toEqual(["download", "stop-pi", "install", "relaunch"]);
    expect(states.map((state) => state.phase)).toEqual(["downloading", "downloading", "downloading", "installing"]);
    await controller.dispose();
  });

  it("shows hourly updates, keeps a dismissal for the same version, and notifies for a newer version", async () => {
    const scheduled: Array<() => void> = [];
    const states: AppUpdaterState[] = [];
    const updates = [null, update("0.2.0"), update("0.2.0"), update("0.3.0")];
    const controller = new AppUpdaterController({
      check: async () => updates.shift() ?? null,
      stopPi: async () => undefined,
      relaunch: async () => undefined,
      onState: (state) => states.push(state),
      setInterval: (callback) => {
        scheduled.push(callback);
        return 1 as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });

    controller.start();
    await flush();
    scheduled[0]();
    await flush();
    controller.dismiss();
    scheduled[0]();
    await flush();
    scheduled[0]();
    await flush();

    expect(states).toEqual([
      { phase: "idle" },
      { phase: "available", version: "0.2.0" },
      { phase: "idle" },
      { phase: "idle" },
      { phase: "available", version: "0.3.0" },
    ]);
    await controller.dispose();
  });

  it("shows startup failures but leaves hourly check failures quiet", async () => {
    const states: AppUpdaterState[] = [];
    const backgroundErrors: unknown[] = [];
    const scheduled: Array<() => void> = [];
    let calls = 0;
    const controller = new AppUpdaterController({
      check: async () => {
        calls += 1;
        throw new Error(calls === 1 ? "startup unavailable" : "hourly unavailable");
      },
      stopPi: async () => undefined,
      relaunch: async () => undefined,
      onState: (state) => states.push(state),
      onBackgroundError: (error) => backgroundErrors.push(error),
      setInterval: (callback) => {
        scheduled.push(callback);
        return 1 as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });

    controller.start();
    await flush();
    scheduled[0]();
    await flush();

    expect(states).toEqual([{ phase: "error", error: "startup unavailable" }]);
    expect(backgroundErrors).toHaveLength(1);
    await controller.dispose();
  });
});
