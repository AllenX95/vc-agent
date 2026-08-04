import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionInventorySnapshot } from "@vc-agent/contracts";

export const PI_WEB_ACCESS_VERSION = "0.17.0";
export const PI_WEB_ACCESS_TOOL_NAMES = Object.freeze(["web_search", "source_check", "web_fetch", "web_fetch_content"]);
const PI_WEB_ACCESS_CONFIG_FILE = "web-search.json";
const moduleRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : resolve(process.argv[1] ?? process.cwd(), process.argv[1] === undefined ? "package.json" : "")
);

type ExtensionEntry = Readonly<Omit<ExtensionInventorySnapshot["enabled"][number], "toolNames"> & { readonly toolNames?: readonly string[] }>;
type PiWebAccessConfig = Record<string, unknown>;

export interface ExtensionLoadPreflight {
  readonly revisionId: string;
  readonly accepted: readonly ExtensionEntry[];
  readonly rejected: readonly { readonly id: string; readonly code: string; readonly message: string }[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly sourceId?: string }[];
}

export function bundledPiWebAccessEntry(): ExtensionInventorySnapshot["enabled"][number] {
  const packagePath = moduleRequire.resolve("pi-web-access/package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown; pi?: { extensions?: unknown } };
  if (packageJson.version !== PI_WEB_ACCESS_VERSION) throw new Error("EXTENSION_ENTRY_NOT_APPROVED: bundled pi-web-access version mismatch");
  const relativeEntry = Array.isArray(packageJson.pi?.extensions) && typeof packageJson.pi.extensions[0] === "string" ? packageJson.pi.extensions[0] : undefined;
  if (relativeEntry === undefined) throw new Error("EXTENSION_ENTRY_NOT_APPROVED: bundled pi-web-access entry is unavailable");
  const entryPath = realpathSync(resolve(dirname(packagePath), relativeEntry));
  const integrity = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
  return { id: "pi-web-access", version: PI_WEB_ACCESS_VERSION, entryPath, integrity, trust: "bundled-reviewed", toolNames: [...PI_WEB_ACCESS_TOOL_NAMES] };
}

/** Inspect immutable Extension metadata and bytes without evaluating Extension code. */
export function inspectExtensionEntries(revisionId: string, rawEntries: readonly ExtensionEntry[], inspectWebConfig: boolean): ExtensionLoadPreflight {
  const accepted: ExtensionEntry[] = [];
  const rejected: { id: string; code: string; message: string }[] = [];
  const claimedNames = new Map<string, string>();
  for (const rawEntry of rawEntries) {
    const derived = rawEntry.toolNames === undefined ? inspectLiteralToolNames(rawEntry.entryPath) : undefined;
    const entry: ExtensionEntry = rawEntry.toolNames === undefined ? { ...rawEntry, toolNames: derived?.toolNames ?? [] } : rawEntry;
    if (derived?.dynamicWithoutInventory === true) {
      rejected.push({ id: entry.id, code: "EXTENSION_TOOL_INVENTORY_UNAVAILABLE", message: "Extension tool names cannot be determined without executing code." });
      continue;
    }
    const rejection = inspectExtensionEntry(entry);
    if (rejection !== undefined) { rejected.push({ id: entry.id, ...rejection }); continue; }
    let collision: string | undefined;
    for (const name of entry.toolNames ?? []) {
      const prior = claimedNames.get(name);
      if (prior !== undefined && prior !== entry.id) { collision = name; break; }
      claimedNames.set(name, entry.id);
    }
    if (collision !== undefined) rejected.push({ id: entry.id, code: "RUNTIME_CAPABILITY_COLLISION", message: `Extension tool '${collision}' is already claimed by another admitted source.` });
    else accepted.push(entry);
  }
  return { revisionId, accepted, rejected, diagnostics: inspectWebConfig ? preparePiWebAccessConfig(false) : [] };
}

export function preparePiWebAccessConfig(write: boolean): { readonly code: string; readonly message: string; readonly sourceId: string }[] {
  const configuredRoot = process.env.VC_AGENT_USER_DATA_DIR?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const appDataRoot = configuredRoot || (localAppData === undefined || localAppData.length === 0 ? join(tmpdir(), "vc-agent") : join(localAppData, "vc-agent"));
  const configDirectory = join(appDataRoot, "integrations", "pi-web-access");
  const configPath = join(configDirectory, PI_WEB_ACCESS_CONFIG_FILE);
  mkdirSync(configDirectory, { recursive: true });
  let config: PiWebAccessConfig = {};
  const diagnostics: { code: string; message: string; sourceId: string }[] = [];
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) config = { ...(parsed as PiWebAccessConfig) };
    } catch {
      diagnostics.push({ code: "WEB_CONFIGURATION_INVALID", message: "The pi-web-access configuration is invalid; safe explicit defaults will be used and the prior file retained as a backup.", sourceId: "pi-web-access" });
    }
  }
  const configuredToolNames = config.toolNames !== null && typeof config.toolNames === "object" && !Array.isArray(config.toolNames) ? { ...(config.toolNames as PiWebAccessConfig) } : {};
  const nextConfig: PiWebAccessConfig = { ...config, workflow: "none", autoOpenBrowser: false, allowBrowserCookies: false, toolNames: { ...configuredToolNames, webSearch: "web_search", sourceCheck: "source_check", fetchContent: "web_fetch", getSearchContent: "web_fetch_content" } };
  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (write && (!existsSync(configPath) || readFileSync(configPath, "utf8") !== serialized)) {
    if (existsSync(configPath) && !existsSync(configPath + ".bak")) copyFileSync(configPath, configPath + ".bak");
    writeFileSync(configPath, serialized, "utf8");
  }
  if (write) process.env.PI_CODING_AGENT_DIR = configDirectory;
  return diagnostics;
}

function inspectLiteralToolNames(entryPath: string): { toolNames: string[]; dynamicWithoutInventory: boolean } | undefined {
  try {
    const source = readFileSync(resolve(entryPath), "utf8");
    const toolNames = [...source.matchAll(/\.registerTool\s*\(\s*\{[\s\S]{0,2000}?\bname\s*:\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1]!);
    return { toolNames: [...new Set(toolNames)].sort(), dynamicWithoutInventory: /\.registerTool\s*\(/u.test(source) && toolNames.length === 0 };
  } catch { return undefined; }
}

function inspectExtensionEntry(entry: ExtensionEntry): { readonly code: string; readonly message: string } | undefined {
  if (entry.version.length === 0 || entry.integrity.length === 0) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "An enabled Extension is missing its immutable version or integrity identity." };
  if (entry.trust !== "bundled-reviewed" && entry.trust !== "approved-trusted") return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "Only reviewed bundled or separately approved Extension revisions may load." };
  const candidate = resolve(entry.entryPath);
  if (candidate.toLowerCase().split(sep).includes("staged")) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "Staged Extension paths are never executable." };
  try {
    const realEntry = realpathSync(candidate);
    if (resolve(realEntry).toLowerCase() !== resolve(candidate).toLowerCase()) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "The exact Extension entry path resolves through a symlink and is not executable." };
    if (!statSync(realEntry).isFile()) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "The exact Extension entry path is not a file." };
    const actualEntryHash = createHash("sha256").update(readFileSync(realEntry)).digest("hex");
    const actualDirectoryHash = entry.trust === "bundled-reviewed" ? undefined : hashDirectory(findArtifactRoot(realEntry));
    if (entry.integrity !== actualDirectoryHash && entry.integrity !== actualEntryHash && entry.integrity !== `sha256-${actualEntryHash}`) return { code: "EXTENSION_ARTIFACT_CHANGED", message: "The exact Extension entry no longer matches its approved integrity identity." };
  } catch { return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "The exact approved Extension entry path is unavailable." }; }
  return undefined;
}

function findArtifactRoot(entryPath: string): string {
  let current = dirname(entryPath);
  for (let index = 0; index < 32; index += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirname(entryPath);
}

function hashDirectory(root: string): string {
  const files: string[] = [];
  visit(root);
  const inventory = files.sort().map((file) => {
    const path = join(root, file);
    const stat = statSync(path);
    return `${file}\u0000${stat.size}\u0000${stat.mode & 0o777}\u0000${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  }).join("\n");
  return createHash("sha256").update(inventory, "utf8").digest("hex");
  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const child = join(directory, entry);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) files.push(relative(root, child).split(sep).join("/"));
    }
  }
}
