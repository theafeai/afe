import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";

/**
 * Policy for outbound requests to user-supplied endpoints (ArgoCD server URL,
 * alert webhook URL, self-hosted GitHub Enterprise URL, ...).
 */
export interface OutboundUrlPolicy {
  /**
   * Allow private, loopback and CGNAT/ULA addresses. Self-host only, and only
   * when the operator opts in (`AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`), because
   * ArgoCD is often reachable only inside the cluster or VPN. Must stay false in
   * the hosted multi-tenant service.
   */
  allowPrivateNetworks?: boolean;
  /** Allow plain `http:`. Only together with `allowPrivateNetworks` in self-host. */
  allowInsecureHttp?: boolean;
  /** DNS resolver; defaults to the system resolver. Injected in tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export type AddressClass = "public" | "private" | "blocked";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

// Never reachable, whatever the policy: link-local (incl. cloud metadata
// endpoints), unspecified, multicast, broadcast and reserved ranges.
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
ALWAYS_BLOCKED.addSubnet("192.0.0.0", 24, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata
// Unspecified and deprecated IPv4-compatible addresses (::a.b.c.d); ::1 is
// handled separately as loopback below.
ALWAYS_BLOCKED.addSubnet("::", 96, "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6");
ALWAYS_BLOCKED.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6

const IPV6_LOOPBACK = new BlockList();
IPV6_LOOPBACK.addAddress("::1", "ipv6");

// Internal networks: allowed only with `allowPrivateNetworks`.
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
// Translation prefixes can embed any IPv4 address; treat as internal.
PRIVATE.addSubnet("64:ff9b::", 96, "ipv6");
PRIVATE.addSubnet("64:ff9b:1::", 48, "ipv6");
PRIVATE.addSubnet("2002::", 16, "ipv6");

/** Classifies an IP address literal. Non-IP input is "blocked". */
export function classifyAddress(address: string): AddressClass {
  let ip = address.replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:7f00:1) -> classify the IPv4 address.
  const mapped = /^::ffff:(?:0+:)?(.+)$/i.exec(ip);
  if (mapped && isIP(ip) === 6) {
    const tail = mapped[1]!;
    if (isIP(tail) === 4) ip = tail;
    else {
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
      if (m) {
        const hi = parseInt(m[1]!, 16);
        const lo = parseInt(m[2]!, 16);
        ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
    }
  }
  const family = isIP(ip);
  if (family === 0) return "blocked";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (type === "ipv6" && IPV6_LOOPBACK.check(ip, type)) return "private";
  if (ALWAYS_BLOCKED.check(ip, type)) return "blocked";
  if (PRIVATE.check(ip, type)) return "private";
  return "public";
}

function isAllowed(address: string, policy: OutboundUrlPolicy): boolean {
  const cls = classifyAddress(address);
  return cls === "public" || (cls === "private" && policy.allowPrivateNetworks === true);
}

const systemResolve = (hostname: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/**
 * Validates a user-supplied endpoint URL before Afe stores it or calls it.
 *
 * - `https:` only (or `http:` when `allowInsecureHttp` and `allowPrivateNetworks`);
 * - no embedded credentials (`user:pass@`) and no fragment;
 * - every address the host resolves to must be allowed by the policy.
 *
 * Resolving at validation time does not stop DNS rebinding; the HTTP client
 * must also use `createSafeLookup(policy)` so the check is repeated for the
 * address actually connected to, and must not follow redirects to other hosts.
 */
export async function validateOutboundUrl(
  input: string,
  policy: OutboundUrlPolicy = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError("not a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    const httpOk =
      url.protocol === "http:" && policy.allowInsecureHttp === true && policy.allowPrivateNetworks;
    if (!httpOk) throw new UnsafeUrlError("URL must use https");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URL must not contain credentials; configure a token instead");
  }
  if (url.hash) throw new UnsafeUrlError("URL must not contain a fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("URL has no host");

  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await (policy.resolve ?? systemResolve)(host);
    } catch {
      throw new UnsafeUrlError(`host ${host} could not be resolved`);
    }
    if (addresses.length === 0) throw new UnsafeUrlError(`host ${host} could not be resolved`);
  }
  for (const address of addresses) {
    if (!isAllowed(address, policy)) {
      throw new UnsafeUrlError(
        classifyAddress(address) === "private"
          ? `host ${host} resolves to a private address; private network targets are disabled`
          : `host ${host} resolves to a disallowed address`,
      );
    }
  }
  return url;
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` function for `net`/`tls`/`http(s)` agents and undici's
 * `connect.lookup` that refuses to connect to addresses the policy disallows.
 * This defeats DNS rebinding between validation and connection.
 */
export function createSafeLookup(policy: OutboundUrlPolicy = {}) {
  const resolveAll = policy.resolve ?? systemResolve;
  return (hostname: string, options: { all?: boolean } | undefined, callback: LookupCallback) => {
    const host = hostname.replace(/^\[|\]$/g, "");
    const pending = isIP(host) !== 0 ? Promise.resolve([host]) : resolveAll(host);
    pending.then(
      (addresses) => {
        const bad = addresses.find((a) => !isAllowed(a, policy));
        if (bad !== undefined || addresses.length === 0) {
          const err: NodeJS.ErrnoException = new UnsafeUrlError(
            `refusing to connect to ${host}: address not allowed`,
          );
          err.code = "EAFE_UNSAFE_ADDRESS";
          callback(err, "");
          return;
        }
        const results = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options?.all) callback(null, results);
        else callback(null, results[0]!.address, results[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}
