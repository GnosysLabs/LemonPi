use super::config::AccessMode;
use if_addrs::get_if_addrs;
use serde::Serialize;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The only peer categories the v1 remote bridge will need to distinguish.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PeerKind {
    Loopback,
    Lan,
    Tailscale,
    Public,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PairingHostNetwork {
    Tailscale,
    Lan,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingHostCandidate {
    pub(crate) host: String,
    pub(crate) network: PairingHostNetwork,
    pub(crate) interface_name: String,
}

fn pairing_host_candidate(
    interface_name: String,
    address: IpAddr,
    is_operational: bool,
    is_link_local: bool,
) -> Option<PairingHostCandidate> {
    // The v1 listener binds IPv4. Advertising an IPv6 address would create a QR that this
    // process cannot answer even though the OS reports the interface as reachable.
    if !is_operational || is_link_local || !address.is_ipv4() {
        return None;
    }
    let network = match classify_peer(address) {
        PeerKind::Tailscale => PairingHostNetwork::Tailscale,
        PeerKind::Lan => PairingHostNetwork::Lan,
        PeerKind::Loopback | PeerKind::Public => return None,
    };
    Some(PairingHostCandidate {
        host: address.to_string(),
        network,
        interface_name,
    })
}

/// Returns only addresses this IPv4 listener can actually answer. Tailscale is sorted first so
/// the common remote-device path is the default instead of an arbitrary VM or LAN interface.
pub(crate) fn pairing_host_candidates() -> std::io::Result<Vec<PairingHostCandidate>> {
    let mut candidates = get_if_addrs()?
        .into_iter()
        .filter_map(|interface| {
            let address = interface.ip();
            let is_operational = interface.is_oper_up();
            let is_link_local = interface.is_link_local();
            pairing_host_candidate(interface.name, address, is_operational, is_link_local)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let priority = |network: PairingHostNetwork| match network {
            PairingHostNetwork::Tailscale => 0,
            PairingHostNetwork::Lan => 1,
        };
        priority(left.network)
            .cmp(&priority(right.network))
            .then_with(|| left.interface_name.cmp(&right.interface_name))
            .then_with(|| left.host.cmp(&right.host))
    });
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.host.clone()));
    Ok(candidates)
}

pub(crate) fn classify_peer(address: IpAddr) -> PeerKind {
    match address {
        IpAddr::V4(address) => classify_ipv4(address),
        IpAddr::V6(address) => classify_ipv6(address),
    }
}

fn classify_ipv4(address: Ipv4Addr) -> PeerKind {
    if address.is_loopback() {
        PeerKind::Loopback
    } else if is_tailscale_ipv4(address) {
        PeerKind::Tailscale
    } else if address.is_private() || address.is_link_local() {
        PeerKind::Lan
    } else {
        PeerKind::Public
    }
}

fn classify_ipv6(address: Ipv6Addr) -> PeerKind {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return classify_ipv4(mapped);
    }
    if address.is_loopback() {
        PeerKind::Loopback
    } else if is_tailscale_ipv6(address) {
        PeerKind::Tailscale
    } else if address.is_unique_local() || address.is_unicast_link_local() {
        PeerKind::Lan
    } else {
        PeerKind::Public
    }
}

fn is_tailscale_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_tailscale_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

/// Public peers are denied in every v1 access mode. Loopback remains available to the local host
/// regardless of the remote LAN/Tailscale policy.
pub(crate) fn allows_peer(mode: AccessMode, address: IpAddr) -> bool {
    match (mode, classify_peer(address)) {
        (_, PeerKind::Public) => false,
        (_, PeerKind::Loopback) => true,
        (AccessMode::LanAndTailscale, PeerKind::Lan | PeerKind::Tailscale) => true,
        (AccessMode::LanOnly, PeerKind::Lan) => true,
        (AccessMode::TailscaleOnly, PeerKind::Tailscale) => true,
        _ => false,
    }
}

const V1_REMOTE_RPC_TYPES: &[&str] = &[
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "get_state",
    "get_messages",
    "get_session_stats",
    "get_available_models",
    "get_available_thinking_levels",
    "new_session",
    "switch_session",
    "set_model",
    "set_thinking_level",
];

/// Rejects any RPC type outside the deliberately small v1 remote control surface.
pub(crate) fn validate_remote_rpc_type(command_type: &str) -> Result<(), RemoteRpcPolicyError> {
    V1_REMOTE_RPC_TYPES
        .contains(&command_type)
        .then_some(())
        .ok_or(RemoteRpcPolicyError::UnsupportedRpcType)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoteRpcPolicyError {
    UnsupportedRpcType,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_loopback_lan_tailscale_and_public_peers() {
        let cases = [
            ("127.0.0.1", PeerKind::Loopback),
            ("::1", PeerKind::Loopback),
            ("192.168.1.10", PeerKind::Lan),
            ("10.0.0.1", PeerKind::Lan),
            ("172.16.0.1", PeerKind::Lan),
            ("169.254.1.1", PeerKind::Lan),
            ("fc00::1", PeerKind::Lan),
            ("fe80::1", PeerKind::Lan),
            ("100.64.0.1", PeerKind::Tailscale),
            ("100.127.255.254", PeerKind::Tailscale),
            ("fd7a:115c:a1e0::1", PeerKind::Tailscale),
            ("8.8.8.8", PeerKind::Public),
            ("2001:4860:4860::8888", PeerKind::Public),
        ];

        for (address, expected) in cases {
            assert_eq!(
                classify_peer(address.parse().unwrap()),
                expected,
                "{address}"
            );
        }
        assert_eq!(
            classify_peer("100.63.255.255".parse().unwrap()),
            PeerKind::Public
        );
        assert_eq!(
            classify_peer("100.128.0.0".parse().unwrap()),
            PeerKind::Public
        );
        assert_eq!(
            classify_peer("fd7a:115c:a1e1::1".parse().unwrap()),
            PeerKind::Lan
        );
    }

    #[test]
    fn access_modes_allow_only_their_intended_private_networks() {
        let loopback = "127.0.0.1".parse().unwrap();
        let lan = "192.168.1.10".parse().unwrap();
        let tailscale = "100.64.0.1".parse().unwrap();
        let public = "8.8.8.8".parse().unwrap();

        assert!(allows_peer(AccessMode::LanAndTailscale, loopback));
        assert!(allows_peer(AccessMode::LanAndTailscale, lan));
        assert!(allows_peer(AccessMode::LanAndTailscale, tailscale));
        assert!(!allows_peer(AccessMode::LanAndTailscale, public));

        assert!(allows_peer(AccessMode::LanOnly, loopback));
        assert!(allows_peer(AccessMode::LanOnly, lan));
        assert!(!allows_peer(AccessMode::LanOnly, tailscale));
        assert!(!allows_peer(AccessMode::LanOnly, public));

        assert!(allows_peer(AccessMode::TailscaleOnly, loopback));
        assert!(!allows_peer(AccessMode::TailscaleOnly, lan));
        assert!(allows_peer(AccessMode::TailscaleOnly, tailscale));
        assert!(!allows_peer(AccessMode::TailscaleOnly, public));
    }

    #[test]
    fn pairing_candidates_only_advertise_reachable_ipv4_listener_addresses() {
        let tailscale = pairing_host_candidate(
            "tailscale0".into(),
            "100.76.239.128".parse().unwrap(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(tailscale.network, PairingHostNetwork::Tailscale);
        assert_eq!(tailscale.host, "100.76.239.128");

        let lan =
            pairing_host_candidate("en0".into(), "192.168.1.10".parse().unwrap(), true, false)
                .unwrap();
        assert_eq!(lan.network, PairingHostNetwork::Lan);

        assert!(
            pairing_host_candidate("lo0".into(), "127.0.0.1".parse().unwrap(), true, false)
                .is_none()
        );
        assert!(
            pairing_host_candidate("en0".into(), "169.254.1.1".parse().unwrap(), true, true)
                .is_none()
        );
        assert!(pairing_host_candidate(
            "utun7".into(),
            "fd7a:115c:a1e0::1".parse().unwrap(),
            true,
            false
        )
        .is_none());
        assert!(pairing_host_candidate(
            "en0".into(),
            "192.168.1.10".parse().unwrap(),
            false,
            false
        )
        .is_none());
    }

    #[test]
    fn rpc_allowlist_accepts_only_the_exact_v1_remote_surface() {
        for rpc_type in V1_REMOTE_RPC_TYPES {
            assert_eq!(validate_remote_rpc_type(rpc_type), Ok(()));
        }

        for rejected in [
            "",
            "stop_pi",
            "get_pi_settings",
            "shell",
            "read_file",
            "Prompt",
        ] {
            assert_eq!(
                validate_remote_rpc_type(rejected),
                Err(RemoteRpcPolicyError::UnsupportedRpcType),
                "{rejected} must not be remotely callable"
            );
        }
    }
}
