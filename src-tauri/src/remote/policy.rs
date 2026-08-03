use super::config::AccessMode;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The only peer categories the v1 remote bridge will need to distinguish.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PeerKind {
    Loopback,
    Lan,
    Tailscale,
    Public,
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
