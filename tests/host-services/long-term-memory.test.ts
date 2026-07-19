import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LongTermMemoryRecallSource, LongTermMemoryStore, detectExplicitMemoryRecallIntent, detectJudgmentHeavyIntent, parseLongTermMemory } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "vc-agent-ltm-"));
  temporaryDirectories.push(directory);
  return { directory, store: new LongTermMemoryStore(join(directory, "memory", "long-term")) };
}

const activeMemory = `# Long-term Memory

Schema-Version: 1

## 2026-07-19 - Conservative TAM framing
ID: ltm-tam-framing
Version: 1
Status: current
Tags: memo, market sizing
Source: reflection-approved
Scope: global
Applies To: early-stage hard tech, IC memo
Maturity: evidence-backed
Recall: automatic
Conflict: none
Limitations: Less useful after repeatable sales establish a bottom-up market.
Source References: src_ref_alpha

早期硬科技项目应保守界定可服务市场，不把远期平台市场全部计入 TAM。

## 2026-07-19 - Founder reference caution
ID: ltm-founder-reference
Version: 1
Status: current
Tags: founder, diligence
Scope: global
Applies To: seed financing, founder diligence
Maturity: user-confirmed
Recall: explicit-only
Conflict: none
Limitations: Use only when references are available.
Source References:

Treat unusually polished references as a prompt for deeper triangulation, not as proof of operating quality.
`;

describe("LongTermMemoryStore", () => {
  it("creates all transparent Memory files only after the Memory view requests them", () => {
    const { store } = createStore();
    expect(store.load(false)).toBeUndefined();
    expect(existsSync(store.markdownPath)).toBe(false);

    const document = store.load(true)!;
    expect(document.content).toContain("# Long-term Memory");
    expect(document.files.map((file) => file.name)).toEqual([
      "long-term-memory.md",
      "long-term-memory-condensation-archive.md",
      "cognitive-evolution-history.md"
    ]);
    expect(existsSync(store.indexPath)).toBe(true);
  });

  it("rejects a stale internal save after an external authoritative edit", () => {
    const { store } = createStore();
    const initial = store.load(true)!;
    writeFileSync(store.markdownPath, activeMemory, "utf8");
    expect(() => store.save("# Long-term Memory\n", initial.sourceHash)).toThrow("STALE_LONG_TERM_MEMORY_WRITE");
    expect(readFileSync(store.markdownPath, "utf8")).toBe(activeMemory);
  });

  it("preserves malformed and project-specific text while indexing only safe entries", () => {
    const content = `${activeMemory}\n## Broken\nScope: global\n\n\n## 2026-07-19 - Deal detail\nID: ltm-deal-detail\nScope: global\nApplies To: seed\nRecall: automatic\n\nCompany: Acme\nValuation: $50m\n`;
    const parsed = parseLongTermMemory(content);
    expect(parsed.entries.map((entry) => entry.id)).toEqual(["ltm-tam-framing", "ltm-founder-reference"]);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["MALFORMED_ENTRY", "PROJECT_SPECIFIC_CONTENT"]));
    expect(content).toContain("Company: Acme");
  });

  it("rebuilds a deterministic bilingual index after an external edit", async () => {
    const { store } = createStore();
    const initial = store.load(true)!;
    writeFileSync(store.markdownPath, activeMemory, "utf8");
    const refreshed = store.refreshIfExists()!;
    expect(refreshed.sourceHash).not.toBe(initial.sourceHash);
    const firstIndex = readFileSync(store.indexPath, "utf8");
    expect(JSON.parse(firstIndex)).toMatchObject({ schemaVersion: 1, sourceHash: refreshed.sourceHash });
    store.rebuild();
    expect(readFileSync(store.indexPath, "utf8")).toBe(firstIndex);

    const source = new LongTermMemoryRecallSource(store);
    const chinese = await source.recall({ mode: "automatic", disclosureLevel: "cards", query: "硬科技市场规模判断" }, recallContext());
    const english = await source.recall({ mode: "automatic", disclosureLevel: "cards", query: "market sizing memo" }, recallContext());
    expect(chinese.items.map((item) => item.id)).toContain("ltm-tam-framing");
    expect(english.items.map((item) => item.id)).toContain("ltm-tam-framing");
  });

  it("keeps explicit-only entries out of automatic recall and strips local provenance", async () => {
    const { store } = createStore();
    store.load(true);
    writeFileSync(store.markdownPath, activeMemory, "utf8");
    store.rebuild();
    const source = new LongTermMemoryRecallSource(store);
    const automatic = await source.recall({ mode: "automatic", disclosureLevel: "full", query: "founder reference diligence" }, recallContext());
    const explicit = await source.recall({ mode: "explicit", disclosureLevel: "full", query: "founder reference diligence" }, recallContext());
    expect(automatic.items).toEqual([]);
    expect(explicit.items.map((item) => item.id)).toEqual(["ltm-founder-reference"]);
    const payload = JSON.stringify(explicit);
    expect(payload).not.toContain("src_ref_alpha");
    expect(payload).not.toMatch(/projectId|projectPath|sourceReferenceIds|Company:|Valuation:/u);
    expect(payload).toContain("not source evidence");
  });

  it("sanitizes excluded-entry warnings before they enter a recall payload", async () => {
    const { store } = createStore();
    store.load(true);
    writeFileSync(store.markdownPath, `${activeMemory}\n## 2026-07-19 - Acme Corp deal lesson\nID: ltm-unsafe-acme\nScope: global\nApplies To: seed\nRecall: automatic\n\nCompany: Acme Corp\nValuation: $50m\n`, "utf8");
    store.rebuild();
    const payload = JSON.stringify(await new LongTermMemoryRecallSource(store).recall({ mode: "automatic", disclosureLevel: "cards", query: "market sizing" }, recallContext()));
    expect(payload).not.toContain("Acme");
    expect(payload).not.toContain("$50m");
    expect(payload).toContain("Project or transaction-level detail");
  });

  it("returns all sides of an unresolved conflict together", async () => {
    const { store } = createStore();
    store.load(true);
    writeFileSync(store.markdownPath, `# Long-term Memory\n\nSchema-Version: 1\n\n${conflictEntry("ltm-conflict-a", "Capital efficiency matters", "Prefer capital-efficient growth.")}\n${conflictEntry("ltm-conflict-b", "Speed can dominate efficiency", "In winner-take-most markets, speed may justify burn.")}`, "utf8");
    store.rebuild();
    const result = await new LongTermMemoryRecallSource(store).recall({ mode: "automatic", disclosureLevel: "cards", query: "capital efficiency" }, recallContext());
    expect(result.items.map((item) => item.id).sort()).toEqual(["ltm-conflict-a", "ltm-conflict-b"]);
    expect(result.items.every((item) => item.conflictState === "unresolved:conflict_growth_01")).toBe(true);
  });

  it("uses local same-Project preference only as an internal relevance boost", async () => {
    const { store } = createStore();
    store.load(true);
    writeFileSync(store.markdownPath, `# Long-term Memory\n\nSchema-Version: 1\n\n${rankableEntry("ltm-rank-a", "Retention discipline A")}\n${rankableEntry("ltm-rank-b", "Retention discipline B")}`, "utf8");
    store.rebuild();
    const result = await new LongTermMemoryRecallSource(store, { preferredEntryIds: new Set(["ltm-rank-b"]) }).recall({ mode: "automatic", disclosureLevel: "cards", query: "retention discipline" }, recallContext());
    expect(result.items.map((item) => item.id)).toEqual(["ltm-rank-b", "ltm-rank-a"]);
    expect(JSON.stringify(result)).not.toMatch(/preferred|same.Project|projectId/iu);
  });

  it("does not split a conflict when one side is explicit-only", async () => {
    const { store } = createStore();
    store.load(true);
    const automatic = conflictEntry("ltm-conflict-a", "Capital efficiency matters", "Prefer capital-efficient growth.");
    const explicitOnly = conflictEntry("ltm-conflict-b", "Speed can dominate efficiency", "Speed may justify burn.").replace("Recall: automatic", "Recall: explicit-only");
    writeFileSync(store.markdownPath, `# Long-term Memory\n\nSchema-Version: 1\n\n${automatic}\n${explicitOnly}`, "utf8");
    store.rebuild();
    const source = new LongTermMemoryRecallSource(store);
    expect((await source.recall({ mode: "automatic", disclosureLevel: "cards", query: "capital efficiency" }, recallContext())).items).toEqual([]);
    expect((await source.recall({ mode: "explicit", disclosureLevel: "cards", query: "capital efficiency" }, recallContext())).items).toHaveLength(2);
  });

  it("detects explicit recall and judgment-heavy work from the original User text", () => {
    expect(detectExplicitMemoryRecallIntent("请结合我的长期记忆分析这个行业")).toBe(true);
    expect(detectExplicitMemoryRecallIntent("这个判断要借鉴记忆")).toBe(true);
    expect(detectExplicitMemoryRecallIntent("结合我以前的判断来讨论")).toBe(true);
    expect(detectExplicitMemoryRecallIntent("总结这份材料")).toBe(false);
    expect(detectJudgmentHeavyIntent("为这个项目做风险评估和投资判断")).toBe(true);
    expect(detectJudgmentHeavyIntent("Assess this project.")).toBe(true);
    expect(detectJudgmentHeavyIntent("Create an investment memo with sources.")).toBe(true);
    expect(detectJudgmentHeavyIntent("提取表格")).toBe(false);
  });
});

function recallContext() {
  return { turnId: "turn-ltm", maxItems: 6, maxChars: 6_000, retrievedAt: new Date().toISOString() };
}

function conflictEntry(id: string, title: string, body: string): string {
  return `## 2026-07-19 - ${title}\nID: ${id}\nVersion: 1\nStatus: current\nTags: growth, strategy\nScope: global\nApplies To: growth-stage software\nMaturity: user-confirmed\nRecall: automatic\nConflict: unresolved:conflict_growth_01\nLimitations: Context dependent.\nSource References:\n\n${body}\n`;
}

function rankableEntry(id: string, title: string): string {
  return `## 2026-07-19 - ${title}\nID: ${id}\nVersion: 1\nStatus: current\nTags: retention, diligence\nScope: global\nApplies To: early-stage software\nMaturity: user-confirmed\nRecall: automatic\nConflict: none\nLimitations: Cohort maturity matters.\nSource References:\n\nUse retention thresholds carefully.\n`;
}
