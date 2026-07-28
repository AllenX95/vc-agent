import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface AcademicHttpResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  text(): string;
  json(): unknown;
}

export interface AcademicHttpAccess {
  request(input: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  }): Promise<AcademicHttpResponse>;
}

export const ACADEMIC_SOURCE_HOSTS = new Set([
  "api.openalex.org",
  "export.arxiv.org",
  "arxiv.org",
  "api.github.com",
  "huggingface.co"
]);

export class DefaultAcademicHttpAccess implements AcademicHttpAccess {
  async request(input: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  }): Promise<AcademicHttpResponse> {
    let current = new URL(input.url);
    const maxBytes = input.maxBytes ?? 4_000_000;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      await assertAcademicUrl(current);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
      const abort = () => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
          headers: {
            accept: "application/json,application/atom+xml,text/plain;q=0.9,application/pdf;q=0.8",
            "user-agent": "vc-agent/0.1 academic-research",
            ...(input.headers ?? {})
          }
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null) throw new Error(`ACADEMIC_REDIRECT_MISSING:${response.status}`);
          current = new URL(location, current);
          continue;
        }
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > maxBytes) throw new Error("ACADEMIC_RESPONSE_TOO_LARGE");
        const body = await readBoundedBody(response, maxBytes);
        return {
          url: current.toString(),
          status: response.status,
          headers: response.headers,
          body,
          text: () => new TextDecoder().decode(body),
          json: () => JSON.parse(new TextDecoder().decode(body)) as unknown
        };
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
      }
    }
    throw new Error("ACADEMIC_REDIRECT_LIMIT");
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("ACADEMIC_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function assertAcademicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")) {
    throw new Error("ACADEMIC_URL_REJECTED");
  }
  if (!ACADEMIC_SOURCE_HOSTS.has(url.hostname.toLowerCase())) throw new Error("ACADEMIC_HOST_REJECTED");
  const addresses = isIP(url.hostname) === 0 ? (await lookup(url.hostname, { all: true, verbatim: true })).map((item) => item.address) : [url.hostname];
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new Error("ACADEMIC_NON_PUBLIC_ADDRESS");
}

function isPublicAddress(address: string): boolean {
  if (address.includes(".")) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) || (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const normalized = address.toLowerCase();
  return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd") && !/^fe[89ab]/u.test(normalized) && !normalized.startsWith("ff") && !normalized.startsWith("2001:db8:");
}
