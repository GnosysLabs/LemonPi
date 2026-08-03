import { describe, expect, it } from "vitest";
import { createRemoteClient, type PairingMaterial, type RemoteConfig, type RemoteStatus } from "./remote-client";
import {
  ACCESS_MODE_LABELS,
  applyRemoteConfiguration,
  applyRemoteResponse,
  beginRemoteRequest,
  clearRemotePairing,
  compatiblePairingHosts,
  completeRemoteConfig,
  describeRemoteStatus,
  disposeRemoteUi,
  initialRemoteUiState,
  pairingExpiry,
  pairingHostError,
  pairingHostLabel,
  pairingPayload,
  parseRemotePort,
  redactExpiredPairing,
  shouldRefreshDevicesAfterRevoke,
  staleDeviceNotice,
} from "./remote-access";

const config: RemoteConfig = { version: 1, enabled: false, port: 8787, accessMode: "lanAndTailscale" };
const running: RemoteStatus = {
  enabled: true,
  running: true,
  port: 8787,
  accessMode: "lanAndTailscale",
  hostId: "host-identifier",
  pairingActive: false,
};
const material: PairingMaterial = {
  version: 1,
  host: "macbook.local",
  port: 8787,
  hostId: "host-identifier",
  code: "123456",
  certificatePin: "pin",
  expiresAt: "2026-08-03T12:01:00.000Z",
};

describe("remote access helpers", () => {
  it("labels access modes and serializes a complete versioned configuration", () => {
    expect(ACCESS_MODE_LABELS).toEqual({
      lanAndTailscale: "LAN & Tailscale",
      lanOnly: "LAN only",
      tailscaleOnly: "Tailscale only",
    });
    expect(completeRemoteConfig(config, { enabled: true, port: "9443", accessMode: "tailscaleOnly" })).toEqual({
      version: 1,
      enabled: true,
      port: 9443,
      accessMode: "tailscaleOnly",
    });
  });

  it("only accepts complete ports from 1 through 65535", () => {
    expect(parseRemotePort(1)).toBe(1);
    expect(parseRemotePort("65535")).toBe(65535);
    expect(parseRemotePort(0)).toBeUndefined();
    expect(parseRemotePort(65536)).toBeUndefined();
    expect(parseRemotePort("1.5")).toBeUndefined();
    expect(parseRemotePort(Number.NaN)).toBeUndefined();
  });

  it("validates ordinary hosts and plain IPv6 without accepting URL syntax", () => {
    expect(pairingHostError("macbook.local")).toBeUndefined();
    expect(pairingHostError("100.64.0.1")).toBeUndefined();
    expect(pairingHostError("2001:db8::1")).toBeUndefined();
    expect(pairingHostError("[2001:db8::1]")).toMatch(/plain IPv6|URL/);
    expect(pairingHostError("https://macbook.local/path")).toMatch(/URL/);
    expect(pairingHostError("bad host")).toBeDefined();
  });

  it("counts down, expires at the boundary, and redacts expired material", () => {
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    expect(pairingExpiry(material.expiresAt, now)).toMatchObject({ expired: false, secondsRemaining: 60, label: "01:00" });
    expect(pairingExpiry(material.expiresAt, now + 60_000)).toMatchObject({ expired: true, secondsRemaining: 0, label: "00:00" });
    expect(pairingExpiry(material.expiresAt, now + 61_000).expired).toBe(true);
    expect(redactExpiredPairing(material, now + 60_000)).toBeUndefined();
    expect(redactExpiredPairing(material, now + 59_000)).toEqual(material);
  });

  it("creates the exact pairing payload consumed by LemonPi Go", () => {
    expect(JSON.parse(pairingPayload(material))).toEqual({
      version: 1,
      host: "macbook.local",
      port: 8787,
      hostId: "host-identifier",
      code: "123456",
      certificatePin: "pin",
    });
    expect(pairingPayload(material)).not.toContain("expiresAt");
  });

  it("offers only addresses permitted by the selected network mode", () => {
    const candidates = [
      { host: "100.76.239.128", network: "tailscale" as const, interfaceName: "utun7" },
      { host: "192.168.1.20", network: "lan" as const, interfaceName: "en0" },
    ];
    expect(compatiblePairingHosts(candidates, "lanAndTailscale")).toEqual(candidates);
    expect(compatiblePairingHosts(candidates, "tailscaleOnly")).toEqual([candidates[0]]);
    expect(compatiblePairingHosts(candidates, "lanOnly")).toEqual([candidates[1]]);
    expect(pairingHostLabel(candidates[0])).toBe("100.76.239.128 — Tailscale (utun7)");
  });

  it("ignores stale and disposed async responses", () => {
    const first = beginRemoteRequest(initialRemoteUiState);
    const second = beginRemoteRequest(first);
    expect(applyRemoteResponse(second, first.requestGeneration, { status: running })).toBe(second);
    const applied = applyRemoteResponse(second, second.requestGeneration, { status: running });
    expect(applied.status).toEqual(running);
    const disposed = disposeRemoteUi(applied);
    expect(applyRemoteResponse(disposed, disposed.requestGeneration, { config })).toBe(disposed);
  });

  it("clears pairing after listener configuration changes and refreshes after either revoke result", () => {
    const withPairing = { ...initialRemoteUiState, pairing: material };
    expect(applyRemoteConfiguration(withPairing, { ...config, enabled: false }, { ...running, enabled: false, running: false }).pairing).toBeUndefined();
    expect(clearRemotePairing(withPairing).pairing).toBeUndefined();
    expect(shouldRefreshDevicesAfterRevoke(true)).toBe(true);
    expect(shouldRefreshDevicesAfterRevoke(false)).toBe(true);
    expect(staleDeviceNotice(true)).toBeUndefined();
    expect(staleDeviceNotice(false)).toMatch(/already removed/);
  });

  it("derives disabled, unavailable, running, and error-adjacent status presentation", () => {
    expect(describeRemoteStatus({ ...running, enabled: false, running: false })).toMatchObject({ label: "Disabled", tone: "neutral" });
    expect(describeRemoteStatus({ ...running, running: false })).toMatchObject({ label: "Starting or unavailable", tone: "warning" });
    expect(describeRemoteStatus(running)).toMatchObject({ label: "Running", tone: "success" });
    expect(describeRemoteStatus({ ...running, lastError: "listener unavailable" }).label).toBe("Running");
  });
});

describe("remote command client", () => {
  it("uses the seven registered command names and camel-case payloads", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createRemoteClient(async (command, args) => {
      calls.push({ command, args });
      if (command === "revoke_remote_device") return true as never;
      if (command === "list_remote_devices") return [] as never;
      if (command === "get_remote_config") return config as never;
      if (command === "set_remote_config" || command === "get_remote_status") return running as never;
      if (command === "get_remote_pairing_hosts") return [] as never;
      if (command === "start_remote_pairing") return material as never;
      return undefined as never;
    });

    await client.getRemoteConfig();
    await client.setRemoteConfig(config);
    await client.getRemotePairingHosts();
    await client.startRemotePairing("macbook.local");
    await client.cancelRemotePairing();
    await client.listRemoteDevices();
    await client.revokeRemoteDevice("device-id");
    await client.getRemoteStatus();

    expect(calls).toEqual([
      { command: "get_remote_config" },
      { command: "set_remote_config", args: { config } },
      { command: "get_remote_pairing_hosts" },
      { command: "start_remote_pairing", args: { host: "macbook.local" } },
      { command: "cancel_remote_pairing" },
      { command: "list_remote_devices" },
      { command: "revoke_remote_device", args: { deviceId: "device-id" } },
      { command: "get_remote_status" },
    ]);
  });
});
