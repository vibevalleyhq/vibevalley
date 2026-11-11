import { lookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

type Resolve = (host: string, done: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

// The socket uses these checked addresses, not a second DNS lookup. IPv6 is deliberately not dialed.
export const publicLookup =
  (resolve: Resolve): LookupFunction =>
  (hostname, options, done) => {
    resolve(hostname, (error, addresses) => {
      if (error || addresses.length === 0 || addresses.some((address) => address.family !== 4 || !publicIpv4(address.address))) {
        done(new Error("Public IPv4 resolution required"), []);
        return;
      }
      const first = addresses[0];
      if (!first) {
        done(new Error("No public address"), []);
        return;
      }
      if (options.all === true) done(null, addresses);
      else done(null, first.address, first.family);
    });
  };

export function publicHttps(url: URL): boolean {
  const host = url.hostname;
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    (!url.port || url.port === "443") &&
    !host.startsWith("[") &&
    (isIP(host) === 0 || publicIpv4(host))
  );
}

/** A fetch that reaches only the public internet: every name is resolved to public IPv4 addresses (and the socket dials
 * those, not a second lookup), so a URL a model or a user gave cannot reach this machine or its network. */
export type PublicFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export function publicFetch(resolve: Resolve = (host, done) => lookup(host, { all: true, family: 4 }, done)): PublicFetch {
  const dispatcher = new Agent({ connect: { lookup: publicLookup(resolve) }, keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undici's fetch is the platform's, with a dispatcher the global one cannot take
  return (url, init) => undiciFetch(url, { ...(init as object), dispatcher });
}
