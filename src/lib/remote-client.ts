import { invoke } from "@tauri-apps/api/core";

/** The network exposure selected for the machine-local remote listener. */
export type RemoteAccessMode = "lanAndTailscale" | "lanOnly" | "tailscaleOnly";

export interface RemoteConfig {
  version: number;
  enabled: boolean;
  port: number;
  accessMode: RemoteAccessMode;
}

/** Safe listener state. Pairing secrets are intentionally absent from this response. */
export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  accessMode: RemoteAccessMode;
  hostId: string;
  pairingActive: boolean;
  lastError?: string;
}

/** Short-lived material intended only for the currently visible pairing screen. */
export interface PairingMaterial {
  version: number;
  host: string;
  port: number;
  hostId: string;
  code: string;
  certificatePin: string;
  expiresAt: string;
}

export interface RemoteDevice {
  id: string;
  displayName: string;
  pairedAt: string;
}

export type RemoteInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface RemoteClient {
  getRemoteConfig(): Promise<RemoteConfig>;
  setRemoteConfig(config: RemoteConfig): Promise<RemoteStatus>;
  startRemotePairing(host: string): Promise<PairingMaterial>;
  cancelRemotePairing(): Promise<void>;
  listRemoteDevices(): Promise<RemoteDevice[]>;
  revokeRemoteDevice(deviceId: string): Promise<boolean>;
  getRemoteStatus(): Promise<RemoteStatus>;
}

/**
 * Kept injectable so command payloads can be tested without mocking Tauri globals.
 * The default instance is the only transport used by the settings surface.
 */
export function createRemoteClient(invokeCommand: RemoteInvoke = invoke as RemoteInvoke): RemoteClient {
  return {
    getRemoteConfig: () => invokeCommand<RemoteConfig>("get_remote_config"),
    setRemoteConfig: (config) => invokeCommand<RemoteStatus>("set_remote_config", { config }),
    startRemotePairing: (host) => invokeCommand<PairingMaterial>("start_remote_pairing", { host }),
    cancelRemotePairing: () => invokeCommand<void>("cancel_remote_pairing"),
    listRemoteDevices: () => invokeCommand<RemoteDevice[]>("list_remote_devices"),
    revokeRemoteDevice: (deviceId) => invokeCommand<boolean>("revoke_remote_device", { deviceId }),
    getRemoteStatus: () => invokeCommand<RemoteStatus>("get_remote_status"),
  };
}

const client = createRemoteClient();

export const getRemoteConfig = client.getRemoteConfig;
export const setRemoteConfig = client.setRemoteConfig;
export const startRemotePairing = client.startRemotePairing;
export const cancelRemotePairing = client.cancelRemotePairing;
export const listRemoteDevices = client.listRemoteDevices;
export const revokeRemoteDevice = client.revokeRemoteDevice;
export const getRemoteStatus = client.getRemoteStatus;
