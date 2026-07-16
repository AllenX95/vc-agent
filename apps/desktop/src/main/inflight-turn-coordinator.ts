import type { InflightTurnCheckpoint } from "@vc-agent/contracts";
import { ThreadTrajectoryStore } from "@vc-agent/persistence";

const FLUSH_INTERVAL_MS = 250;
const FLUSH_SIZE_BYTES = 4096;

interface ActiveCheckpoint {
  checkpoint: InflightTurnCheckpoint;
  dirtyBytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class InflightTurnCoordinator {
  readonly #store: ThreadTrajectoryStore;
  readonly #active = new Map<string, ActiveCheckpoint>();

  constructor(store: ThreadTrajectoryStore) {
    this.#store = store;
  }

  begin(checkpoint: InflightTurnCheckpoint): void {
    this.#store.writeCheckpoint(checkpoint);
    this.#active.set(checkpoint.turnId, { checkpoint, dirtyBytes: 0, timer: undefined });
  }

  updateDelta(turnId: string, delta: string, lastWorkerSequence: number, lastHostSequence: number): void {
    const active = this.#active.get(turnId);
    if (active === undefined) return;
    active.checkpoint = {
      ...active.checkpoint,
      partialMessage: active.checkpoint.partialMessage + delta,
      lastWorkerSequence,
      lastHostSequence,
      updatedAt: new Date().toISOString()
    };
    active.dirtyBytes += Buffer.byteLength(delta, "utf8");
    if (active.dirtyBytes >= FLUSH_SIZE_BYTES) this.flush(turnId);
    else if (active.timer === undefined) active.timer = setTimeout(() => this.flush(turnId), FLUSH_INTERVAL_MS);
  }

  updateBoundary(turnId: string, lastWorkerSequence: number, lastHostSequence: number): void {
    const active = this.#active.get(turnId);
    if (active === undefined) return;
    active.checkpoint = {
      ...active.checkpoint,
      lastWorkerSequence,
      lastHostSequence,
      updatedAt: new Date().toISOString()
    };
    this.flush(turnId);
  }

  get(turnId: string): InflightTurnCheckpoint | undefined {
    return this.#active.get(turnId)?.checkpoint;
  }

  flush(turnId: string): void {
    const active = this.#active.get(turnId);
    if (active === undefined) return;
    if (active.timer !== undefined) clearTimeout(active.timer);
    active.timer = undefined;
    active.dirtyBytes = 0;
    this.#store.writeCheckpoint(active.checkpoint);
  }

  complete(turnId: string): void {
    const active = this.#active.get(turnId);
    if (active === undefined) return;
    if (active.timer !== undefined) clearTimeout(active.timer);
    this.#store.removeCheckpoint(active.checkpoint.threadId, turnId);
    this.#active.delete(turnId);
  }

  activeCheckpoints(): InflightTurnCheckpoint[] {
    return [...this.#active.values()].map((item) => item.checkpoint);
  }

  flushAll(): void {
    for (const turnId of this.#active.keys()) this.flush(turnId);
  }
}
