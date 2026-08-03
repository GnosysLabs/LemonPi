# LemonPi Remote Protocol v1

This document is the normative wire contract for LemonPi Go and the opt-in LemonPi desktop remote bridge. It is deliberately limited to the first remote-session vertical slice. Unless a field is explicitly required below, implementations **must ignore** unknown JSON object members and unknown capability names.

## Scope and invariants

- Protocol version is the JSON integer `1`. It is carried in every HTTP response envelope, every `X-LemonPi-Protocol` response header, and the first WebSocket `hello` message.
- The bridge exposes one configured TLS port, defaulting to **8787**. All paths below are relative to `https://HOST:PORT`; the event stream is `wss://HOST:PORT/v1/events`.
- The host is authoritative for projects, project labels, project trust state, running-process state, sessions, timestamps, and Pi correlation IDs.
- `projectId` and `sessionId` are opaque host-issued identifiers. Clients must treat them as uninterpreted strings matching `[A-Za-z0-9_-]{1,128}`. They are never filesystem paths or encodings of paths.
- The API never accepts or returns filesystem paths, session-file paths, transcript paths, private keys, certificate private-key data, token digests, raw configuration paths, shell commands, package/settings mutation, or trust-escalation fields.
- JSON is UTF-8. JSON request bodies have `Content-Type: application/json`; a POST without that media type is rejected with `415 unsupported_content_type`. Successful JSON responses have `Content-Type: application/json; charset=utf-8`.
- Every HTTP request and WebSocket upgrade request must include `X-LemonPi-Protocol: 1` and `X-LemonPi-Request-Id: UUID`. UUIDs use the canonical RFC 4122 string form. Validation is ordered: the protocol header is checked first, then the request-ID header, then endpoint processing. A missing, malformed, or non-`1` protocol header is rejected with `426 unsupported_protocol_version`. When the protocol header is accepted, a missing or malformed request-ID header is rejected with `400 malformed_request`.
- Unknown JSON fields are ignored. Known fields with an invalid type, invalid value, or invalid required-field absence produce `400 malformed_request`.
- The server supports at most 16 paired devices and 8 simultaneous authenticated event sockets.

## TLS, discovery, and pairing material

The desktop bridge uses a persistent self-signed TLS leaf certificate. The QR/manual pairing payload is UTF-8 JSON with this exact shape:

```json
{
  "version": 1,
  "host": "lemonpi-mac.tailnet-name.ts.net",
  "port": 8787,
  "hostId": "7c9b9c14-e910-4be7-8878-5d3ed02b2f02",
  "code": "7K3M9PQR",
  "certificatePin": "Yk_7boF_RLM-yPPQDeVgqK0Lw9geAbdwPXpf_XRXKtY"
}
```

`host` is a single LAN address, Tailscale address, or hostname with no scheme, slash, query, fragment, or port. `port` is the desktop listener's configured port from `1` through `65535` (default `8787`). `hostId` is a persistent host UUID. `code` is the exact eight-character, uppercase Crockford Base32 pairing code shown by the desktop host. `certificatePin` is the unpadded base64url encoding of the SHA-256 digest of the DER bytes of the TLS leaf certificate (32 digest bytes, therefore 43 encoded characters).

The client must verify that the TLS leaf certificate hashes to the pairing or previously stored pin. A pin mismatch is a hard connection failure; clients must not silently fall back to ordinary system trust, accept a new certificate, or use trust-on-first-use. The pairing payload can be carried as a QR code or copied/manual-entered as the same JSON object.

A pairing window lasts five minutes from issuance, permits five failed code attempts total, and is single-use after a successful pair. Once expired or attempt-limited, it is closed. Pairing is available only while the host has explicitly enabled remote access.

## Version and capability negotiation

Clients send the protocol header above and may send this optional request header:

```text
X-LemonPi-Capabilities: projects,state,rpc,events
```

Header values are a comma-separated list of case-sensitive capability tokens. The v1 tokens are `projects`, `state`, `rpc`, and `events`. The host ignores unknown requested tokens. Every successful HTTP JSON response with a `data` envelope **must** include `data.acceptedCapabilities`. Its value is always the full intersection of the request’s requested tokens and the host’s currently supported v1 tokens; it is never reduced to the capability of the endpoint that produced the response. When the request header is absent, `acceptedCapabilities` is all currently supported v1 tokens. WebSocket `hello` follows the same intersection rule. Capabilities are feature hints only: they neither grant authorization nor expand the RPC allowlist.

An endpoint unavailable because its capability is not supported returns `501 capability_unavailable`. A client that needs a newer wire version must not attempt a v1 downgrade automatically; it must surface `unsupported_protocol_version` clearly.

## HTTP envelope, errors, and authentication

Every HTTP response, including a rejected WebSocket upgrade, includes these headers:

```text
X-LemonPi-Protocol: 1
X-LemonPi-Request-Id: <effective response UUID>
```

The effective response UUID is the exact client `X-LemonPi-Request-Id` value when it is a valid canonical UUID. If that header is missing or malformed, the host creates a fresh UUID and uses it in both `X-LemonPi-Request-Id` and the JSON envelope’s `requestId`. Thus a request-ID failure is `400 malformed_request` with a server-generated response UUID. Protocol validation has precedence: if the protocol header and request-ID header are both invalid, the host returns `426 unsupported_protocol_version` and still uses a fresh server-generated UUID. The same effective response UUID rule applies to a successful `101 Switching Protocols` response; an invalid header produces a normal JSON HTTP error instead of an upgrade.

A successful JSON response uses this envelope:

```json
{
  "protocol": 1,
  "requestId": "UUID",
  "data": {
    "acceptedCapabilities": ["projects", "state", "rpc", "events"]
  }
}
```

An error JSON response uses this envelope:

```json
{
  "protocol": 1,
  "requestId": "UUID",
  "error": {
    "code": "machine_readable_code",
    "message": "safe user-facing explanation",
    "retryable": false
  }
}
```

`error.details` is optional and, when present, is a JSON object containing only safe field-validation information. Error responses never disclose whether a bearer token, opaque project/session ID, host path, or pairing code was close to valid.

All endpoints except `GET /v1/health` and `POST /v1/pair` require exactly one `Authorization: Bearer TOKEN` header. Tokens are opaque 32-random-byte values encoded as unpadded base64url. Missing, malformed, invalid, or revoked tokens all return `401 unauthenticated` with the same safe message. Tokens must not be sent in URLs, JSON bodies, logs, analytics, or WebSocket messages. iOS stores an issued token in the Keychain, using a device-only accessibility class; it is never stored in `UserDefaults`.

HTTP body limit is 2 MiB after transfer decoding. A larger body returns `413 payload_too_large`. Relevant status/code pairs are:

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `malformed_request` | Invalid required JSON field or value. |
| 400 | `unsupported_rpc_type` | RPC `type` is outside the v1 allowlist. |
| 401 | `unauthenticated` | Missing, malformed, invalid, or revoked bearer token. |
| 401 | `invalid_pairing_code` | Pairing code was incorrect; no remaining-attempt count is disclosed. |
| 403 | `peer_not_allowed` | Source peer is not permitted by the active LAN/Tailscale policy. |
| 404 | `project_not_found` / `session_not_found` | Opaque resource ID is not available to this host. |
| 409 | `device_limit_reached` | Host already has 16 paired devices. |
| 410 | `pairing_expired` | Pairing window is closed or expired. |
| 413 | `payload_too_large` | HTTP body exceeds 2 MiB. |
| 415 | `unsupported_content_type` | POST body is not JSON. |
| 426 | `unsupported_protocol_version` | Required protocol header was missing, malformed, or incompatible. |
| 429 | `pairing_attempts_exceeded` / `socket_limit_reached` | Pairing code has exhausted five failures, or all 8 sockets are in use. |
| 501 | `capability_unavailable` | Requested v1 endpoint is not supported by this host. |
| 503 | `host_unavailable` | The requested Pi/project process cannot currently serve the request. |

## HTTP endpoints

### `GET /v1/health` — unauthenticated host discovery

This endpoint is available only when remote access is enabled and the source peer satisfies the active policy. It returns the host identity and supported capability/limit summary, but never credentials or paths.

`data` shape:

```json
{
  "hostId": "UUID",
  "displayName": "LemonPi on Maya’s Mac",
  "port": 8787,
  "capabilities": ["projects", "state", "rpc", "events"],
  "acceptedCapabilities": ["projects", "state", "rpc", "events"],
  "limits": {
    "httpBodyBytes": 2097152,
    "eventEnvelopeBytes": 1048576,
    "devices": 16,
    "sockets": 8,
    "replayEvents": 4096,
    "broadcastQueue": 1024
  }
}
```

### `POST /v1/pair` — unauthenticated, pin-verified pairing

Request body:

```json
{
  "code": "7K3M9PQR",
  "deviceId": "82c6fbb6-fa93-4672-8b48-b7755a947e7d",
  "displayName": "Maya’s iPhone"
}
```

`deviceId` is a client-generated UUID. `displayName` is a trimmed, nonempty, human-readable string of at most 64 Unicode scalar values and must not contain control characters. The returned device record has the exact submitted `deviceId` as its `id`.

On success (`201 Created`), `data` contains:

```json
{
  "token": "one-time-plaintext-bearer-token",
  "device": {
    "id": "82c6fbb6-fa93-4672-8b48-b7755a947e7d",
    "displayName": "Maya’s iPhone",
    "pairedAt": "2026-08-03T01:15:00Z"
  },
  "acceptedCapabilities": ["projects", "state", "rpc", "events"]
}
```

`token` is exposed only in this success response. The host persists only its digest and can revoke the device/token later. Reusing a device ID is `409 device_id_already_paired`.

### `GET /v1/projects` — authenticated project catalogue

`data.projects` is an array of host-derived project summaries:

```json
{
  "projects": [
    {
      "projectId": "project_aJ8nQ2",
      "displayName": "LemonPi",
      "trustState": "trusted",
      "isActive": true
    }
  ],
  "acceptedCapabilities": ["projects", "state", "rpc", "events"]
}
```

`trustState` is one of `trusted` or `untrusted`; it is display-only host state and is not mutable through this protocol.

### `GET /v1/sessions?projectId=OPAQUE_ID` — authenticated session catalogue

`projectId` is required exactly once as a query value. Session discovery is included in the `projects` capability; it is unavailable with `501 capability_unavailable` when that capability is not supported. `data` shape:

```json
{
  "projectId": "project_aJ8nQ2",
  "sessions": [
    {
      "sessionId": "session_7sJ2q",
      "name": "Remote bridge",
      "modifiedAt": "2026-08-03T01:20:02.011Z",
      "messageCount": 12,
      "firstMessagePreview": "Summarize the current remote bridge work.",
      "lastFinalReplyAt": "2026-08-03T01:20:00.000Z"
    }
  ],
  "acceptedCapabilities": ["projects", "state", "rpc", "events"]
}
```

`name`, `firstMessagePreview`, and `lastFinalReplyAt` are omitted when unavailable. `firstMessagePreview` is a host-generated, plain-text preview of at most 280 Unicode scalar values; it is not a path, transcript record, or raw message. `modifiedAt` and `lastFinalReplyAt` are RFC 3339 UTC timestamps. `messageCount` is a nonnegative integer. The host returns no session-file, parent-session, transcript, or project-path metadata.

Clients obtain the opaque `sessionId` values used by `switch_session` and `GET /v1/messages` from this endpoint (or from the active-session snapshot/event). Clients must not derive or guess session IDs.

### `GET /v1/state?projectId=OPAQUE_ID` — authenticated state snapshot

`projectId` is required exactly once as a query value. `data` shape:

```json
{
  "project": {
    "projectId": "project_aJ8nQ2",
    "displayName": "LemonPi",
    "trustState": "trusted",
    "isActive": true
  },
  "state": {
    "sessionId": "session_7sJ2q",
    "sessionName": "Remote bridge",
    "isStreaming": false,
    "isCompacting": false,
    "thinkingLevel": "high",
    "messageCount": 12,
    "pendingMessageCount": 0
  },
  "acceptedCapabilities": ["projects", "state", "rpc", "events"]
}
```

`sessionId` and `sessionName` may be absent when no active session exists. The optional `GET /v1/messages?projectId=OPAQUE_ID&sessionId=OPAQUE_ID&limit=1..200` endpoint returns `data` with `projectId`, `sessionId`, and `messages`, where every message has this safe projection:

```json
{
  "messageId": "message_K5r2",
  "role": "assistant",
  "text": "plain transcript text",
  "thinking": "optional assistant thinking text",
  "isError": false,
  "timestamp": "2026-08-03T01:20:02.011Z"
}
```

`role` is exactly `user`, `assistant`, or `tool`. `thinking`, `toolName`, and `toolStatus` are omitted when inapplicable; `toolStatus`, when present, is exactly `queued`, `running`, `complete`, or `error`. `text` is always present and may be empty. Attachments, tool arguments, raw tool output, message details, and all paths are excluded from this v1 projection. This endpoint is intended for rehydration after a stream gap and never includes a transcript path.

### `POST /v1/rpc` — authenticated asynchronous Pi command

A client sends exactly one command request:

```json
{
  "projectId": "project_aJ8nQ2",
  "sessionId": "session_7sJ2q",
  "type": "get_state",
  "payload": {}
}
```

`sessionId` is required for session-scoped commands and omitted for `new_session`. Clients do **not** supply a Pi RPC `id`, `piId`, correlation ID, process ID, path, trust field, or any generic command field. Unknown request fields are ignored and never forwarded. The host validates the known payload, generates an internal Pi correlation ID, and maps that private ID to the HTTP request UUID plus a host-generated `operationId` UUID.

The exact v1 `type` allowlist is:

```text
prompt
steer
follow_up
abort
get_state
get_messages
get_session_stats
get_available_models
get_available_thinking_levels
new_session
switch_session
set_model
set_thinking_level
```

All other types return `400 unsupported_rpc_type`. Payload requirements are:

| Type | Required payload |
| --- | --- |
| `prompt`, `steer`, `follow_up` | `{ "text": string }`, 1–262144 UTF-8 bytes |
| `abort`, `get_state`, `get_messages`, `get_session_stats`, `get_available_models`, `get_available_thinking_levels`, `new_session` | `{}` |
| `switch_session` | `{ "sessionId": OPAQUE_ID }` |
| `set_model` | `{ "modelId": string }` |
| `set_thinking_level` | `{ "thinkingLevel": "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }` |

On valid submission, the host returns `202 Accepted` before a Pi result is known:

```json
{
  "protocol": 1,
  "requestId": "a5d4c182-b0d5-4e2a-89d9-8d2155356dd0",
  "data": {
    "operationId": "553a1595-bc99-4e2c-8fcc-826b803997fa",
    "projectId": "project_aJ8nQ2",
    "sessionId": "session_7sJ2q",
    "acceptedAt": "2026-08-03T01:20:00Z",
    "acceptedCapabilities": ["projects", "state", "rpc", "events"]
  }
}
```

When the corresponding Pi response arrives, it is emitted as a WebSocket `piEvent` with the same `operationId`. The private Pi correlation ID is removed before serialization.

## WebSocket event stream

Connect with an authenticated upgrade request:

```text
GET /v1/events?since=123 HTTP/1.1
Authorization: Bearer TOKEN
X-LemonPi-Protocol: 1
X-LemonPi-Request-Id: UUID
X-LemonPi-Capabilities: projects,state,rpc,events
```

`since` is optional, decimal, unsigned, and identifies the last fully processed global event sequence. A successful `101 Switching Protocols` response includes the standard protocol/request-ID headers. The client sends no application messages in v1; all commands use HTTP. The server may close malformed client application frames with WebSocket close code `1008`.

The first WebSocket message is always the control message below. It is not a replayable event and does not consume a global event sequence:

```json
{
  "type": "hello",
  "protocol": 1,
  "hostId": "UUID",
  "highWaterSeq": 123,
  "acceptedCapabilities": ["projects", "state", "rpc", "events"],
  "limits": {
    "eventEnvelopeBytes": 1048576,
    "replayEvents": 4096,
    "broadcastQueue": 1024
  }
}
```

Every message after `hello` is an event envelope:

```json
{
  "seq": 124,
  "timestamp": "2026-08-03T01:20:01.234Z",
  "kind": "piEvent",
  "projectId": "project_aJ8nQ2",
  "sessionId": "session_7sJ2q",
  "payload": {}
}
```

`seq` is the global, monotonic host event sequence, assigned once at publication. `timestamp` is an RFC 3339 UTC string with millisecond precision. `projectId` and `sessionId` are omitted when not applicable. Event kinds are:

- `piEvent`: `payload.event` is a safe, host-projected Pi event; raw Pi events are never passed through. Its exact object shape is one of the following:

  ```json
  { "type": "agent_start" }
  { "type": "agent_settled" }
  { "type": "message_start", "message": { "messageId": "message_K5r2", "role": "assistant", "text": "string", "timestamp": "2026-08-03T01:20:02.011Z" } }
  { "type": "message_end", "message": { "messageId": "message_K5r2", "role": "assistant", "text": "string", "timestamp": "2026-08-03T01:20:02.011Z" } }
  { "type": "message_delta", "target": "text", "text": "string" }
  { "type": "queue_update", "steeringCount": 0, "followUpCount": 0 }
  { "type": "response", "command": "V1_RPC_TYPE", "success": true, "data": {} }
  { "type": "response", "command": "V1_RPC_TYPE", "success": false, "error": "safe error text" }
  ```

  For `message_start` and `message_end`, the `message` member uses the safe message projection above and may include its optional safe members; its `role` is exactly `user`, `assistant`, or `tool`. For `message_delta`, `target` is exactly `text` or `thinking`. Response `command` is one of the v1 RPC types. Response `data` is a command-specific JSON value projected by the host; it must omit every prohibited value named in Scope and invariants. A response associated with a submitted remote RPC includes `payload.operationId`; Pi’s internal `id` is always omitted. Internal Pi event kinds outside this finite list are not transmitted in v1.
- `processEvent`: `payload.state` is `started`, `exited`, `stopped`, or `error`; `payload.exitCode` and `payload.message` are optional safe values. OS process IDs are not exposed.
- `gap`: the recipient missed one or more events. `payload` is `{ "fromSeq": integer, "toSeq": integer, "reason": "replay_evicted" | "client_lagged" }`. A gap is a newly allocated global event with a sequence greater than `toSeq`; clients must treat it as a recovery barrier rather than a domain event. Sequence values are globally increasing but are not required to be contiguous for every recipient because a gap can be recipient-specific.
- `truncated`: a source event exceeded the 1 MiB serialized-envelope bound. `payload` is `{ "originalKind": "piEvent" | "processEvent", "originalBytes": integer }`. The envelope is within 1 MiB and has the original event’s sequence. Clients should rehydrate relevant state/messages.

The host keeps the latest 4096 published events in a replay ring. After `hello`, a valid `since` is replayed in ascending sequence order when still retained. If the requested sequence predates the ring, the server sends one newly sequenced `gap` recovery barrier instead of partial replay; clients must fetch `/v1/projects`, `/v1/sessions`, `/v1/state`, and `/v1/messages` for active resources before treating the stream as current. Reconnect with the last fully processed event sequence, including a gap. On a per-socket outgoing backlog of 1024 events, the host discards that socket’s pending events and sends a newly sequenced `gap` with `reason: client_lagged`; it must not let a slow socket block the agent or other clients.

A serialized event envelope must not exceed 1 MiB (1,048,576 bytes). Oversized `piEvent` or `processEvent` payloads are replaced with `truncated`. The 4096-event ring and 1024-event queue count envelopes, not bytes.

## Security boundary and deferred scope

Remote access is off by default and must remain inactive until the desktop user explicitly enables it. When active, the bridge accepts only loopback, private LAN, link-local LAN, and Tailscale peers according to the selected LAN/Tailscale policy; public peers are always denied. Each device has an independently revocable bearer token, and TLS certificate pinning is mandatory.

There are intentionally no generic shell, filesystem, file-upload/download, settings, package-management, project-trust, or arbitrary Pi passthrough endpoints. This reduces exposure but does **not** make a paired device harmless: a valid token can submit a prompt to a code-executing agent. Treat the pairing code and bearer token like shell access, protect them from screenshots/logs, and revoke a device promptly if it is lost.

The following are deferred and have no v1 wire behavior: extension-dialog responses, subagent artifact browsing, package/settings mutation, push notifications, mDNS implementation, and headless/background host operation.

## Golden fixtures

The byte-identical JSON examples in `fixtures/protocol/v1/` are normative golden fixtures for this contract:

```text
health-response.json
pair-request.json
pair-success-response.json
pair-error-response.json
projects-response.json
sessions-response.json
state-response.json
rpc-request.json
rpc-accepted-response.json
rpc-correlated-success-event.json
rpc-error-response.json
ws-hello.json
event-pi.json
event-process.json
event-gap.json
event-truncated.json
```
