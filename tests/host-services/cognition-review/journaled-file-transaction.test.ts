import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournaledFileTransactionAdapter, type JournaledFileTransactionFaultInjection } from "../../../packages/host-services/src/cognition-review/journaled-file-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function fixture(faultInjection?: JournaledFileTransactionFaultInjection) {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-journaled-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "project");
  const memoryRoot = join(root, "memory");
  const transactionRoot = join(root, "transactions");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  const projectPath = join(projectRoot, "judgment.md");
  const memoryPath = join(memoryRoot, "long-term.md");
  writeFileSync(projectPath, "before judgment\n", "utf8");
  writeFileSync(memoryPath, "before memory\n", "utf8");
  const adapter = new JournaledFileTransactionAdapter({
    transactionRoot,
    allowedRoots: [projectRoot, memoryRoot],
    ...(faultInjection === undefined ? {} : { faultInjection })
  });
  return { root, projectRoot, memoryRoot, transactionRoot, projectPath, memoryPath, adapter };
}

describe("JournaledFileTransactionAdapter", () => {
  it("rejects duplicate targets and base hashes that do not match the before-state", () => {
    const { adapter, projectPath } = fixture();
    expect(() => adapter.commit({
      id: "duplicate-targets",
      targets: [
        { path: projectPath, baseHash: hash("before judgment\n"), afterContent: "one" },
        { path: projectPath, baseHash: hash("before judgment\n"), afterContent: "two" }
      ]
    })).toThrow("JOURNALED_TRANSACTION_DUPLICATE_TARGET");

    expect(() => adapter.commit({
      id: "stale-base",
      targets: [{ path: projectPath, baseHash: hash("not the current content"), afterContent: "replacement" }]
    })).toThrow("JOURNALED_TRANSACTION_BASE_HASH_MISMATCH");
  });

  it("commits UTF-8 after-images across distinct allowed roots", () => {
    const { adapter, projectPath, memoryPath, transactionRoot } = fixture();
    const result = adapter.commit({
      id: "cross-root-commit",
      targets: [
        { path: projectPath, baseHash: hash("before judgment\n"), afterContent: "已确认判断\n" },
        { path: memoryPath, baseHash: hash("before memory\n"), afterContent: "已确认记忆\n" }
      ]
    });

    expect(result).toMatchObject({ id: "cross-root-commit" });
    expect(readFileSync(projectPath, "utf8")).toBe("已确认判断\n");
    expect(readFileSync(memoryPath, "utf8")).toBe("已确认记忆\n");
    expect(readdirSync(transactionRoot)).toEqual([]);
  });

  it("publishes all after-images after an activation fault is recovered", () => {
    const { adapter, projectPath, memoryPath, transactionRoot, projectRoot, memoryRoot } = fixture({ phase: "activation", after: 1 });
    const before = [readFileSync(projectPath, "utf8"), readFileSync(memoryPath, "utf8")];

    expect(() => adapter.commit({
      id: "activation-failure",
      targets: [
        { path: projectPath, baseHash: hash(before[0]!), afterContent: "after judgment\n" },
        { path: memoryPath, baseHash: hash(before[1]!), afterContent: "after memory\n" }
      ]
    })).toThrow("JOURNALED_TRANSACTION_ACTIVATION_FAILURE");

    expect([readFileSync(projectPath, "utf8"), readFileSync(memoryPath, "utf8")]).not.toEqual(before);
    new JournaledFileTransactionAdapter({ transactionRoot, allowedRoots: [projectRoot, memoryRoot] }).recover();
    expect([readFileSync(projectPath, "utf8"), readFileSync(memoryPath, "utf8")]).toEqual(["after judgment\n", "after memory\n"]);
    expect(readdirSync(transactionRoot)).toEqual([]);
  });

  it("rolls back an uncommitted journal during restart recovery", () => {
    const first = fixture({ phase: "commit-point", beforeCommitPoint: true, mode: "crash" });
    const before = [readFileSync(first.projectPath, "utf8"), readFileSync(first.memoryPath, "utf8")];
    expect(() => first.adapter.commit({
      id: "crashed-before-commit",
      targets: [
        { path: first.projectPath, baseHash: hash(before[0]!), afterContent: "after judgment\n" },
        { path: first.memoryPath, baseHash: hash(before[1]!), afterContent: "after memory\n" }
      ]
    })).toThrow("JOURNALED_TRANSACTION_COMMIT_POINT_FAILURE");
    expect([readFileSync(first.projectPath, "utf8"), readFileSync(first.memoryPath, "utf8")]).toEqual(before);

    const restarted = new JournaledFileTransactionAdapter({
      transactionRoot: first.transactionRoot,
      allowedRoots: [first.projectRoot, first.memoryRoot]
    });
    restarted.recover();

    expect([readFileSync(first.projectPath, "utf8"), readFileSync(first.memoryPath, "utf8")]).toEqual(before);
    expect(readdirSync(first.transactionRoot)).toEqual([]);
  });

  it("completes publication for a committed journal after restart", () => {
    const first = fixture({ phase: "publication", after: 1, mode: "crash" });
    expect(() => first.adapter.commit({
      id: "crashed-after-commit",
      targets: [
        { path: first.projectPath, baseHash: hash("before judgment\n"), afterContent: "after judgment\n" },
        { path: first.memoryPath, baseHash: hash("before memory\n"), afterContent: "after memory\n" }
      ]
    })).toThrow("JOURNALED_TRANSACTION_PUBLICATION_FAILURE");

    expect(readFileSync(first.projectPath, "utf8")).toBe("after judgment\n");
    expect(readFileSync(first.memoryPath, "utf8")).toBe("after memory\n");

    const restarted = new JournaledFileTransactionAdapter({
      transactionRoot: first.transactionRoot,
      allowedRoots: [first.projectRoot, first.memoryRoot]
    });
    restarted.recover();

    expect(readFileSync(first.projectPath, "utf8")).toBe("after judgment\n");
    expect(readFileSync(first.memoryPath, "utf8")).toBe("after memory\n");
    expect(readdirSync(first.transactionRoot)).toEqual([]);
  });

  it("survives a fault immediately after the durable commit point", () => {
    const first = fixture({ phase: "commit-point", mode: "crash" });
    expect(() => first.adapter.commit({
      id: "crashed-at-commit-point",
      targets: [{ path: first.projectPath, baseHash: hash("before judgment\n"), afterContent: "after judgment\n" }]
    })).toThrow("JOURNALED_TRANSACTION_COMMIT_POINT_FAILURE");

    const restarted = new JournaledFileTransactionAdapter({
      transactionRoot: first.transactionRoot,
      allowedRoots: [first.projectRoot, first.memoryRoot]
    });
    restarted.recover();
    expect(readFileSync(first.projectPath, "utf8")).toBe("after judgment\n");
    expect(readdirSync(first.transactionRoot)).toEqual([]);
  });

  it("rejects a target outside caller-declared allowed roots", () => {
    const { adapter, root } = fixture();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "private\n", "utf8");
    expect(() => adapter.commit({
      id: "outside-root",
      targets: [{ path: outside, baseHash: hash("private\n"), afterContent: "not allowed" }]
    })).toThrow("JOURNALED_TRANSACTION_TARGET_OUTSIDE_ALLOWED_ROOT");
  });

  it("resolves dynamic allowed roots when a Project is opened after startup", () => {
    const first = fixture();
    const laterRoot = join(first.root, "later-project");
    mkdirSync(laterRoot, { recursive: true });
    const laterTarget = join(laterRoot, "judgment.md");
    let roots = [first.projectRoot];
    const adapter = new JournaledFileTransactionAdapter({ transactionRoot: first.transactionRoot, allowedRoots: () => roots });
    writeFileSync(laterTarget, "before\n", "utf8");
    expect(() => adapter.commit({ id: "later-before-open", targets: [{ path: laterTarget, baseHash: hash("before\n"), afterContent: "after\n" }] })).toThrow("JOURNALED_TRANSACTION_TARGET_OUTSIDE_ALLOWED_ROOT");
    roots = [first.projectRoot, laterRoot];
    adapter.commit({ id: "later-after-open", targets: [{ path: laterTarget, baseHash: hash("before\n"), afterContent: "after\n" }] });
    expect(readFileSync(laterTarget, "utf8")).toBe("after\n");
  });

  it("rejects a symlinked target parent that resolves outside the allowed roots", () => {
    const { adapter, root, projectRoot } = fixture();
    const outsideRoot = join(root, "outside");
    const link = join(projectRoot, "linked");
    mkdirSync(outsideRoot, { recursive: true });
    try {
      symlinkSync(outsideRoot, link, "junction");
    } catch {
      return;
    }
    const target = join(link, "escaped.md");
    expect(() => adapter.commit({
      id: "symlink-parent",
      targets: [{ path: target, baseHash: "missing", afterContent: "must not escape" }]
    })).toThrow("JOURNALED_TRANSACTION_TARGET_OUTSIDE_ALLOWED_ROOT");
    expect(existsSync(join(outsideRoot, "escaped.md"))).toBe(false);
  });

  it("refuses to recover a tampered manifest target outside the allowed roots", () => {
    const first = fixture({ phase: "commit-point", beforeCommitPoint: true, mode: "crash" });
    expect(() => first.adapter.commit({
      id: "tampered-manifest",
      targets: [{ path: first.projectPath, baseHash: hash("before judgment\n"), afterContent: "after judgment\n" }]
    })).toThrow("JOURNALED_TRANSACTION_COMMIT_POINT_FAILURE");

    const manifestPath = join(first.transactionRoot, "tampered-manifest", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { targets: Array<{ path: string }> };
    const outside = join(first.root, "outside-tampered.md");
    manifest.targets[0]!.path = outside;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    expect(() => new JournaledFileTransactionAdapter({
      transactionRoot: first.transactionRoot,
      allowedRoots: [first.projectRoot, first.memoryRoot]
    })).toThrow("JOURNALED_TRANSACTION_TARGET_OUTSIDE_ALLOWED_ROOT");
    expect(existsSync(outside)).toBe(false);
    expect(readFileSync(first.projectPath, "utf8")).toBe("before judgment\n");
  });
});
