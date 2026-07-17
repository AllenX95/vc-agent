import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { load } from "cheerio";
import type { ContextReference } from "@vc-agent/contracts";
import type { BoundedRecallEnvelope, RecallContext, RecallSource } from "./recall.js";

export type PublicWebQuery =
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "fetch"; readonly url: string };

export interface PublicWebItem {
  readonly url: string;
  readonly title?: string;
  readonly accessedAt: string;
  readonly content: string;
}

export interface PublicWebAccess {
  fetch(input: string, init: RequestInit): Promise<Response>;
  resolve(hostname: string): Promise<readonly string[]>;
}

const defaultAccess: PublicWebAccess = {
  fetch: (input, init) => fetch(input, init),
  resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address)
};

export class PublicWebRecallSource implements RecallSource<PublicWebQuery, PublicWebItem> {
  readonly sourceClass = "web" as const;
  readonly #access: PublicWebAccess;

  constructor(access: PublicWebAccess = defaultAccess) { this.#access = access; }

  async recall(query: PublicWebQuery, context: RecallContext): Promise<BoundedRecallEnvelope<PublicWebItem>> {
    const accessedAt = context.retrievedAt;
    try {
      if (query.kind === "search") return await this.#search(query.query, context, accessedAt);
      return await this.#fetch(query.url, context, accessedAt);
    } catch (error) {
      const safeUrl = query.kind === "fetch" ? safeReferenceUrl(query.url) : undefined;
      const sourceId = safeUrl ?? `search:${hash(query.kind === "fetch" ? query.url : query.query)}`;
      return webEnvelope(query.kind, [], false, 0, [safeMessage(error)], reference(sourceId, safeUrl ?? (query.kind === "search" ? query.query : "Unavailable public URL"), query.kind, query.kind === "fetch" ? "web_fetch" : "web_search", context, "source_unavailable"));
    }
  }

  async #search(query: string, context: RecallContext, accessedAt: string): Promise<BoundedRecallEnvelope<PublicWebItem>> {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const response = await requestPublic(searchUrl, this.#access);
    if (!response.contentType.includes("html")) throw new Error(`Search returned unsupported content type: ${response.contentType || "unknown"}`);
    const $ = load(new TextDecoder().decode(response.body));
    const resultCount = $("li.b_algo").length;
    const items: PublicWebItem[] = [];
    let usedChars = 0;
    $("li.b_algo").each((_index, element) => {
      if (items.length >= context.maxItems || usedChars >= context.maxChars) return false;
      const anchor = $(element).find("h2 a").first();
      const rawUrl = anchor.attr("href");
      if (rawUrl === undefined) return;
      const url = normalizeSearchResultUrl(rawUrl);
      if (url === undefined || url.length > 1_000) return;
      const title = normalizeText(anchor.text()).slice(0, 300);
      const snippet = normalizeText($(element).find(".b_caption p").first().text());
      const remaining = context.maxChars - usedChars;
      const content = snippet.slice(0, remaining);
      if (content.length === 0) return;
      usedChars += content.length;
      items.push({ url, ...(title.length === 0 ? {} : { title }), accessedAt, content });
    });
    const omitted = Math.max(0, resultCount - items.length);
    const warnings = items.length === 0
      ? ["Search returned no parseable public results."]
      : omitted === 0 ? [] : [`${omitted} search result(s) omitted by the bounded retrieval envelope.`];
    return webEnvelope("search", items, items.length > 0 && omitted === 0, omitted, warnings, reference(`search:${hash(query)}`, query, "search-results", "web_search", context, items.length > 0 ? "active" : "source_unavailable"));
  }

  async #fetch(url: string, context: RecallContext, accessedAt: string): Promise<BoundedRecallEnvelope<PublicWebItem>> {
    const response = await requestPublic(url, this.#access);
    let title: string | undefined;
    let extracted: string;
    let sourceRange = "document";
    const warnings: string[] = [];
    if (response.contentType.includes("pdf")) {
      const pdf = await extractPdf(response.body, context.maxChars);
      extracted = pdf.content;
      sourceRange = `pages 1-${pdf.pagesRead}`;
      if (!pdf.complete) warnings.push("Additional PDF pages or text were omitted by the bounded retrieval envelope.");
    } else if (response.contentType.includes("html") || response.contentType.includes("xhtml")) {
      const $ = load(new TextDecoder().decode(response.body));
      title = normalizeText($("title").first().text()) || undefined;
      $("script,style,noscript,svg,form,input,button,nav,footer").remove();
      extracted = normalizeText($("main,article").first().text() || $("body").text());
    } else if (response.contentType.startsWith("text/")) {
      extracted = normalizeText(new TextDecoder().decode(response.body));
    } else throw new Error(`Unsupported public content type: ${response.contentType || "unknown"}`);
    const complete = extracted.length <= context.maxChars && warnings.length === 0;
    const content = extracted.slice(0, context.maxChars);
    if (extracted.length > content.length) warnings.push("Page content was truncated by the bounded retrieval envelope.");
    const item: PublicWebItem = { url: response.url, ...(title === undefined ? {} : { title }), accessedAt, content };
    return webEnvelope("fetch", [item], complete && warnings.length === 0, warnings.length === 0 ? 0 : 1, warnings, reference(response.url, title ?? response.url, sourceRange, "web_fetch", context, "active"));
  }
}

async function requestPublic(initialUrl: string, access: PublicWebAccess): Promise<{ url: string; contentType: string; body: Uint8Array }> {
  let current = new URL(initialUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    await assertPublicUrl(current, access);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await access.fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: { accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9", "user-agent": "vc-agent/0.1 public-read" }
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) throw new Error(`Public fetch redirect ${response.status} omitted Location.`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`Public fetch failed with HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > 8_000_000) throw new Error("Public response exceeds the 8 MB limit.");
      const body = await readBoundedBody(response, 8_000_000);
      return { url: current.toString(), contentType: (response.headers.get("content-type") ?? "").toLowerCase(), body };
    } finally { clearTimeout(timeout); }
  }
  throw new Error("Public fetch exceeded the redirect limit.");
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
        throw new Error("Public response exceeds the 8 MB limit.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function assertPublicUrl(url: URL, access: PublicWebAccess): Promise<void> {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") throw new Error("Only unauthenticated public HTTP(S) URLs are allowed.");
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new Error("Non-standard URL ports are unavailable.");
  const addresses = isIP(url.hostname) === 0 ? await access.resolve(url.hostname) : [url.hostname];
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new Error("The URL resolves to a non-public network address.");
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

async function extractPdf(body: Uint8Array, maxChars: number): Promise<{ content: string; pagesRead: number; complete: boolean }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: body });
  const document = await task.promise;
  const chunks: string[] = [];
  let pagesRead = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const pageText = normalizeText(text.items.map((item) => "str" in item ? item.str : "").join(" "));
      if (chunks.join("\n").length + pageText.length > maxChars) {
        if (chunks.length === 0) {
          chunks.push(pageText.slice(0, maxChars));
          pagesRead = pageNumber;
        }
        break;
      }
      chunks.push(pageText);
      pagesRead = pageNumber;
    }
    return { content: chunks.join("\n"), pagesRead, complete: pagesRead === document.numPages };
  } finally { await task.destroy(); }
}

function webEnvelope(
  disclosureLevel: "search" | "fetch",
  items: readonly PublicWebItem[],
  complete: boolean,
  omittedItems: number,
  warnings: readonly string[],
  contextReference: ContextReference
): BoundedRecallEnvelope<PublicWebItem> {
  return { schemaVersion: 1, sourceClass: "web", disclosureLevel, items, complete, omittedItems, warnings, contextReference };
}

function reference(sourceId: string, label: string, sourceRange: string, originatingTool: "web_search" | "web_fetch", context: RecallContext, status: ContextReference["status"]): ContextReference {
  return { schemaVersion: 1, sourceClass: "web", sourceId, label, sourceRange, originatingTool, originatingTurnId: context.turnId, retrievedAt: context.retrievedAt, status };
}

function normalizeSearchResultUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw, "https://www.bing.com");
    const encoded = url.hostname.endsWith("bing.com") ? url.searchParams.get("u") : null;
    let destination = url.toString();
    if (encoded?.startsWith("a1")) {
      try { destination = Buffer.from(encoded.slice(2), "base64url").toString("utf8"); }
      catch { destination = url.toString(); }
    }
    const result = new URL(destination);
    return result.protocol === "http:" || result.protocol === "https:" ? result.toString() : undefined;
  } catch { return undefined; }
}

function normalizeText(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : "Public web access failed.").slice(0, 500); }
function safeReferenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function detectWebResearchIntent(text: string): boolean {
  const url = /https?:\/\/\S+/iu.test(text);
  const english = /\b(search|browse|look up|latest|current|news|public web|online research|web research)\b/iu.test(text);
  const chinese = /(搜索|上网查|联网查|查找最新|最新新闻|网页|公开网络|网络调研|实时资料)/u.test(text);
  return url || english || chinese;
}
