//! SSRF guard: `check_url` validates scheme/IP-literal hosts before sending, `GuardedResolver`
//! drops disallowed addresses for host names (also defeats DNS rebinding), and `redirect_policy`
//! re-validates every redirect hop.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use url::{Host, Url};

use crate::error::{AppError, AppResult};

pub const MAX_REDIRECTS: usize = 5;

/// Which address classes a client may connect to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressPolicy {
    /// Public internet only (default for bookmark URLs).
    PublicOnly,
    /// Public + loopback (Ollama on the same machine).
    AllowLoopback,
    /// Public + loopback + private/link-local/CGNAT (user enabled "allow private network").
    AllowPrivate,
}

impl AddressPolicy {
    /// Policy for bookmark / page URLs.
    pub fn for_web(allow_private_network: bool) -> Self {
        if allow_private_network {
            AddressPolicy::AllowPrivate
        } else {
            AddressPolicy::PublicOnly
        }
    }

    /// Policy for the Ollama base URL: loopback always, private only when allowed.
    pub fn for_ollama(allow_private_network: bool) -> Self {
        if allow_private_network {
            AddressPolicy::AllowPrivate
        } else {
            AddressPolicy::AllowLoopback
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClass {
    Public,
    Loopback,
    Private,
    LinkLocal,
    SharedCgnat,
    Reserved,
    /// Cloud metadata endpoints (169.254.169.254, fd00:ec2::254), never allowed.
    Metadata,
    Unspecified,
    Multicast,
    Broadcast,
}

pub fn classify_ip(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(ip: Ipv4Addr) -> IpClass {
    let o = ip.octets();
    if ip == Ipv4Addr::new(169, 254, 169, 254) || ip == Ipv4Addr::new(100, 100, 100, 200) {
        return IpClass::Metadata;
    }
    if ip.is_broadcast() {
        return IpClass::Broadcast;
    }
    if ip.is_unspecified() || o[0] == 0 {
        return IpClass::Unspecified;
    }
    if ip.is_loopback() {
        return IpClass::Loopback;
    }
    if ip.is_private() {
        return IpClass::Private;
    }
    if ip.is_link_local() {
        return IpClass::LinkLocal;
    }
    if o[0] == 100 && (o[1] & 0b1100_0000) == 64 {
        return IpClass::SharedCgnat;
    }
    if ip.is_multicast() {
        return IpClass::Multicast;
    }
    // IETF, documentation, 6to4-relay, benchmarking and reserved ranges.
    if (o[0] == 192 && o[1] == 0 && (o[2] == 0 || o[2] == 2))
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || (o[0] == 198 && (o[1] & 0xfe) == 18)
        || o[0] >= 240
    {
        return IpClass::Reserved;
    }
    IpClass::Public
}

fn classify_v6(ip: Ipv6Addr) -> IpClass {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return classify_v4(v4);
    }
    let seg = ip.segments();
    // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address.
    if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6].iter().all(|s| *s == 0) {
        let [a, b] = seg[6].to_be_bytes();
        let [c, d] = seg[7].to_be_bytes();
        return classify_v4(Ipv4Addr::new(a, b, c, d));
    }
    // Local-use NAT64 64:ff9b:1::/48 (RFC 8215), read with the common /96 layout.
    if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2] == 1 {
        return classify_v4(v4_from(seg[6], seg[7]));
    }
    // 6to4 2002::/16 embeds the tunnel endpoint's IPv4 address in bits 16..48.
    if seg[0] == 0x2002 {
        return embedded_class(&[v4_from(seg[1], seg[2])]);
    }
    // Teredo 2001:0::/32 carries the server IPv4 and the XOR'd client IPv4; either one blocks.
    if seg[0] == 0x2001 && seg[1] == 0 {
        let server = v4_from(seg[2], seg[3]);
        let client = v4_from(!seg[6], !seg[7]);
        return embedded_class(&[client, server]);
    }
    if ip == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254) {
        return IpClass::Metadata;
    }
    if ip.is_unspecified() {
        return IpClass::Unspecified;
    }
    if ip.is_loopback() {
        return IpClass::Loopback;
    }
    if ip.is_multicast() {
        return IpClass::Multicast;
    }
    if (seg[0] & 0xfe00) == 0xfc00 {
        return IpClass::Private; // unique local fc00::/7
    }
    if (seg[0] & 0xffc0) == 0xfe80 {
        return IpClass::LinkLocal;
    }
    // Documentation 2001:db8::/32, IPv4-compatible ::/96 (deprecated), site-local fec0::/10.
    if (seg[0] == 0x2001 && seg[1] == 0x0db8)
        || seg[0..6].iter().all(|s| *s == 0)
        || (seg[0] & 0xffc0) == 0xfec0
    {
        return IpClass::Reserved;
    }
    IpClass::Public
}

fn v4_from(high: u16, low: u16) -> Ipv4Addr {
    let [a, b] = high.to_be_bytes();
    let [c, d] = low.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

/// Class of a transition address: the first embedded IPv4 address that is not public decides;
/// if all of them are public the IPv6 address is treated as public.
fn embedded_class(embedded: &[Ipv4Addr]) -> IpClass {
    embedded
        .iter()
        .map(|v4| classify_v4(*v4))
        .find(|class| *class != IpClass::Public)
        .unwrap_or(IpClass::Public)
}

pub fn ip_allowed(ip: IpAddr, policy: AddressPolicy) -> bool {
    match classify_ip(ip) {
        IpClass::Public => true,
        IpClass::Loopback => matches!(
            policy,
            AddressPolicy::AllowLoopback | AddressPolicy::AllowPrivate
        ),
        IpClass::Private | IpClass::LinkLocal | IpClass::SharedCgnat | IpClass::Reserved => {
            policy == AddressPolicy::AllowPrivate
        }
        IpClass::Metadata | IpClass::Unspecified | IpClass::Multicast | IpClass::Broadcast => false,
    }
}

fn blocked_message(host: &str, policy: AddressPolicy) -> String {
    match policy {
        AddressPolicy::AllowPrivate => {
            format!("Requests to {host} are not allowed (reserved or metadata address).")
        }
        _ => format!(
            "Requests to {host} are blocked because it is a local or private network address. \
             Enable \"Allow private network\" in Settings to allow it."
        ),
    }
}

/// Validates scheme and IP-literal hosts. Host names are validated by `GuardedResolver`.
pub fn check_url(url: &Url, policy: AddressPolicy) -> AppResult<()> {
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::invalid_input(format!(
                "Only http/https URLs are supported (got \"{other}\")."
            )))
        }
    }
    let host = url
        .host()
        .ok_or_else(|| AppError::invalid_input("URL must include a host."))?;
    let allowed = match host {
        Host::Ipv4(ip) => ip_allowed(IpAddr::V4(ip), policy),
        Host::Ipv6(ip) => ip_allowed(IpAddr::V6(ip), policy),
        Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            if domain == "localhost" || domain.ends_with(".localhost") {
                ip_allowed(IpAddr::V4(Ipv4Addr::LOCALHOST), policy)
            } else {
                true
            }
        }
    };
    if allowed {
        Ok(())
    } else {
        Err(AppError::BlockedAddress(blocked_message(
            &host.to_string(),
            policy,
        )))
    }
}

/// Error returned by the resolver / redirect policy when the target is not allowed.
#[derive(Debug)]
pub struct BlockedAddressError(pub String);

impl fmt::Display for BlockedAddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BlockedAddressError {}

/// DNS resolution failure. `not_found` is true for authoritative "no such host" answers.
#[derive(Debug)]
pub struct DnsLookupError {
    pub host: String,
    pub not_found: bool,
    pub detail: String,
}

impl fmt::Display for DnsLookupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.not_found {
            write!(f, "the host {} could not be found", self.host)
        } else {
            write!(f, "DNS lookup for {} failed ({})", self.host, self.detail)
        }
    }
}

impl std::error::Error for DnsLookupError {}

/// Heuristic: does this lookup error mean "the name does not exist"?
pub fn is_name_not_found(error: &std::io::Error) -> bool {
    // Windows: WSAHOST_NOT_FOUND (11001), WSANO_DATA (11004).
    if matches!(error.raw_os_error(), Some(11001) | Some(11004)) {
        return true;
    }
    let message = error.to_string().to_ascii_lowercase();
    [
        "no such host",
        "name or service not known",
        "nodename nor servname provided",
        "no address associated with hostname",
        "name does not resolve",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// DNS resolver that filters out addresses the policy does not allow.
#[derive(Debug, Clone, Copy)]
pub struct GuardedResolver {
    policy: AddressPolicy,
}

impl GuardedResolver {
    pub fn new(policy: AddressPolicy) -> Self {
        Self { policy }
    }
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.policy;
        let host = name.as_str().to_string();
        Box::pin(async move {
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| DnsLookupError {
                    host: host.clone(),
                    not_found: is_name_not_found(&e),
                    detail: e.to_string(),
                })?
                .collect();
            let vetted = vet_resolved(&host, resolved, policy)?;
            let addrs: Addrs = Box::new(vetted.into_iter());
            Ok(addrs)
        })
    }
}

/// Decides what a name's DNS answer may be used for. All-or-nothing: if any address is
/// disallowed the whole name is refused, so a mixed public/private answer can't slip through.
pub fn vet_resolved(
    host: &str,
    resolved: Vec<SocketAddr>,
    policy: AddressPolicy,
) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    if resolved.is_empty() {
        return Err(Box::new(DnsLookupError {
            host: host.to_string(),
            not_found: true,
            detail: "no addresses".to_string(),
        }));
    }
    if let Some(blocked) = resolved.iter().find(|addr| !ip_allowed(addr.ip(), policy)) {
        log::debug!("guard: {host} resolved to disallowed {}", blocked.ip());
        return Err(Box::new(BlockedAddressError(blocked_message(host, policy))));
    }
    Ok(resolved)
}

/// Redirect policy: at most `MAX_REDIRECTS` hops, each hop re-validated.
pub fn redirect_policy(policy: AddressPolicy) -> Policy {
    Policy::custom(move |attempt| {
        // `previous()` includes the original URL, so `len()` is hops taken + 1.
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error(format!("stopped after {MAX_REDIRECTS} redirects"));
        }
        match check_url(attempt.url(), policy) {
            Ok(()) => attempt.follow(),
            Err(err) => attempt.error(BlockedAddressError(err.to_string())),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("valid ip")
    }

    fn url(s: &str) -> Url {
        Url::parse(s).expect("valid url")
    }

    #[test]
    fn classifies_ipv4() {
        assert_eq!(classify_ip(ip("8.8.8.8")), IpClass::Public);
        assert_eq!(classify_ip(ip("127.0.0.1")), IpClass::Loopback);
        assert_eq!(classify_ip(ip("10.1.2.3")), IpClass::Private);
        assert_eq!(classify_ip(ip("172.20.0.1")), IpClass::Private);
        assert_eq!(classify_ip(ip("192.168.1.10")), IpClass::Private);
        assert_eq!(classify_ip(ip("169.254.169.254")), IpClass::Metadata);
        assert_eq!(classify_ip(ip("169.254.1.1")), IpClass::LinkLocal);
        assert_eq!(classify_ip(ip("100.64.0.1")), IpClass::SharedCgnat);
        assert_eq!(classify_ip(ip("100.128.0.1")), IpClass::Public);
        assert_eq!(classify_ip(ip("0.0.0.0")), IpClass::Unspecified);
        assert_eq!(classify_ip(ip("255.255.255.255")), IpClass::Broadcast);
        assert_eq!(classify_ip(ip("224.0.0.1")), IpClass::Multicast);
    }

    #[test]
    fn classifies_ipv6() {
        assert_eq!(classify_ip(ip("::1")), IpClass::Loopback);
        assert_eq!(classify_ip(ip("::ffff:127.0.0.1")), IpClass::Loopback);
        assert_eq!(classify_ip(ip("::ffff:10.0.0.1")), IpClass::Private);
        assert_eq!(classify_ip(ip("64:ff9b::a9fe:a9fe")), IpClass::Metadata);
        assert_eq!(classify_ip(ip("fd00:ec2::254")), IpClass::Metadata);
        assert_eq!(classify_ip(ip("fd12:3456::1")), IpClass::Private);
        assert_eq!(classify_ip(ip("fe80::1")), IpClass::LinkLocal);
        assert_eq!(classify_ip(ip("2606:4700::1111")), IpClass::Public);
    }

    #[test]
    fn classifies_ipv6_transition_addresses_by_their_embedded_ipv4() {
        // 6to4: 2002:AABB:CCDD::/48 -> AA.BB.CC.DD
        assert_eq!(classify_ip(ip("2002:7f00:0001::1")), IpClass::Loopback);
        assert_eq!(classify_ip(ip("2002:a9fe:a9fe::")), IpClass::Metadata);
        assert_eq!(classify_ip(ip("2002:c0a8:0101::1")), IpClass::Private);
        assert_eq!(classify_ip(ip("2002:0808:0808::1")), IpClass::Public);
        // Teredo: client = !last 32 bits. 127.0.0.1 -> 80ff:fffe.
        assert_eq!(
            classify_ip(ip("2001:0:4136:e378:8000:63bf:80ff:fffe")),
            IpClass::Loopback
        );
        // 10.0.0.1 -> f5ff:fffe
        assert_eq!(
            classify_ip(ip("2001:0:4136:e378:8000:63bf:f5ff:fffe")),
            IpClass::Private
        );
        // Server part in a private range blocks too; public client and server stay public.
        assert_eq!(
            classify_ip(ip("2001:0:c0a8:0101:8000:63bf:f7f7:f7f7")),
            IpClass::Private
        );
        assert_eq!(
            classify_ip(ip("2001:0:4136:e378:8000:63bf:f7f7:f7f7")),
            IpClass::Public
        );
        // Local-use NAT64.
        assert_eq!(classify_ip(ip("64:ff9b:1::7f00:1")), IpClass::Loopback);
        assert_eq!(classify_ip(ip("64:ff9b:1::a9fe:a9fe")), IpClass::Metadata);
        assert_eq!(classify_ip(ip("64:ff9b:1::808:808")), IpClass::Public);
        // 2001:db8::/32 is still documentation, not Teredo.
        assert_eq!(classify_ip(ip("2001:db8::1")), IpClass::Reserved);
        // 6to4 relay anycast.
        assert_eq!(classify_ip(ip("192.88.99.1")), IpClass::Reserved);
        assert!(!ip_allowed(
            ip("2002:7f00:0001::1"),
            AddressPolicy::PublicOnly
        ));
    }

    #[test]
    fn address_policies_allow_only_their_classes() {
        assert!(!ip_allowed(ip("127.0.0.1"), AddressPolicy::PublicOnly));
        assert!(ip_allowed(ip("127.0.0.1"), AddressPolicy::AllowLoopback));
        assert!(!ip_allowed(ip("192.168.1.2"), AddressPolicy::AllowLoopback));
        assert!(ip_allowed(ip("192.168.1.2"), AddressPolicy::AllowPrivate));
        assert!(!ip_allowed(
            ip("169.254.169.254"),
            AddressPolicy::AllowPrivate
        ));
        assert!(!ip_allowed(ip("0.0.0.0"), AddressPolicy::AllowPrivate));
    }

    #[test]
    fn check_url_rejects_blocked_schemes_and_ip_literals() {
        assert!(check_url(&url("https://example.com"), AddressPolicy::PublicOnly).is_ok());
        assert!(check_url(&url("http://127.0.0.1:9200"), AddressPolicy::PublicOnly).is_err());
        assert!(check_url(&url("http://localhost:11434"), AddressPolicy::PublicOnly).is_err());
        assert!(check_url(&url("http://localhost:11434"), AddressPolicy::AllowLoopback).is_ok());
        assert!(check_url(&url("http://[::1]/"), AddressPolicy::PublicOnly).is_err());
        assert!(check_url(
            &url("http://169.254.169.254/latest"),
            AddressPolicy::AllowPrivate
        )
        .is_err());
        assert!(check_url(&url("file:///etc/passwd"), AddressPolicy::AllowPrivate).is_err());
        assert!(check_url(&url("ftp://example.com"), AddressPolicy::PublicOnly).is_err());
        let blocked = check_url(&url("http://10.0.0.5"), AddressPolicy::PublicOnly)
            .expect_err("private must be blocked");
        assert_eq!(blocked.kind(), "blockedAddress");
    }

    #[tokio::test]
    async fn resolver_blocks_loopback_names() {
        let resolver = GuardedResolver::new(AddressPolicy::PublicOnly);
        let name: Name = "localhost".parse().expect("name");
        let result = resolver.resolve(name).await;
        let err = result.err().expect("localhost must be rejected");
        assert!(err.downcast_ref::<BlockedAddressError>().is_some());

        let resolver = GuardedResolver::new(AddressPolicy::AllowLoopback);
        let name: Name = "localhost".parse().expect("name");
        assert!(resolver.resolve(name).await.is_ok());
    }
}
