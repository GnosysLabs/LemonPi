//! Serde-only LemonPi Remote Protocol v1 projections.
//!
//! These wire DTOs intentionally contain no filesystem types. Endpoint code must build them from
//! the internal catalog and explicitly project Pi output before serialization.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub(crate) const PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope<T> {
    pub(crate) protocol: u8,
    pub(crate) request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ProtocolError>,
}

impl<T> Envelope<T> {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.protocol != PROTOCOL_VERSION {
            return Err("unsupported protocol version");
        }
        if Uuid::parse_str(&self.request_id).is_err() {
            return Err("invalid request ID");
        }
        if self.data.is_some() == self.error.is_some() {
            return Err("envelope requires exactly one data or error member");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<SafeObject>,
}

/// JSON objects made only from JSON primitives/arrays/objects. It is used for the finite v1
/// command-response payload fields, which remain separately allowlisted by endpoint code.
pub(crate) type SafeObject = std::collections::BTreeMap<String, Value>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Capability {
    Projects,
    State,
    Rpc,
    Events,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Limits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) http_body_bytes: Option<u64>,
    pub(crate) event_envelope_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) devices: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sockets: Option<u64>,
    pub(crate) replay_events: u64,
    pub(crate) broadcast_queue: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Health {
    pub(crate) host_id: String,
    pub(crate) display_name: String,
    pub(crate) port: u16,
    pub(crate) capabilities: Vec<Capability>,
    pub(crate) accepted_capabilities: Vec<Capability>,
    pub(crate) limits: Limits,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairRequest {
    pub(crate) code: String,
    pub(crate) device_id: String,
    pub(crate) display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairResponse {
    pub(crate) token: String,
    pub(crate) device: PairedDevice,
    pub(crate) accepted_capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairedDevice {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) paired_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSummary {
    pub(crate) project_id: String,
    pub(crate) display_name: String,
    pub(crate) display_path: String,
    pub(crate) trust_state: TrustState,
    pub(crate) is_active: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrustState {
    Trusted,
    Untrusted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectsResponse {
    pub(crate) projects: Vec<ProjectSummary>,
    pub(crate) accepted_capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    pub(crate) session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    pub(crate) modified_at: String,
    pub(crate) message_count: u64,
    pub(crate) first_message_preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_final_reply_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionsResponse {
    pub(crate) project_id: String,
    pub(crate) sessions: Vec<SessionSummary>,
    pub(crate) accepted_capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateResponse {
    pub(crate) project: ProjectSummary,
    pub(crate) state: SessionState,
    pub(crate) accepted_capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_name: Option<String>,
    pub(crate) is_streaming: bool,
    pub(crate) is_compacting: bool,
    pub(crate) thinking_level: String,
    pub(crate) message_count: u64,
    pub(crate) pending_message_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeMessage {
    pub(crate) message_id: String,
    pub(crate) role: String,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) is_error: Option<bool>,
    pub(crate) timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_status: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessagesResponse {
    pub(crate) project_id: String,
    pub(crate) session_id: String,
    pub(crate) messages: Vec<SafeMessage>,
    pub(crate) accepted_capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcRequest {
    pub(crate) project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_id: Option<String>,
    #[serde(rename = "type")]
    pub(crate) command_type: String,
    pub(crate) payload: SafeObject,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcAccepted {
    pub(crate) operation_id: String,
    pub(crate) project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_id: Option<String>,
    pub(crate) accepted_at: String,
    pub(crate) accepted_capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello {
    #[serde(rename = "type")]
    pub(crate) message_type: String,
    pub(crate) protocol: u8,
    pub(crate) host_id: String,
    pub(crate) high_water_seq: u64,
    pub(crate) accepted_capabilities: Vec<Capability>,
    pub(crate) limits: Limits,
}

impl Hello {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.message_type != "hello" || self.protocol != PROTOCOL_VERSION {
            Err("invalid hello")
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventEnvelope {
    pub(crate) seq: u64,
    pub(crate) timestamp: String,
    pub(crate) kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_id: Option<String>,
    pub(crate) payload: EventPayload,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EventKind {
    PiEvent,
    ProcessEvent,
    Gap,
    Truncated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) event: Option<ProjectedPiEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) from_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) to_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedPiEvent {
    #[serde(rename = "type")]
    pub(crate) event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<SafeMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) steering_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) follow_up_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn fixture(name: &str) -> Vec<u8> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        fs::read(root.join("fixtures/protocol/v1").join(name)).unwrap()
    }

    #[test]
    fn all_frozen_v1_fixtures_decode_through_strict_wire_dtos() {
        let health: Envelope<Health> =
            serde_json::from_slice(&fixture("health-response.json")).unwrap();
        health.validate().unwrap();
        let pair_request: PairRequest =
            serde_json::from_slice(&fixture("pair-request.json")).unwrap();
        assert_eq!(pair_request.code, "7K3M9PQR");
        let pair: Envelope<PairResponse> =
            serde_json::from_slice(&fixture("pair-success-response.json")).unwrap();
        pair.validate().unwrap();
        let pair_error: Envelope<PairResponse> =
            serde_json::from_slice(&fixture("pair-error-response.json")).unwrap();
        pair_error.validate().unwrap();
        let projects: Envelope<ProjectsResponse> =
            serde_json::from_slice(&fixture("projects-response.json")).unwrap();
        projects.validate().unwrap();
        assert_eq!(
            projects.data.as_ref().unwrap().projects[0].display_path,
            "~/Dev/LemonPi"
        );
        let sessions: Envelope<SessionsResponse> =
            serde_json::from_slice(&fixture("sessions-response.json")).unwrap();
        sessions.validate().unwrap();
        let state: Envelope<StateResponse> =
            serde_json::from_slice(&fixture("state-response.json")).unwrap();
        state.validate().unwrap();
        assert_eq!(
            state.data.as_ref().unwrap().project.display_path,
            "~/Dev/LemonPi"
        );
        let rpc: RpcRequest = serde_json::from_slice(&fixture("rpc-request.json")).unwrap();
        assert_eq!(rpc.command_type, "prompt");
        let accepted: Envelope<RpcAccepted> =
            serde_json::from_slice(&fixture("rpc-accepted-response.json")).unwrap();
        accepted.validate().unwrap();
        let rpc_error: Envelope<RpcAccepted> =
            serde_json::from_slice(&fixture("rpc-error-response.json")).unwrap();
        rpc_error.validate().unwrap();
        let hello: Hello = serde_json::from_slice(&fixture("ws-hello.json")).unwrap();
        hello.validate().unwrap();
        for name in [
            "rpc-correlated-success-event.json",
            "event-pi.json",
            "event-process.json",
            "event-gap.json",
            "event-truncated.json",
        ] {
            let _: EventEnvelope = serde_json::from_slice(&fixture(name)).unwrap();
        }
    }

    #[test]
    fn serialization_omits_absent_members_and_preserves_frozen_fixture_shapes() {
        let hello: Hello = serde_json::from_slice(&fixture("ws-hello.json")).unwrap();
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            serde_json::from_slice::<Value>(&fixture("ws-hello.json")).unwrap()
        );
        let process: EventEnvelope =
            serde_json::from_slice(&fixture("event-process.json")).unwrap();
        assert_eq!(
            serde_json::to_value(&process).unwrap(),
            serde_json::from_slice::<Value>(&fixture("event-process.json")).unwrap()
        );
        let pairing_error: Envelope<PairResponse> =
            serde_json::from_slice(&fixture("pair-error-response.json")).unwrap();
        assert_eq!(
            serde_json::to_value(&pairing_error).unwrap(),
            serde_json::from_slice::<Value>(&fixture("pair-error-response.json")).unwrap()
        );

        let session = SessionSummary {
            session_id: "session_1".into(),
            name: None,
            modified_at: "2026-08-03T01:20:02.011Z".into(),
            message_count: 1,
            first_message_preview: "First".into(),
            last_final_reply_at: None,
        };
        let state = SessionState {
            session_id: None,
            session_name: None,
            is_streaming: false,
            is_compacting: false,
            thinking_level: "high".into(),
            message_count: 0,
            pending_message_count: 0,
        };
        let message = SafeMessage {
            message_id: "message_1".into(),
            role: "assistant".into(),
            text: "Safe text".into(),
            thinking: None,
            is_error: None,
            timestamp: "2026-08-03T01:20:02.011Z".into(),
            tool_name: None,
            tool_status: None,
        };
        let event = EventEnvelope {
            seq: 1,
            timestamp: "2026-08-03T01:20:02.011Z".into(),
            kind: EventKind::PiEvent,
            project_id: None,
            session_id: None,
            payload: EventPayload {
                operation_id: None,
                event: Some(ProjectedPiEvent {
                    event_type: "agent_start".into(),
                    message: None,
                    target: None,
                    text: None,
                    steering_count: None,
                    follow_up_count: None,
                    command: None,
                    success: None,
                    data: None,
                    error: None,
                }),
                state: None,
                exit_code: None,
                message: None,
                from_seq: None,
                to_seq: None,
                reason: None,
                original_kind: None,
                original_bytes: None,
            },
        };
        let rpc = RpcRequest {
            project_id: "project_1".into(),
            session_id: None,
            command_type: "new_session".into(),
            payload: SafeObject::new(),
        };
        for value in [
            serde_json::to_value(session).unwrap(),
            serde_json::to_value(state).unwrap(),
            serde_json::to_value(message).unwrap(),
            serde_json::to_value(&event).unwrap(),
            serde_json::to_value(rpc).unwrap(),
        ] {
            assert!(!value.to_string().contains(":null"), "{value}");
        }
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "seq": 1,
                "timestamp": "2026-08-03T01:20:02.011Z",
                "kind": "piEvent",
                "payload": { "event": { "type": "agent_start" } },
            })
        );
    }

    #[test]
    fn protocol_version_and_envelope_shape_are_enforced() {
        let invalid: Envelope<Health> = serde_json::from_str(
            r#"{"protocol":2,"requestId":"31bea560-0c45-4c6f-92e1-bd371ac52cb4","data":null}"#,
        )
        .unwrap();
        assert_eq!(invalid.validate(), Err("unsupported protocol version"));
        let ambiguous: Envelope<Health> = serde_json::from_str(r#"{"protocol":1,"requestId":"31bea560-0c45-4c6f-92e1-bd371ac52cb4","data":null,"error":null}"#).unwrap();
        assert_eq!(
            ambiguous.validate(),
            Err("envelope requires exactly one data or error member")
        );
    }
}
