//! Transport-neutral event collection for a future LemonPi remote bridge.
//!
//! This module owns no network listener. It retains process-local events and exposes Tokio's
//! bounded broadcast primitive; a later transport layer can subscribe and project these internal
//! envelopes into the safe wire protocol.

use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

pub(crate) const EVENT_BROADCAST_CAPACITY: usize = 1024;
pub(crate) const EVENT_REPLAY_CAPACITY: usize = 4096;
pub(crate) const MAX_INTERNAL_EVENT_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Internal event kinds. These are deliberately not wire types or serializers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EventKind {
    PiEvent,
    ProcessEvent,
    Gap,
    Truncated,
}

impl EventKind {
    fn marker_name(self) -> &'static str {
        match self {
            Self::PiEvent => "piEvent",
            Self::ProcessEvent => "processEvent",
            Self::Gap => "gap",
            Self::Truncated => "truncated",
        }
    }
}

/// A process-local event envelope.
///
/// `project` remains a canonical filesystem path solely for desktop-internal routing. This type
/// intentionally has no serializer so an eventual wire layer must make an explicit safe
/// projection instead of accidentally exposing local paths.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EventEnvelope {
    pub(crate) seq: u64,
    pub(crate) project: Option<PathBuf>,
    pub(crate) kind: EventKind,
    pub(crate) payload: Value,
}

#[derive(Default)]
struct EventHubState {
    next_seq: u64,
    replay: VecDeque<EventEnvelope>,
}

/// Bounded event publication, replay, and fan-out for an eventual opt-in remote bridge.
///
/// Publication never waits for receivers. Slow subscribers receive Tokio's normal `Lagged`
/// result and cannot block Pi's stdout/process supervision path.
#[derive(Clone)]
pub(crate) struct EventHub {
    state: Arc<Mutex<EventHubState>>,
    sender: broadcast::Sender<EventEnvelope>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl EventHub {
    pub(crate) fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        Self {
            state: Arc::new(Mutex::new(EventHubState::default())),
            sender,
        }
    }

    /// Publishes one bounded internal event and returns the stored envelope.
    pub(crate) fn publish(
        &self,
        project: Option<PathBuf>,
        kind: EventKind,
        payload: Value,
    ) -> EventEnvelope {
        let (kind, payload) = bounded_payload(kind, payload);
        self.append(project, kind, payload)
    }

    /// Starts receiving future events. Replay is requested separately so a transport can send its
    /// initial control message before replaying retained envelopes.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.sender.subscribe()
    }

    /// Returns retained events after `since` in sequence order. If the requested point was evicted,
    /// returns one fresh recipient-local gap barrier instead of a misleading partial replay.
    pub(crate) fn replay_since(&self, since: u64) -> Vec<EventEnvelope> {
        let mut state = self.state.lock().expect("event hub state lock poisoned");
        let high_water = state.next_seq;
        let Some(oldest) = state.replay.front().map(|event| event.seq) else {
            return Vec::new();
        };

        if since < oldest.saturating_sub(1) {
            return vec![allocate_locked(
                &mut state,
                None,
                EventKind::Gap,
                json!({
                    "fromSeq": since.saturating_add(1),
                    "toSeq": high_water,
                    "reason": "replay_evicted",
                }),
            )];
        }

        state
            .replay
            .iter()
            .filter(|event| event.seq > since)
            .cloned()
            .collect()
    }

    pub(crate) fn high_water_seq(&self) -> u64 {
        self.state
            .lock()
            .expect("event hub state lock poisoned")
            .next_seq
    }

    fn append(&self, project: Option<PathBuf>, kind: EventKind, payload: Value) -> EventEnvelope {
        let event = {
            let mut state = self.state.lock().expect("event hub state lock poisoned");
            append_locked(&mut state, project, kind, payload)
        };
        let _ = self.sender.send(event.clone());
        event
    }
}

fn bounded_payload(kind: EventKind, payload: Value) -> (EventKind, Value) {
    let original_bytes = serde_json::to_vec(&payload)
        .expect("serde_json::Value must serialize")
        .len();
    if original_bytes <= MAX_INTERNAL_EVENT_PAYLOAD_BYTES {
        (kind, payload)
    } else {
        (
            EventKind::Truncated,
            json!({
                "originalKind": kind.marker_name(),
                "originalBytes": original_bytes,
            }),
        )
    }
}

fn allocate_locked(
    state: &mut EventHubState,
    project: Option<PathBuf>,
    kind: EventKind,
    payload: Value,
) -> EventEnvelope {
    state.next_seq = state
        .next_seq
        .checked_add(1)
        .expect("event hub sequence exhausted");
    EventEnvelope {
        seq: state.next_seq,
        project,
        kind,
        payload,
    }
}

fn append_locked(
    state: &mut EventHubState,
    project: Option<PathBuf>,
    kind: EventKind,
    payload: Value,
) -> EventEnvelope {
    let event = allocate_locked(state, project, kind, payload);
    state.replay.push_back(event.clone());
    if state.replay.len() > EVENT_REPLAY_CAPACITY {
        state.replay.pop_front();
    }
    event
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast::error::TryRecvError;

    #[test]
    fn publication_assigns_global_monotonic_sequences() {
        let hub = EventHub::new();
        let first = hub.publish(None, EventKind::PiEvent, json!({ "type": "agent_start" }));
        let second = hub.publish(
            Some(PathBuf::from("/canonical/project")),
            EventKind::ProcessEvent,
            json!({ "state": "started" }),
        );

        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        assert_eq!(hub.high_water_seq(), 2);
        assert_eq!(second.project, Some(PathBuf::from("/canonical/project")));
    }

    #[test]
    fn replay_returns_retained_events_in_sequence_order() {
        let hub = EventHub::new();
        for number in 1..=3 {
            hub.publish(None, EventKind::PiEvent, json!({ "number": number }));
        }

        let replay = hub.replay_since(1);
        assert_eq!(
            replay.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(replay[0].payload, json!({ "number": 2 }));
        assert_eq!(replay[1].payload, json!({ "number": 3 }));
    }

    #[test]
    fn evicted_replay_returns_a_fresh_gap_barrier_instead_of_partial_history() {
        let hub = EventHub::new();
        for number in 1..=(EVENT_REPLAY_CAPACITY as u64 + 1) {
            hub.publish(None, EventKind::PiEvent, json!({ "number": number }));
        }

        let mut unaffected_subscriber = hub.subscribe();
        let replay = hub.replay_since(0);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].kind, EventKind::Gap);
        assert_eq!(replay[0].seq, EVENT_REPLAY_CAPACITY as u64 + 2);
        assert_eq!(
            replay[0].payload,
            json!({
                "fromSeq": 1,
                "toSeq": EVENT_REPLAY_CAPACITY as u64 + 1,
                "reason": "replay_evicted",
            })
        );
        assert_eq!(hub.high_water_seq(), replay[0].seq);
        assert!(matches!(
            unaffected_subscriber.try_recv(),
            Err(TryRecvError::Empty)
        ));
        assert!(hub.replay_since(replay[0].seq).is_empty());
    }

    #[test]
    fn slow_broadcast_receivers_lag_without_blocking_publication() {
        let hub = EventHub::new();
        let mut receiver = hub.subscribe();
        for number in 0..=EVENT_BROADCAST_CAPACITY {
            hub.publish(None, EventKind::PiEvent, json!({ "number": number }));
        }

        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Lagged(1))));
    }

    #[test]
    fn oversized_payloads_are_replaced_with_a_small_truncated_marker() {
        let hub = EventHub::new();
        let event = hub.publish(
            None,
            EventKind::ProcessEvent,
            json!({ "message": "x".repeat(MAX_INTERNAL_EVENT_PAYLOAD_BYTES) }),
        );

        assert_eq!(event.kind, EventKind::Truncated);
        assert_eq!(event.payload["originalKind"], "processEvent");
        assert!(
            event.payload["originalBytes"].as_u64().unwrap() as usize
                > MAX_INTERNAL_EVENT_PAYLOAD_BYTES
        );
        assert!(
            serde_json::to_vec(&event.payload).unwrap().len() < MAX_INTERNAL_EVENT_PAYLOAD_BYTES
        );
    }
}
