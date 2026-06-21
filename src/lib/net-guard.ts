/**
 * Network egress guard — shared SSRF helper.
 *
 * Two SSRF surfaces in this codebase build their own private-host check:
 *   - `validateSearxngUrl` (src/modules/search/engines.ts) — fetches an
 *     arbitrary, user/tenant-supplied SearXNG base URL. No allowlist, so a
 *     bypass here is a *reachable* SSRF (probe internal services, hit cloud
 *     metadata at 169.254.169.254).
 *   - `validateDownloadUrl` (src/modules/image/index.ts) — has a CDN
 *     allowlist on top, but still runs the private-host check as a layer.
 *
 * Both previously matched a regex against `url.hostname`. That misses the
 * IPv6-mapped-IPv4 form: `https://[::ffff:169.254.169.254]/…` normalises to
 * hostname `[::ffff:a9fe:a9fe]`, which `/^169\.254\./` never matches — a
 * textbook SSRF-to-metadata bypass. Decimal / octal / hex IPv4 (`2130706433`,
 * `0x7f000001`, `0177.0.0.1`, `127.1`) are *not* a problem because the WHATWG
 * URL parser normalises those to dotted-quad before we see `hostname`, but the
 * v6-mapped form is left untouched.
 *
 * This module centralises the check so both surfaces share one correct,
 * tested implementation.
 */

/** Strip the surrounding brackets the URL parser keeps on IPv6 hostnames. */
function unwrapIpv6(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * If `host` is (or embeds) an IPv4 address, return it in dotted-quad form.
 * Handles the plain dotted form and the IPv6-mapped/compat forms
 * (`::ffff:a.b.c.d`, `::ffff:7f00:1`, `::a.b.c.d`). Returns undefined when the
 * host is not an IPv4 / v4-mapped address (e.g. a real DNS name or a genuine
 * global IPv6 address).
 */
export function extractIpv4(rawHost: string): string | undefined {
  const host = unwrapIpv6(rawHost.toLowerCase());

  // Already dotted-quad (URL parser normalises decimal/hex/octal to this).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;

  // IPv6-mapped/compat IPv4 with the embedded address in dotted form:
  //   ::ffff:127.0.0.1   /   ::127.0.0.1
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];

  // IPv6-mapped IPv4 with the address as two hex groups:
  //   ::ffff:7f00:1  ->  127.0.0.1
  //   ::ffff:a9fe:a9fe -> 169.254.169.254
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }

  return undefined;
}

/** True when a dotted-quad IPv4 string falls in a private / reserved range. */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Not a parseable IPv4 — caller decides; treat as "not provably private".
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||                                   // 0.0.0.0/8 ("this host")
    a === 10 ||                                  // 10.0.0.0/8
    a === 127 ||                                 // 127.0.0.0/8 loopback
    (a === 169 && b === 254) ||                  // 169.254.0.0/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||         // 172.16.0.0/12
    (a === 192 && b === 168) ||                  // 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) ||        // 100.64.0.0/10 CGNAT
    a >= 224                                      // 224.0.0.0/4 multicast + 240/4 reserved
  );
}

/**
 * Decide whether a URL hostname points at a private / internal / loopback
 * destination that must never be fetched server-side.
 *
 * Covers: literal loopback names, `.localhost` / `.local` / `.internal`
 * suffixes, all private + reserved IPv4 ranges (including via decimal/hex/octal
 * normalisation done by the URL parser), IPv6 loopback / ULA / link-local, and
 * — the gap this module exists to close — IPv6-mapped IPv4 addresses.
 */
export function isPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  const bare = unwrapIpv6(hostname);

  // Hostname-based loopback / internal suffixes.
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return true;
  }

  // IPv6 loopback / ULA / link-local (also when bracket-wrapped).
  if (
    bare === '::1' ||
    bare === '::' ||
    /^fc[0-9a-f]{2}:/i.test(bare) ||  // fc00::/7 ULA (fc / fd)
    /^fd[0-9a-f]{2}:/i.test(bare) ||
    /^fe80:/i.test(bare)              // link-local
  ) {
    return true;
  }

  // IPv4, including v6-mapped IPv4 and decimal/hex/octal (already normalised).
  const ipv4 = extractIpv4(hostname);
  if (ipv4) return isPrivateIpv4(ipv4);

  return false;
}
