/** Node wire adapter. Core owns provider policy; this adapter owns DNS/socket identity. */
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Transport, TransportRequest, TransportResult } from "@superbee/core/source-engine";

function ipv6(value: string): bigint | null {
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] => part ? part.split(":") : [];
  const left = groups(halves[0]!), right = groups(halves[1] ?? "");
  const expand = (parts: string[]): string[] => parts.flatMap(p => p.includes(".") ? (() => { const n = p.split(".").map(Number); return [((n[0]! << 8) | n[1]!).toString(16), ((n[2]! << 8) | n[3]!).toString(16)]; })() : [p]);
  const a = expand(left), b = expand(right);
  const all = halves.length === 2 ? [...a, ...Array(Math.max(0, 8-a.length-b.length)).fill("0"), ...b] : a;
  return all.length === 8 ? all.reduce((n, p) => (n << 16n) | BigInt(`0x${p}`), 0n) : null;
}
const in6 = (n: bigint, prefix: bigint, bits: number): boolean => (n >> BigInt(128-bits)) === (prefix >> BigInt(128-bits));
/** Closed public-unicast policy: mapped IPv4 is checked by the IPv4 table. */
export function publicSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split(".").map(Number), a = p[0]!, b = p[1]!, c = p[2]!;
    return !(address === "168.63.129.16" || a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || address.includes("%")) return false;
  const n = ipv6(address);
  if (n === null) return false;
  if ((n >> 32n) === 0xffffn) return publicSourceAddress([24n,16n,8n,0n].map(s => Number((n >> s) & 255n)).join("."));
  // Admit global unicast only; exclude IETF special-purpose and documentation space.
  return in6(n, 0x20000000000000000000000000000000n, 3)
    && !in6(n, 0x20010000000000000000000000000000n, 23)
    && !in6(n, 0x20010db8000000000000000000000000n, 32)
    && !in6(n, 0x20020000000000000000000000000000n, 16)
    && !in6(n, 0x3fff0000000000000000000000000000n, 20);
}
export interface SourceWireResponse { status: number; headers: Readonly<Record<string,string>>; chunks: AsyncIterable<Uint8Array>; destroy(): void }
export interface SourceWireOptions { url: URL; address: string; family: number; headers: Record<string,string>; input: TransportRequest }
export type SourceWire = (options: SourceWireOptions) => Promise<SourceWireResponse>;
/** Actual HTTPS construction is exported so injected peers can inspect the socket's DNS/TLS contract. */
export function sourceHttpsOptions(options: SourceWireOptions): RequestOptions & {autoSelectFamily:false} {
  return { protocol: "https:", hostname: options.url.hostname, port: 443, servername: options.url.hostname,
    path: options.url.pathname + options.url.search, method: options.input.method, headers: options.headers,
    agent: false, autoSelectFamily: false, rejectUnauthorized: true, maxHeaderSize: 32 * 1024,
    signal: options.input.signal,
    lookup: (_name, _options, callback) => callback(null, options.address, options.family),
  };
}
const wire: SourceWire = options => new Promise((resolve, reject) => {
  const req = request(sourceHttpsOptions(options), (res: IncomingMessage) => {
    const headers: Record<string,string> = {};
    for (const [key,value] of Object.entries(res.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    resolve({ status: res.statusCode ?? 0, headers, chunks: res, destroy: () => res.destroy() });
  });
  req.on("error", reject);
  req.end(options.input.body);
});
export interface NodeSourceTransportOptions {
  credential?: { hosts: readonly string[]; header: string; value: string };
  /** Trusted constructor seams for deterministic conformance; never CLI flags. */
  resolve?: (host: string) => Promise<readonly {address:string;family:number}[]>;
  wire?: SourceWire;
}
export function nodeSourceTransport(options: NodeSourceTransportOptions = {}): Transport {
  return { async request(input): Promise<TransportResult> {
    let response: SourceWireResponse | undefined;
    try {
      const url = new URL(input.url);
      if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error();
      input.signal?.throwIfAborted();
      const resolving = (options.resolve ?? (host => lookup(host, {all:true})))(url.hostname);
      const answers = await new Promise<readonly {address:string;family:number}[]>((resolve,reject) => {
        const signal = input.signal;
        const abort = (): void => reject(new Error("source transport aborted"));
        signal?.addEventListener("abort", abort, {once:true});
        resolving.then(resolve,reject).finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
        if (signal?.aborted) abort();
      });
      input.signal?.throwIfAborted();
      if (!answers.length || answers.some(a => !publicSourceAddress(a.address) || isIP(a.address) !== a.family)) throw new Error();
      const selected = answers[0]!;
      const headers: Record<string,string> = {...input.headers, "accept-encoding":"identity"};
      // Never trust a caller-supplied credential header, even in direct conformance calls.
      for (const name of Object.keys(headers)) if (["authorization","cookie","proxy-authorization","host", options.credential?.header.toLowerCase()].includes(name.toLowerCase())) delete headers[name];
      const c = options.credential;
      if (c && input.credentialHost && c.hosts.includes(url.hostname) && !url.hostname.endsWith(".")) headers[c.header.toLowerCase()] = c.value;
      response = await (options.wire ?? wire)({url, address:selected.address, family:selected.family, headers, input});
      input.signal?.throwIfAborted();
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([k,v]) => [k.toLowerCase(),v]));
      if (responseHeaders["content-encoding"] && responseHeaders["content-encoding"] !== "identity") throw new Error();
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of response.chunks) {
        input.signal?.throwIfAborted(); bytes += chunk.byteLength;
        if (bytes > input.maxBytes) { response.destroy(); return {ok:false,refused:"too_large"}; }
        chunks.push(Buffer.from(chunk));
      }
      return {ok:true,status:response.status,headers:responseHeaders,body:Buffer.concat(chunks).toString("utf8"),bytes};
    } catch { response?.destroy(); throw new Error("source transport unavailable"); }
  }};
}
