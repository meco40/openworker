//! Port of `src/server/http/ssrfGuard.ts`.
//!
//! [`assert_safe_http_url`] decides whether a URL may be fetched. [`fetch_with_ssrf_guard`]
//! checks every hop of a redirect chain, not only the first. [`check_body_limit`] applies the
//! size limit of `readResponseBytesLimited`.
//!
//! Where this port differs from TypeScript, it is stricter:
//! - URL syntax: backslashes, control characters, `%` and non-ASCII characters in a host are
//!   rejected instead of being normalised. A numeric IPv4 host (`2130706433`, `0x7f.1`,
//!   `0177.0.0.1`) is normalised the way WHATWG does, so the address that is checked is the
//!   address that is requested. The request goes to the normalised URL, not to the typed text.
//! - IPv4-compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses
//!   are checked against the IPv4 policy of the address they embed.
//! - Site-local `fec0::/10` is blocked. The TypeScript mask `0xfe00` never matches it.
//! - Benchmarking `198.18.0.0/15` is blocked. TypeScript has `192.18.0.0/24` in its place.
//!   That range stays in the table here too.
//! - IP literals skip DNS. Their address is checked already.
//!
//! DNS rebinding: every hop is pinned to the address its host check resolved. The hop carries
//! that address in [`HttpRequest::resolve_to`], so the transport connects to the checked address
//! and does not resolve the name a second time. An IP-literal host needs no pin.
//!
//! Transport requirement: the guard follows redirects itself, one hop at a time. The
//! transport must not follow redirects on its own, or a redirect would reach a host the guard
//! never checked. `reqwest` follows them by default.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::time::{Duration, Instant};

use crate::model_hub::http::{
    fetch_with_timeout, BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport,
};

/// `DEFAULT_MAX_REDIRECTS` (ssrfGuard.ts:3).
pub const DEFAULT_MAX_REDIRECTS: usize = 3;
/// `DEFAULT_MAX_BODY_BYTES` (ssrfGuard.ts:4).
pub const DEFAULT_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Timeout for TypeScript fetches that set no signal. Node then relies on undici's 300 s
/// headers timeout, and this keeps the same effective limit.
pub const UNBOUNDED_FETCH_CAP_MS: u64 = 300_000;

/// Headers that must not reach another origin through a redirect (ssrfGuard.ts:172).
const CROSS_ORIGIN_STRIPPED_HEADERS: [&str; 3] = ["authorization", "cookie", "proxy-authorization"];

/// The blocked IPv4 ranges of `isBlockedIpv4` (ssrfGuard.ts:22-36), inclusive bounds.
const BLOCKED_IPV4: &[(u32, u32)] = &[
    (0x0000_0000, 0x00ff_ffff), // current network
    (0x0a00_0000, 0x0aff_ffff), // RFC1918
    (0x6440_0000, 0x647f_ffff), // carrier-grade NAT
    (0x7f00_0000, 0x7fff_ffff), // loopback
    (0xa9fe_0000, 0xa9fe_ffff), // link-local, includes the 169.254.169.254 metadata endpoint
    (0xac10_0000, 0xac1f_ffff), // RFC1918
    (0xc000_0000, 0xc000_00ff), // IETF protocol assignments
    (0xc000_0200, 0xc000_02ff), // TEST-NET-1
    (0xc012_0000, 0xc012_00ff), // 192.18.0.0/24, kept from the TypeScript table
    (0xc612_0000, 0xc613_ffff), // benchmarking 198.18.0.0/15 (RFC 2544)
    (0xc0a8_0000, 0xc0a8_ffff), // RFC1918
    (0xc633_6400, 0xc633_64ff), // TEST-NET-2
    (0xcb00_7100, 0xcb00_71ff), // TEST-NET-3
    (0xe000_0000, 0xffff_ffff), // multicast and reserved
];

/// Everything the guard can refuse, with the message TypeScript throws.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NetError {
    #[error("Unsupported protocol: {0}")]
    UnsupportedProtocol(String),
    #[error("Invalid URL")]
    InvalidUrl,
    #[error("URL must contain a hostname and no embedded credentials.")]
    MissingHostOrCredentials,
    #[error("SSRF guard: blocked local hostname \"{0}\"")]
    LocalHostname(String),
    #[error("SSRF guard: blocked private/loopback address \"{0}\"")]
    PrivateAddress(String),
    #[error("SSRF guard: hostname could not be resolved \"{0}\"")]
    Unresolved(String),
    #[error("SSRF guard: hostname \"{host}\" resolves to private address \"{address}\"")]
    ResolvesToPrivate { host: String, address: String },
    #[error("SSRF guard: redirect limit exceeded.")]
    RedirectLimit,
    #[error("Response body exceeds the {0}-byte limit.")]
    BodyTooLarge(usize),
    #[error("{0}")]
    Http(#[from] HttpError),
}

/// `dns.lookup(host, { all: true })`: every address a name resolves to.
pub trait Resolver: Send + Sync {
    fn lookup<'a>(&'a self, host: &'a str) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>>;
}

/// The system resolver, which is `getaddrinfo` as Node's `dns.lookup` uses it.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn lookup<'a>(&'a self, host: &'a str) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host, 0)).await?;
            Ok(addresses.map(|address| address.ip()).collect())
        })
    }
}

/// `isPrivateOrReservedIp` (ssrfGuard.ts:102) on a parsed address.
pub fn is_private_or_reserved_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(address: Ipv4Addr) -> bool {
    let number = u32::from(address);
    BLOCKED_IPV4
        .iter()
        .any(|&(start, end)| (start..=end).contains(&number))
}

fn is_blocked_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if let Some(embedded) = embedded_ipv4(segments) {
        // `::`, `::1`, IPv4-mapped and the other embedding forms use the IPv4 policy.
        return is_blocked_ipv4(embedded);
    }
    let [first, second, ..] = segments;
    (first & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (first & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (first & 0xffc0) == 0xfec0 // site-local fec0::/10
        || (first & 0xff00) == 0xff00 // multicast ff00::/8
        || (first == 0x0100 && second == 0) // discard-only 100::/64, two segments as in TypeScript
        || (first == 0x2001 && second == 0x0db8) // documentation 2001:db8::/32
        || (first == 0x2001 && (second & 0xfff0) == 0x0010) // benchmarking 2001:10::/28
}

/// The IPv4 address embedded in the IPv6 forms that carry one.
fn embedded_ipv4(segments: [u16; 8]) -> Option<Ipv4Addr> {
    let [a, b, c, d, e, f, g, h] = segments;
    let tail =
        |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if [a, b, c, d, e] == [0; 5] && f == 0xffff {
        return Some(tail(g, h)); // ::ffff:0:0/96, IPv4-mapped
    }
    if [a, b, c, d, e, f] == [0; 6] {
        return Some(tail(g, h)); // ::/96, IPv4-compatible (deprecated), includes :: and ::1
    }
    if [a, b] == [0x0064, 0xff9b] && [c, d, e, f] == [0; 4] {
        return Some(tail(g, h)); // 64:ff9b::/96, NAT64
    }
    if a == 0x2002 {
        return Some(tail(b, c)); // 2002::/16, 6to4
    }
    None
}

/// A host after normalisation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    /// A lower-case ASCII name.
    Domain(String),
    Ipv4(Ipv4Addr),
    Ipv6(Ipv6Addr),
}

impl Host {
    /// The host as TypeScript's `hostname` prints it, without brackets.
    fn text(&self) -> String {
        match self {
            Host::Domain(name) => name.clone(),
            Host::Ipv4(address) => address.to_string(),
            Host::Ipv6(address) => address.to_string(),
        }
    }
}

/// An `http:` or `https:` URL in the normalised form the guard checks and requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeUrl {
    pub https: bool,
    pub host: Host,
    pub port: Option<u16>,
    /// Path and query, starting with `/`. The fragment is dropped, as fetch drops it.
    pub path_and_query: String,
}

impl SafeUrl {
    pub fn scheme(&self) -> &'static str {
        if self.https {
            "https"
        } else {
            "http"
        }
    }

    /// `host[:port]`, with brackets around an IPv6 host.
    pub fn authority(&self) -> String {
        let host = match &self.host {
            Host::Ipv6(address) => format!("[{address}]"),
            other => other.text(),
        };
        match self.port {
            Some(port) => format!("{host}:{port}"),
            None => host,
        }
    }

    /// The URL the request is sent to.
    pub fn to_url_string(&self) -> String {
        format!(
            "{}://{}{}",
            self.scheme(),
            self.authority(),
            self.path_and_query
        )
    }

    /// `res.url`-style comparison: scheme, host and effective port.
    fn same_origin(&self, other: &SafeUrl) -> bool {
        self.https == other.https
            && self.host == other.host
            && self.effective_port() == other.effective_port()
    }

    fn effective_port(&self) -> u16 {
        self.port.unwrap_or(if self.https { 443 } else { 80 })
    }
}

/// The syntax half of `new URL(input)`, plus the protocol and credential checks of
/// `assertSafeHttpUrl`. The error for each malformed input is the one TypeScript throws.
pub fn parse_http_url(input: &str) -> Result<SafeUrl, NetError> {
    let input = input.trim_matches(|c: char| c <= ' ');
    if input.chars().any(|c| c.is_control() || c == '\\') {
        return Err(NetError::InvalidUrl);
    }
    let colon = input.find(':').ok_or(NetError::InvalidUrl)?;
    let scheme = input[..colon].to_ascii_lowercase();
    let scheme_is_valid = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !scheme_is_valid {
        return Err(NetError::InvalidUrl);
    }
    let https = match scheme.as_str() {
        "http" => false,
        "https" => true,
        _ => return Err(NetError::UnsupportedProtocol(format!("{scheme}:"))),
    };

    // Special schemes accept any number of slashes after the colon.
    let after = input[colon + 1..].trim_start_matches('/');
    let without_fragment = after.split('#').next().unwrap_or("");
    let authority_end = without_fragment
        .find(['/', '?'])
        .unwrap_or(without_fragment.len());
    let (authority, rest) = without_fragment.split_at(authority_end);
    if authority.contains('@') {
        return Err(NetError::MissingHostOrCredentials);
    }
    let path_and_query = match rest {
        "" => "/".to_string(),
        _ if rest.starts_with('?') => format!("/{rest}"),
        _ => rest.to_string(),
    };
    let (host, port) = parse_authority(authority)?;
    Ok(SafeUrl {
        https,
        host,
        port,
        path_and_query,
    })
}

/// Splits `host[:port]`. An IPv6 host is written in brackets.
fn parse_authority(authority: &str) -> Result<(Host, Option<u16>), NetError> {
    let (host_text, port_text, bracketed) = if let Some(inner) = authority.strip_prefix('[') {
        let end = inner.find(']').ok_or(NetError::InvalidUrl)?;
        let after = &inner[end + 1..];
        let port_text = match after.strip_prefix(':') {
            Some(port) => Some(port),
            None if after.is_empty() => None,
            None => return Err(NetError::InvalidUrl),
        };
        (&inner[..end], port_text, true)
    } else {
        if authority.matches(':').count() > 1 {
            return Err(NetError::InvalidUrl);
        }
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port), false),
            None => (authority, None, false),
        }
    };
    if host_text.is_empty() {
        return Err(NetError::InvalidUrl);
    }
    let port = match port_text {
        None | Some("") => None,
        Some(digits) if digits.bytes().all(|b| b.is_ascii_digit()) => {
            Some(digits.parse::<u16>().map_err(|_| NetError::InvalidUrl)?)
        }
        Some(_) => return Err(NetError::InvalidUrl),
    };
    let host = if bracketed {
        Host::Ipv6(Ipv6Addr::from_str(host_text).map_err(|_| NetError::InvalidUrl)?)
    } else {
        parse_plain_host(host_text)?
    };
    Ok((host, port))
}

fn parse_plain_host(text: &str) -> Result<Host, NetError> {
    let lower = text.to_ascii_lowercase();
    if ends_in_a_number(&lower) {
        return parse_ipv4_form(&lower)
            .map(Host::Ipv4)
            .ok_or(NetError::InvalidUrl);
    }
    let valid = !lower.is_empty()
        && lower
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'));
    if !valid {
        return Err(NetError::InvalidUrl);
    }
    Ok(Host::Domain(lower))
}

/// WHATWG "ends in a number": the last label is all digits or parses as an IPv4 number.
fn ends_in_a_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    let Some(last) = parts.last() else {
        return false;
    };
    (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()))
        || parse_ipv4_number(last).is_some()
}

/// WHATWG "parse an IPv4 number": decimal, `0x` hexadecimal or leading-zero octal.
fn parse_ipv4_number(text: &str) -> Option<u64> {
    if text.is_empty() {
        return None;
    }
    let (digits, radix) =
        if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            (hex, 16)
        } else if text.len() > 1 && text.starts_with('0') {
            (&text[1..], 8)
        } else {
            (text, 10)
        };
    if digits.is_empty() {
        return Some(0);
    }
    if !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    u64::from_str_radix(digits, radix).ok()
}

/// WHATWG IPv4 parser: one to four parts, the last part fills the remaining bytes.
fn parse_ipv4_form(host: &str) -> Option<Ipv4Addr> {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    if parts.len() > 4 {
        return None;
    }
    let numbers = parts
        .iter()
        .copied()
        .map(parse_ipv4_number)
        .collect::<Option<Vec<u64>>>()?;
    let (last, head) = numbers.split_last()?;
    if head.iter().any(|&number| number > 255) {
        return None;
    }
    if *last >= 256u64.pow(5 - numbers.len() as u32) {
        return None;
    }
    let mut value = *last;
    for (index, number) in head.iter().enumerate() {
        value += number * 256u64.pow(3 - index as u32);
    }
    u32::try_from(value).ok().map(Ipv4Addr::from)
}

/// `assertSafeHttpUrl` (ssrfGuard.ts:106-145).
pub async fn assert_safe_http_url(
    input: &str,
    resolver: &dyn Resolver,
) -> Result<SafeUrl, NetError> {
    let url = parse_http_url(input)?;
    check_host(&url, resolver).await?;
    Ok(url)
}

/// Checks the host. A name returns the first address it resolved to, which the hop is pinned to.
/// An IP literal is checked as it is and returns `None`.
async fn check_host(url: &SafeUrl, resolver: &dyn Resolver) -> Result<Option<IpAddr>, NetError> {
    match &url.host {
        Host::Domain(name) => {
            if name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") {
                return Err(NetError::LocalHostname(name.clone()));
            }
            let addresses = match resolver.lookup(name).await {
                Ok(list) if !list.is_empty() => list,
                _ => return Err(NetError::Unresolved(name.clone())),
            };
            // Every answer counts, so one private AAAA record blocks the name.
            if let Some(address) = addresses
                .iter()
                .find(|address| is_private_or_reserved_ip(**address))
            {
                return Err(NetError::ResolvesToPrivate {
                    host: name.clone(),
                    address: address.to_string(),
                });
            }
            Ok(addresses.first().copied())
        }
        Host::Ipv4(address) => check_literal(IpAddr::V4(*address), &url.host.text()).map(|()| None),
        Host::Ipv6(address) => check_literal(IpAddr::V6(*address), &url.host.text()).map(|()| None),
    }
}

fn check_literal(address: IpAddr, text: &str) -> Result<(), NetError> {
    if is_private_or_reserved_ip(address) {
        Err(NetError::PrivateAddress(text.to_string()))
    } else {
        Ok(())
    }
}

/// `new URL(location, base)` for the forms a server sends. The result is parsed again, so it
/// passes the same checks as any other URL.
fn resolve_location(base: &SafeUrl, location: &str) -> Result<SafeUrl, NetError> {
    let location = location.trim_matches(|c: char| c <= ' ');
    if has_scheme(location) {
        return parse_http_url(location);
    }
    if let Some(rest) = location.strip_prefix("//") {
        return parse_http_url(&format!("{}://{rest}", base.scheme()));
    }
    let base_path = base.path_and_query.split('?').next().unwrap_or("/");
    let joined = if location.starts_with('/') {
        location.to_string()
    } else if location.starts_with('?') {
        format!("{base_path}{location}")
    } else if location.starts_with('#') {
        base.path_and_query.clone()
    } else {
        let directory_end = base_path.rfind('/').map_or(0, |index| index + 1);
        format!("{}{location}", &base_path[..directory_end])
    };
    parse_http_url(&format!(
        "{}://{}{}",
        base.scheme(),
        base.authority(),
        joined
    ))
}

fn has_scheme(text: &str) -> bool {
    match text.find(':') {
        Some(index) if index > 0 => {
            text.starts_with(|c: char| c.is_ascii_alphabetic())
                && text[..index]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        _ => false,
    }
}

/// The final response of a guarded fetch, and the URL it was served from (`res.url`).
#[derive(Debug, Clone)]
pub struct GuardedResponse {
    pub url: String,
    pub response: HttpResponse,
}

/// `fetchWithSsrfGuard` (ssrfGuard.ts:151-179).
///
/// The guard follows redirects. Each hop passes the host checks before it is sent, and it is
/// pinned to the address those checks resolved (`resolve_to`). The deadline in
/// `request.timeout_ms` covers all hops together, as the shared `AbortSignal.timeout` does in
/// TypeScript. Headers that carry credentials are removed when a redirect leaves the origin.
pub async fn fetch_with_ssrf_guard(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    mut request: HttpRequest,
    max_redirects: usize,
) -> Result<GuardedResponse, NetError> {
    let deadline = Instant::now().checked_add(Duration::from_millis(request.timeout_ms));
    let mut current = parse_http_url(&request.url)?;
    let mut redirects = 0usize;
    loop {
        let pinned = check_host(&current, resolver).await?;
        let remaining = match deadline {
            Some(deadline) => deadline.saturating_duration_since(Instant::now()),
            None => Duration::MAX,
        };
        if remaining.is_zero() {
            return Err(NetError::Http(HttpError::Timeout));
        }
        let mut hop = request.clone();
        hop.url = current.to_url_string();
        hop.resolve_to = pinned.map(|address| SocketAddr::new(address, current.effective_port()));
        hop.timeout_ms = u64::try_from(remaining.as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        let response = fetch_with_timeout(transport, hop).await?;
        let location = response.header("location").to_string();
        let is_redirect = (300..400).contains(&response.status.as_u16());
        if !is_redirect || location.is_empty() {
            return Ok(GuardedResponse {
                url: current.to_url_string(),
                response,
            });
        }
        if redirects >= max_redirects {
            return Err(NetError::RedirectLimit);
        }
        let next = resolve_location(&current, &location)?;
        if !next.same_origin(&current) {
            for name in CROSS_ORIGIN_STRIPPED_HEADERS {
                request.headers.remove(name);
            }
        }
        current = next;
        redirects += 1;
    }
}

/// The size check of `readResponseBytesLimited` (ssrfGuard.ts:181-215).
///
/// The transport has already buffered the body, so the check runs afterwards. The
/// `Content-Length` header is checked first, as in TypeScript.
pub fn check_body_limit(response: &HttpResponse, max_bytes: usize) -> Result<(), NetError> {
    let declared = response.header("content-length");
    let declared = if declared.is_empty() {
        0.0
    } else {
        declared.trim().parse::<f64>().unwrap_or(f64::NAN)
    };
    if declared.is_finite() && declared > max_bytes as f64 {
        return Err(NetError::BodyTooLarge(max_bytes));
    }
    if response.body.len() > max_bytes {
        return Err(NetError::BodyTooLarge(max_bytes));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_guard::test_support::{response_with, FakeResolver, FakeTransport};

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("test address")
    }

    fn public_resolver() -> FakeResolver {
        FakeResolver::with(vec![
            ("example.test", vec!["93.184.216.34"]),
            ("other.test", vec!["93.184.216.35"]),
        ])
    }

    fn get(url: &str) -> HttpRequest {
        HttpRequest::get(url).timeout_ms(5_000)
    }

    #[test]
    fn ipv4_policy_matches_the_typescript_ranges() {
        let blocked = [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "255.255.255.255",
        ];
        for address in blocked {
            assert!(
                is_private_or_reserved_ip(ip(address)),
                "{address} is blocked"
            );
        }
        for address in [
            "8.8.8.8",
            "93.184.216.34",
            "172.32.0.1",
            "100.128.0.1",
            "198.20.0.1",
        ] {
            assert!(
                !is_private_or_reserved_ip(ip(address)),
                "{address} is allowed"
            );
        }
    }

    #[test]
    fn ipv6_policy_covers_embedded_ipv4_and_reserved_prefixes() {
        let blocked = [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "2001:10::1",
            "100::1",
        ];
        for address in blocked {
            assert!(
                is_private_or_reserved_ip(ip(address)),
                "{address} is blocked"
            );
        }
        for address in [
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
            "2001:4860:4860::8888",
            "64:ff9b::808:808",
        ] {
            assert!(
                !is_private_or_reserved_ip(ip(address)),
                "{address} is allowed"
            );
        }
    }

    #[test]
    fn numeric_ipv4_hosts_are_normalised_before_the_check() {
        let loopback = Host::Ipv4(Ipv4Addr::new(127, 0, 0, 1));
        for url in [
            "http://2130706433/",
            "http://0x7f.1/",
            "http://0177.0.0.1/",
            "http://127.1/",
        ] {
            assert_eq!(parse_http_url(url).expect(url).host, loopback, "{url}");
        }
        assert_eq!(
            parse_http_url("http://256.0.0.1/"),
            Err(NetError::InvalidUrl)
        );
        assert_eq!(
            parse_http_url("http://example.123/"),
            Err(NetError::InvalidUrl)
        );
    }

    #[test]
    fn parse_rejects_bad_syntax_and_reports_the_protocol_like_typescript() {
        assert_eq!(
            parse_http_url("ftp://example.test/"),
            Err(NetError::UnsupportedProtocol("ftp:".to_string()))
        );
        assert_eq!(parse_http_url("no-scheme"), Err(NetError::InvalidUrl));
        assert_eq!(
            parse_http_url("http://user@example.test/"),
            Err(NetError::MissingHostOrCredentials)
        );
        assert_eq!(
            parse_http_url("http://exa%6dple.test/"),
            Err(NetError::InvalidUrl)
        );
        assert_eq!(
            parse_http_url("http://example.test\\@127.0.0.1/"),
            Err(NetError::InvalidUrl)
        );
        assert_eq!(parse_http_url("http://"), Err(NetError::InvalidUrl));
        assert_eq!(
            parse_http_url("http://ex ample.test/"),
            Err(NetError::InvalidUrl)
        );
    }

    #[test]
    fn parse_keeps_port_and_query_and_drops_the_fragment() {
        let url = parse_http_url("HTTPS://[::1]:8443/a/b?x=1#frag").expect("valid");
        assert_eq!(url.host, Host::Ipv6(Ipv6Addr::LOCALHOST));
        assert_eq!(url.port, Some(8443));
        assert_eq!(url.to_url_string(), "https://[::1]:8443/a/b?x=1");
        assert_eq!(
            parse_http_url("http://Example.TEST")
                .expect("valid")
                .to_url_string(),
            "http://example.test/"
        );
    }

    #[test]
    fn locations_resolve_like_the_url_constructor() {
        let base = parse_http_url("https://example.test/a/b?q=1").expect("base");
        let resolved = |location: &str| {
            resolve_location(&base, location)
                .expect(location)
                .to_url_string()
        };
        assert_eq!(resolved("/x?y=2"), "https://example.test/x?y=2");
        assert_eq!(resolved("c"), "https://example.test/a/c");
        assert_eq!(resolved("?z=3"), "https://example.test/a/b?z=3");
        assert_eq!(resolved("//other.test:8080/p"), "https://other.test:8080/p");
        assert_eq!(resolved("http://example.test/"), "http://example.test/");
        assert!(resolve_location(&base, "ftp://example.test/").is_err());
    }

    #[tokio::test]
    async fn local_names_and_private_literals_are_refused_without_dns() {
        // An empty resolver fails any lookup, so a DNS call here would show up as Unresolved.
        let resolver = FakeResolver::default();
        for (url, host) in [
            ("http://localhost:3000/", "localhost"),
            ("http://api.localhost/", "api.localhost"),
            ("http://printer.local/", "printer.local"),
        ] {
            assert_eq!(
                assert_safe_http_url(url, &resolver).await,
                Err(NetError::LocalHostname(host.to_string()))
            );
        }
        assert_eq!(
            assert_safe_http_url("http://169.254.169.254/latest", &resolver).await,
            Err(NetError::PrivateAddress("169.254.169.254".to_string()))
        );
        assert_eq!(
            assert_safe_http_url("http://[fd00::5]/", &resolver).await,
            Err(NetError::PrivateAddress("fd00::5".to_string()))
        );
    }

    #[tokio::test]
    async fn names_resolving_to_private_addresses_are_refused() {
        let resolver = FakeResolver::with(vec![
            ("internal.test", vec!["10.0.0.5"]),
            // A private AAAA answer blocks the name even when the A answer is public.
            ("mixed.test", vec!["93.184.216.34", "::1"]),
            ("empty.test", vec![]),
        ]);
        assert_eq!(
            assert_safe_http_url("http://internal.test/", &resolver).await,
            Err(NetError::ResolvesToPrivate {
                host: "internal.test".to_string(),
                address: "10.0.0.5".to_string(),
            })
        );
        assert_eq!(
            assert_safe_http_url("http://mixed.test/", &resolver).await,
            Err(NetError::ResolvesToPrivate {
                host: "mixed.test".to_string(),
                address: "::1".to_string(),
            })
        );
        assert_eq!(
            assert_safe_http_url("http://missing.test/", &resolver).await,
            Err(NetError::Unresolved("missing.test".to_string()))
        );
        assert_eq!(
            assert_safe_http_url("http://empty.test/", &resolver).await,
            Err(NetError::Unresolved("empty.test".to_string()))
        );
        assert!(
            assert_safe_http_url("http://example.test/x", &public_resolver())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn a_public_request_is_sent_to_the_normalised_url() {
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], "hello"))]);
        let guarded = fetch_with_ssrf_guard(
            &transport,
            &public_resolver(),
            get("https://example.test"),
            DEFAULT_MAX_REDIRECTS,
        )
        .await
        .expect("guarded fetch");
        assert_eq!(guarded.url, "https://example.test/");
        assert_eq!(guarded.response.body, "hello");
        assert_eq!(transport.requests()[0].url, "https://example.test/");
    }

    #[tokio::test]
    async fn a_redirect_into_a_private_address_stops_before_the_send() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            302,
            &[("location", "http://127.0.0.1/admin")],
            "",
        ))]);
        let error = fetch_with_ssrf_guard(
            &transport,
            &public_resolver(),
            get("https://example.test/start"),
            DEFAULT_MAX_REDIRECTS,
        )
        .await
        .unwrap_err();
        assert_eq!(error, NetError::PrivateAddress("127.0.0.1".to_string()));
        assert_eq!(
            transport.requests().len(),
            1,
            "the private hop is never sent"
        );
    }

    #[tokio::test]
    async fn the_redirect_limit_counts_followed_hops() {
        let transport = FakeTransport::with(vec![
            Ok(response_with(301, &[("location", "/one")], "")),
            Ok(response_with(301, &[("location", "/two")], "")),
        ]);
        let error = fetch_with_ssrf_guard(
            &transport,
            &public_resolver(),
            get("https://example.test/"),
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(error, NetError::RedirectLimit);
        assert_eq!(transport.requests().len(), 2);
    }

    #[tokio::test]
    async fn credentials_are_dropped_only_when_a_redirect_leaves_the_origin() {
        let transport = FakeTransport::with(vec![
            Ok(response_with(302, &[("location", "/same")], "")),
            Ok(response_with(
                302,
                &[("location", "https://other.test/x")],
                "",
            )),
            Ok(response_with(200, &[], "done")),
        ]);
        let request = get("https://example.test/start")
            .header("authorization", "Bearer t")
            .header("cookie", "s=1");
        let guarded = fetch_with_ssrf_guard(&transport, &public_resolver(), request, 3)
            .await
            .expect("final response");
        let sent = transport.requests();
        assert!(
            sent[1].headers.contains_key("authorization"),
            "same origin keeps it"
        );
        assert!(!sent[2].headers.contains_key("authorization"));
        assert!(!sent[2].headers.contains_key("cookie"));
        assert_eq!(guarded.url, "https://other.test/x");
        assert_eq!(guarded.response.body, "done");
    }

    #[tokio::test]
    async fn an_exhausted_deadline_sends_nothing() {
        let transport = FakeTransport::with(vec![]);
        let error = fetch_with_ssrf_guard(
            &transport,
            &public_resolver(),
            HttpRequest::get("https://example.test/").timeout_ms(0),
            DEFAULT_MAX_REDIRECTS,
        )
        .await
        .unwrap_err();
        assert_eq!(error, NetError::Http(HttpError::Timeout));
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn body_limit_checks_the_declared_and_the_actual_size() {
        let declared = response_with(200, &[("content-length", "9999")], "x");
        assert_eq!(
            check_body_limit(&declared, 100),
            Err(NetError::BodyTooLarge(100))
        );
        let actual = response_with(200, &[], &"a".repeat(101));
        assert_eq!(
            check_body_limit(&actual, 100),
            Err(NetError::BodyTooLarge(100))
        );
        let exact = response_with(200, &[("content-length", "100")], &"a".repeat(100));
        assert!(check_body_limit(&exact, 100).is_ok());
    }

    /// Each hop is pinned to the address the host check resolved, so the connection cannot be
    /// sent somewhere the check did not look.
    #[tokio::test]
    async fn each_hop_is_pinned_to_the_checked_address() {
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], "hello"))]);
        fetch_with_ssrf_guard(
            &transport,
            &public_resolver(),
            get("https://example.test"),
            DEFAULT_MAX_REDIRECTS,
        )
        .await
        .expect("guarded fetch");
        assert_eq!(
            transport.requests()[0].resolve_to,
            Some(SocketAddr::from(([93, 184, 216, 34], 443)))
        );
    }
}
