import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

export interface PreviousMaterialFingerprint {
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly sourceHash: string;
}

export interface MaterialInventoryRecord extends PreviousMaterialFingerprint {
  readonly extension: string;
  readonly mediaType: string;
}

const supportedTypes: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".webp": "image/webp"
};

const excludedDirectories = new Set(["outputs", ".git", ".vc-agent", ".cache", "node_modules"]);

export async function inventoryProjectFiles(
  projectPath: string,
  previous: readonly PreviousMaterialFingerprint[] = []
): Promise<MaterialInventoryRecord[]> {
  const previousByPath = new Map(previous.map((item) => [item.relativePath, item]));
  const records: MaterialInventoryRecord[] = [];
  await visit(projectPath);
  return records.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) await visit(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith("~$") || entry.name.endsWith(".tmp") || entry.name.endsWith(".partial")) continue;
      const extension = extname(entry.name).toLowerCase();
      const mediaType = supportedTypes[extension];
      if (mediaType === undefined) continue;
      const absolutePath = join(directory, entry.name);
      const metadata = await stat(absolutePath);
      const relativePath = relative(projectPath, absolutePath).split(sep).join("/");
      const modifiedAt = metadata.mtime.toISOString();
      const prior = previousByPath.get(relativePath);
      const sourceHash = prior?.size === metadata.size && prior.modifiedAt === modifiedAt
        ? prior.sourceHash
        : await hashFile(absolutePath);
      records.push({ relativePath, extension, mediaType, size: metadata.size, modifiedAt, sourceHash });
    }
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
