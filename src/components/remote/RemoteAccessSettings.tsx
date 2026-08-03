import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  cancelRemotePairing,
  getRemoteConfig,
  getRemotePairingHosts,
  getRemoteStatus,
  listRemoteDevices,
  revokeRemoteDevice,
  setRemoteConfig,
  startRemotePairing,
  type PairingMaterial,
  type PairingHostCandidate,
  type RemoteConfig,
  type RemoteDevice,
  type RemoteStatus,
} from "../../lib/remote-client";
import {
  ACCESS_MODE_LABELS,
  abbreviateHostId,
  completeRemoteConfig,
  compatiblePairingHosts,
  describeRemoteStatus,
  formatPairedAt,
  formatPairingExpiry,
  pairingExpiry,
  pairingHostError,
  pairingHostLabel,
  pairingPayload,
  redactExpiredPairing,
  staleDeviceNotice,
  type RemoteConfigDraft,
} from "../../lib/remote-access";
import "./remote-access.css";

const REMOTE_ACCESS_PORT = 8787;

interface RemoteAccessSettingsProps {
  onNotice: (message: string, tone?: "info" | "warning" | "error") => void;
}

const accessModes = (Object.keys(ACCESS_MODE_LABELS) as Array<keyof typeof ACCESS_MODE_LABELS>).map((value) => ({
  value,
  label: ACCESS_MODE_LABELS[value],
}));

function safeFailure(action: string): string {
  return `Couldn't ${action}. Please try again.`;
}

/** Machine-global listener controls. Pairing material exists only in this component's memory. */
export function RemoteAccessSettings({ onNotice }: RemoteAccessSettingsProps) {
  const [config, setConfig] = useState<RemoteConfig>();
  const [status, setStatus] = useState<RemoteStatus>();
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [draft, setDraft] = useState<RemoteConfigDraft>();
  const [pairing, setPairing] = useState<PairingMaterial>();
  const [pairingHosts, setPairingHosts] = useState<PairingHostCandidate[]>([]);
  const [pairingHost, setPairingHost] = useState("");
  const [pairingExpired, setPairingExpired] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState(false);
  const [deviceError, setDeviceError] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [hostError, setHostError] = useState<string>();
  const [configBusy, setConfigBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});
  const [confirmingDeviceId, setConfirmingDeviceId] = useState<string>();
  const [deviceMessage, setDeviceMessage] = useState<string>();
  const mountedRef = useRef(true);
  const requestGeneration = useRef(0);
  const applyButtonRef = useRef<HTMLButtonElement>(null);
  const pairingButtonRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const revokeButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const issueRequest = useCallback(() => {
    requestGeneration.current += 1;
    return requestGeneration.current;
  }, []);
  const isCurrent = useCallback((generation: number) => (
    mountedRef.current && generation === requestGeneration.current
  ), []);

  const loadInitial = useCallback(async () => {
    const generation = issueRequest();
    setInitialLoading(true);
    setInitialError(false);
    setCommandError(undefined);
    const [configResult, statusResult, devicesResult, pairingHostsResult] = await Promise.allSettled([
      getRemoteConfig(),
      getRemoteStatus(),
      listRemoteDevices(),
      getRemotePairingHosts(),
    ]);
    if (!isCurrent(generation)) return;

    if (configResult.status !== "fulfilled" || statusResult.status !== "fulfilled") {
      setInitialError(true);
      setInitialLoading(false);
      return;
    }

    setConfig(configResult.value);
    setStatus(statusResult.value);
    setDraft({
      enabled: configResult.value.enabled,
      port: REMOTE_ACCESS_PORT,
      accessMode: configResult.value.accessMode,
    });
    setPairing(undefined);
    setPairingExpired(false);
    if (devicesResult.status === "fulfilled") {
      setDevices(devicesResult.value);
      setDeviceError(false);
    } else {
      setDeviceError(true);
    }
    if (pairingHostsResult.status === "fulfilled") {
      const candidates = compatiblePairingHosts(pairingHostsResult.value, configResult.value.accessMode);
      setPairingHosts(pairingHostsResult.value);
      setPairingHost(candidates[0]?.host || "");
    } else {
      setPairingHosts([]);
    }
    setInitialLoading(false);
  }, [isCurrent, issueRequest]);

  const refreshDevices = useCallback(async (generation = issueRequest()) => {
    try {
      const nextDevices = await listRemoteDevices();
      if (!isCurrent(generation)) return false;
      setDevices(nextDevices);
      setDeviceError(false);
      return true;
    } catch {
      if (isCurrent(generation)) setDeviceError(true);
      return false;
    }
  }, [isCurrent, issueRequest]);

  useEffect(() => {
    mountedRef.current = true;
    void loadInitial();
    return () => {
      mountedRef.current = false;
      requestGeneration.current += 1;
    };
  }, [loadInitial]);

  useEffect(() => {
    if (!pairing) return;
    let lastStatusCheck = Date.now();
    const expireIfNeeded = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (pairingExpiry(pairing.expiresAt, currentTime).expired) {
        const generation = issueRequest();
        setPairing(undefined);
        setPairingExpired(true);
        void getRemoteStatus().then((nextStatus) => {
          if (!isCurrent(generation)) return;
          setStatus(nextStatus);
        }).catch(() => {
          if (isCurrent(generation)) setCommandError(safeFailure("refresh remote access status"));
        });
        return;
      }
      // Status has no event stream. While a secret is visible, periodically re-check that
      // the listener remains live so a stopped listener cannot leave a usable-looking code up.
      if (currentTime - lastStatusCheck < 5_000) return;
      lastStatusCheck = currentTime;
      const generation = issueRequest();
      void getRemoteStatus().then((nextStatus) => {
        if (!isCurrent(generation)) return;
        setStatus(nextStatus);
        if (!nextStatus.running) setPairing(undefined);
      }).catch(() => {
        if (isCurrent(generation)) setCommandError(safeFailure("refresh remote access status"));
      });
    };
    expireIfNeeded();
    const timer = window.setInterval(expireIfNeeded, 1_000);
    return () => window.clearInterval(timer);
  }, [isCurrent, issueRequest, pairing]);

  const persistConfig = async (nextDraft: RemoteConfigDraft) => {
    if (!config) return;
    const generation = issueRequest();
    const shouldCancelPairing = Boolean(pairing || status?.pairingActive);
    setConfigBusy(true);
    setCommandError(undefined);
    // Starting a configuration mutation is enough to make a displayed code unusable.
    setPairing(undefined);
    setPairingExpired(false);
    try {
      const nextConfig = completeRemoteConfig(config, { ...nextDraft, port: REMOTE_ACCESS_PORT });
      const nextStatus = await setRemoteConfig(nextConfig);
      if (!isCurrent(generation)) return;

      // Cancel the server-side window too, not just its display-only material.

      let currentStatus = nextStatus;
      if (shouldCancelPairing) {
        await cancelRemotePairing();
        if (!isCurrent(generation)) return;
        currentStatus = await getRemoteStatus();
        if (!isCurrent(generation)) return;
      }
      setConfig(nextConfig);
      setStatus(currentStatus);
      setDraft({ enabled: nextConfig.enabled, port: REMOTE_ACCESS_PORT, accessMode: nextConfig.accessMode });
      const availableHosts = compatiblePairingHosts(pairingHosts, nextConfig.accessMode);
      const selectedKnownHost = pairingHosts.some((candidate) => candidate.host === pairingHost);
      if (selectedKnownHost && !availableHosts.some((candidate) => candidate.host === pairingHost)) {
        setPairingHost(availableHosts[0]?.host ?? "");
      }
      onNotice(nextConfig.enabled ? "Remote access updated." : "Remote access disabled.");
    } catch {
      if (isCurrent(generation)) setCommandError(safeFailure("update remote access"));
    } finally {
      if (isCurrent(generation)) {
        setConfigBusy(false);
        applyButtonRef.current?.focus();
      }
    }
  };

  const toggleListener = (enabled: boolean) => {
    if (!draft) return;
    const nextDraft = { ...draft, enabled };
    setDraft(nextDraft);
    // Disabling is an immediate security action; enabling remains deliberate via Apply.
    if (!enabled) void persistConfig(nextDraft);
  };

  const beginPairing = async () => {
    if (!status?.running) return;
    const error = pairingHostError(pairingHost);
    if (error) {
      setHostError(error);
      pairingButtonRef.current?.focus();
      return;
    }
    const generation = issueRequest();
    setPairingBusy(true);
    setCommandError(undefined);
    setHostError(undefined);
    try {
      const material = await startRemotePairing(pairingHost.trim());
      if (!isCurrent(generation)) return;
      setPairing(material);
      setPairingExpired(false);
      setNow(Date.now());
      setStatus((current) => current ? { ...current, pairingActive: true } : current);
    } catch {
      if (isCurrent(generation)) setCommandError(safeFailure("start pairing"));
    } finally {
      if (isCurrent(generation)) {
        setPairingBusy(false);
        // A successful start replaces its trigger with the material actions.
        window.requestAnimationFrame(() => {
          if (!mountedRef.current) return;
          (copyButtonRef.current ?? pairingButtonRef.current)?.focus();
        });
      }
    }
  };

  const cancelPairing = async () => {
    const generation = issueRequest();
    // Redact before waiting for the command so cancellation never leaves a visible secret behind.
    setPairing(undefined);
    setPairingExpired(false);
    setPairingBusy(true);
    setCommandError(undefined);
    try {
      await cancelRemotePairing();
      const nextStatus = await getRemoteStatus();
      if (!isCurrent(generation)) return;
      setStatus(nextStatus);
      onNotice("Pairing canceled.");
    } catch {
      if (isCurrent(generation)) setCommandError(safeFailure("cancel pairing"));
    } finally {
      if (isCurrent(generation)) {
        setPairingBusy(false);
        // Cancellation returns to the form, so focus its next logical action.
        pairingButtonRef.current?.focus();
      }
    }
  };

  const copyPairingDetails = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairingPayload(pairing));
      if (mountedRef.current) onNotice("Pairing JSON copied.");
    } catch {
      if (mountedRef.current) setCommandError("Couldn't copy pairing JSON. Try again or scan the QR code instead.");
    }
  };

  const revokeDevice = async (device: RemoteDevice, initiator: HTMLButtonElement) => {
    const generation = issueRequest();
    setRevoking((current) => ({ ...current, [device.id]: true }));
    setDeviceMessage(undefined);
    setCommandError(undefined);
    try {
      const wasRevoked = await revokeRemoteDevice(device.id);
      const refreshed = await refreshDevices(generation);
      if (!isCurrent(generation)) return;
      setConfirmingDeviceId(undefined);
      if (!refreshed) {
        setDeviceMessage("The device was changed, but the list could not be refreshed. Try again.");
      } else {
        setDeviceMessage(staleDeviceNotice(wasRevoked) ?? `${device.displayName} was revoked.`);
      }
    } catch {
      if (isCurrent(generation)) setCommandError(safeFailure("revoke that device"));
    } finally {
      if (isCurrent(generation)) {
        setRevoking((current) => { const next = { ...current }; delete next[device.id]; return next; });
        window.requestAnimationFrame(() => {
          if (mountedRef.current) revokeButtonRefs.current[device.id]?.focus() ?? initiator.focus();
        });
      }
    }
  };

  const visiblePairing = useMemo(() => redactExpiredPairing(pairing, now), [now, pairing]);
  const visiblePairingPayload = useMemo(
    () => visiblePairing ? pairingPayload(visiblePairing) : undefined,
    [visiblePairing],
  );
  const statusPresentation = status ? describeRemoteStatus(status) : undefined;
  const availablePairingHosts = useMemo(
    () => status ? compatiblePairingHosts(pairingHosts, status.accessMode) : [],
    [pairingHosts, status],
  );
  const selectedPairingHost = pairingHosts.find((candidate) => candidate.host === pairingHost);
  const configChanged = Boolean(config && draft && (
    draft.enabled !== config.enabled
    || draft.accessMode !== config.accessMode
    || config.port !== REMOTE_ACCESS_PORT
  ));

  if (initialLoading) {
    return <div className="remote-access remote-access--loading" aria-label="Loading remote access settings"><i /><i /><i /></div>;
  }

  if (initialError || !config || !status || !draft) {
    return (
      <section className="remote-access__load-error" role="alert">
        <strong>Couldn't load Remote Access</strong>
        <span>Check that LemonPi is available, then try again.</span>
        <button type="button" onClick={() => void loadInitial()}>Retry</button>
      </section>
    );
  }

  return (
    <div className="remote-access">
      {commandError && <div className="remote-access__error" role="alert">{commandError}</div>}

      <section className="remote-access__panel" aria-labelledby="remote-listener-title">
        <div className="remote-access__panel-heading">
          <div>
            <h3 id="remote-listener-title">Remote access</h3>
            <p>Enable a TLS listener for paired devices on the networks you choose.</p>
          </div>
          {statusPresentation && <span className="remote-access__status" data-tone={statusPresentation.tone} role="status">{statusPresentation.label}</span>}
        </div>

        <label className="remote-access__switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={configBusy || pairingBusy}
            onChange={(event) => toggleListener(event.target.checked)}
            aria-describedby="remote-listener-description"
          />
          <span aria-hidden="true" />
          <span><strong>Allow remote access</strong><small id="remote-listener-description">Enabling opens a TLS listener on the selected networks.</small></span>
        </label>

        <div className="remote-access__connection-editor">
          <div className="remote-access__fields">
            <label>
              <span>Networks</span>
              <select
                value={draft.accessMode}
                disabled={configBusy || pairingBusy}
                onChange={(event) => setDraft({ ...draft, accessMode: event.target.value as RemoteConfigDraft["accessMode"] })}
              >
                {accessModes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}
              </select>
            </label>
            <label>
              <span className="remote-access__field-label">
                This Mac’s address
                <small>{selectedPairingHost?.network === "tailscale" ? "Tailscale" : selectedPairingHost ? "Local network" : "Custom"}</small>
              </span>
              <input
                list="remote-pairing-hosts"
                value={pairingHost}
                disabled={pairingBusy || configBusy}
                onChange={(event) => { setPairingHost(event.target.value); setHostError(undefined); }}
                placeholder="Tailscale or LAN address"
                aria-invalid={Boolean(hostError)}
              />
              <datalist id="remote-pairing-hosts">
                {availablePairingHosts.map((candidate) => (
                  <option key={`${candidate.interfaceName}-${candidate.host}`} value={candidate.host}>
                    {pairingHostLabel(candidate)}
                  </option>
                ))}
              </datalist>
            </label>
          </div>
          <div className="remote-access__actions remote-access__actions--config">
            <button
              ref={applyButtonRef}
              type="button"
              className="remote-access__primary remote-access__save"
              disabled={configBusy || pairingBusy || !configChanged}
              onClick={() => void persistConfig(draft)}
            >
              {configBusy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
        {hostError && <div className="remote-access__field-error remote-access__field-error--host" role="alert">{hostError}</div>}

        <dl className="remote-access__metadata">
          <div><dt>Listener</dt><dd>{statusPresentation?.detail}</dd></div>
          <div><dt>Networks</dt><dd>{ACCESS_MODE_LABELS[status.accessMode]}</dd></div>
          <div><dt>Host ID</dt><dd title={status.hostId}>{abbreviateHostId(status.hostId)}</dd></div>
        </dl>
        {status.lastError && <div className="remote-access__last-error" role="alert"><strong>Listener issue</strong><span>{status.lastError}</span></div>}
      </section>

      <section className="remote-access__panel" aria-labelledby="remote-pairing-title">
        <div className="remote-access__panel-heading">
          <div><h3 id="remote-pairing-title">Pair a device</h3><p>Generate a short-lived code for one device you trust.</p></div>
        </div>

        {!status.running && <div className="remote-access__muted" role="status">Start Remote Access before pairing a device.</div>}
        {status.running && visiblePairing && (
          <div className="remote-access__pairing-material">
            <div className="remote-access__pairing-hero">
              <div className="remote-access__qr">
                <QRCodeSVG
                  value={visiblePairingPayload ?? ""}
                  size={196}
                  level="M"
                  marginSize={4}
                  title="LemonPi pairing QR code"
                />
              </div>
              <div className="remote-access__code">
                <span>Scan with LemonPi Go</span>
                <strong>{visiblePairing.code}</strong>
                <small role="status">Pairing code · Expires in {pairingExpiry(visiblePairing.expiresAt, now).label}</small>
                <p>Open LemonPi Go on your iPhone and scan this code to connect securely.</p>
              </div>
            </div>
            <dl>
              <div><dt>Address</dt><dd>{visiblePairing.host}:{visiblePairing.port}</dd></div>
              <div><dt>Certificate pin</dt><dd className="remote-access__pin">{visiblePairing.certificatePin}</dd></div>
              <div><dt>Expires</dt><dd>{formatPairingExpiry(visiblePairing.expiresAt)}</dd></div>
            </dl>
            <div className="remote-access__actions">
              <button ref={copyButtonRef} type="button" onClick={() => void copyPairingDetails()}>Copy pairing JSON</button>
              <button type="button" disabled={pairingBusy} onClick={() => void cancelPairing()}>{pairingBusy ? "Canceling…" : "Cancel pairing"}</button>
            </div>
          </div>
        )}
        {status.running && !visiblePairing && (
          <div className="remote-access__pairing-form">
            {status.pairingActive && <div className="remote-access__recovery" role="status">A pairing window is already active, but its code cannot be redisplayed after reopening settings. Cancel it or start a new code.</div>}
            {pairingExpired && <div className="remote-access__recovery" role="status">Pairing expired. Start a new code when you are ready.</div>}
            <div className="remote-access__actions">
              <button ref={pairingButtonRef} className="remote-access__primary" type="button" disabled={pairingBusy || configBusy || !pairingHost.trim()} onClick={() => void beginPairing()}>
                {pairingBusy ? "Starting…" : "Start pairing"}
              </button>
              {status.pairingActive && <button type="button" disabled={pairingBusy} onClick={() => void cancelPairing()}>Cancel existing pairing</button>}
            </div>
          </div>
        )}
      </section>

      <section className="remote-access__panel" aria-labelledby="remote-devices-title">
        <div className="remote-access__panel-heading">
          <div><h3 id="remote-devices-title">Paired devices</h3><p>Revoke a device to remove its access immediately.</p></div>
          <button type="button" disabled={Boolean(Object.keys(revoking).length)} onClick={() => void refreshDevices()}>Refresh</button>
        </div>
        {deviceError && <div className="remote-access__device-error" role="alert">Couldn't refresh paired devices. <button type="button" onClick={() => void refreshDevices()}>Retry</button></div>}
        {deviceMessage && <div className="remote-access__device-message" role="status">{deviceMessage}</div>}
        {!devices.length && !deviceError && <div className="remote-access__empty" role="status">No paired devices.</div>}
        <div className="remote-access__devices">
          {devices.map((device) => {
            const busy = Boolean(revoking[device.id]);
            const confirming = confirmingDeviceId === device.id;
            return (
              <article className="remote-access__device" key={device.id}>
                <div><strong>{device.displayName}</strong><span>Paired {formatPairedAt(device.pairedAt)} · {abbreviateHostId(device.id)}</span></div>
                {!confirming && <button ref={(element) => { revokeButtonRefs.current[device.id] = element; }} type="button" disabled={busy} onClick={() => setConfirmingDeviceId(device.id)}>Revoke</button>}
                {confirming && (
                  <div className="remote-access__confirm" role="group" aria-label={`Confirm revoking ${device.displayName}`}>
                    <span>Revoke {device.displayName}?</span>
                    <button type="button" disabled={busy} onClick={() => setConfirmingDeviceId(undefined)}>Keep</button>
                    <button type="button" className="remote-access__danger" disabled={busy} onClick={(event) => void revokeDevice(device, event.currentTarget)}>{busy ? "Revoking…" : "Confirm revoke"}</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
