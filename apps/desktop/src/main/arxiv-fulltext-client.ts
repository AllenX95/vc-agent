import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ARXIV_BUNDLE_FILES, MAX_ARXIV_BUNDLE_BYTES, type ArxivFulltextClient } from "@vc-agent/capabilities";
import type { UtilityJobRunner } from "./utility-job-runner.js";

export class BundledArxivFulltextClient implements ArxivFulltextClient {
  readonly #skillRoot: string;
  readonly #stagingRoot: string;
  readonly #runner: UtilityJobRunner;

  constructor(input: { readonly skillRoot: string; readonly stagingRoot: string; readonly runner: UtilityJobRunner }) {
    this.#skillRoot = resolve(input.skillRoot);
    this.#stagingRoot = resolve(input.stagingRoot);
    this.#runner = input.runner;
  }

  async archive(input: { readonly identifier: string; readonly allowAr5iv: boolean; readonly force: boolean }) {
    mkdirSync(this.#stagingRoot, { recursive: true });
    const stagingDirectory = mkdtempSync(join(this.#stagingRoot, "arxiv-fulltext-"));
    try {
      const event = await this.#runner.run({
        schemaVersion: 1,
        command: "arxiv.fulltext",
        jobId: randomUUID(),
        skillRoot: this.#skillRoot,
        stagingDirectory,
        identifier: input.identifier,
        allowAr5iv: input.allowAr5iv,
        force: input.force,
        timeoutMs: 180_000,
        maxOutputBytes: 200_000,
        maxBytes: MAX_ARXIV_BUNDLE_BYTES
      });
      if (event.event === "arxiv.fulltext.failed") throw new Error(`${event.code}:${event.message}`);
      return {
        paperId: event.paperId,
        source: event.source,
        sourceUrl: event.sourceUrl,
        warnings: event.warnings,
        files: event.files.map((file) => {
          if (!ARXIV_BUNDLE_FILES.includes(file.path as (typeof ARXIV_BUNDLE_FILES)[number])) throw new Error(`Unexpected ArXiv archive file: ${file.path}`);
          const path = resolve(event.paperDirectory, file.path);
          if (!isWithin(stagingDirectory, path)) throw new Error("ArXiv archive file escaped its staging directory.");
          const body = readFileSync(path);
          if (body.byteLength !== file.bytes) throw new Error(`ArXiv archive file changed during staging: ${file.path}`);
          return { path: file.path as (typeof ARXIV_BUNDLE_FILES)[number], body, mediaType: file.mediaType };
        })
      };
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`) && !/^[A-Za-z]:/u.test(relativePath));
}
