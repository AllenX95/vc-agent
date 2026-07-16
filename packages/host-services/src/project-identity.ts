import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const markerSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  createdAt: z.string().datetime()
}).strict();

export type ProjectIdentityMarker = z.infer<typeof markerSchema>;

export class ProjectIdentityStore {
  markerPath(projectPath: string): string {
    return join(projectPath, "outputs", "system", "project.json");
  }

  read(projectPath: string): ProjectIdentityMarker | undefined {
    const path = this.markerPath(projectPath);
    if (!existsSync(path)) return undefined;
    return markerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  create(projectPath: string): ProjectIdentityMarker {
    const marker = { schemaVersion: 1 as const, projectId: randomUUID(), createdAt: new Date().toISOString() };
    this.write(projectPath, marker, false);
    return marker;
  }

  replaceForCopy(projectPath: string): ProjectIdentityMarker {
    const marker = { schemaVersion: 1 as const, projectId: randomUUID(), createdAt: new Date().toISOString() };
    this.write(projectPath, marker, true);
    return marker;
  }

  private write(projectPath: string, marker: ProjectIdentityMarker, replace: boolean): void {
    const destination = this.markerPath(projectPath);
    const directory = join(projectPath, "outputs", "system");
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.project-${randomUUID()}.partial`);
    try {
      writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      if (!replace && existsSync(destination)) throw new Error("Project identity already exists");
      if (replace) rmSync(destination, { force: true });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
