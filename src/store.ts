import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { DeltaError, type Json } from "./cli.js";

export interface RecordEntry {
  schemaVersion: 1;
  sequence: number;
  turnSequence?: number;
  update: Json;
}

export interface State {
  version: 1;
  session: string;
  source: "pi";
  thread: string;
  url?: string;
  mode: "share" | "join";
  directory: string;
  worktree?: string;
  owner?: string;
  enabled: boolean;
  next: number;
  turn?: number;
  pending: RecordEntry[];
  captured: string[];
  delivered: Record<string, string>;
  initialExportDone: boolean;
  privateOrganization?: string;
}

/** State and the outbox commit together, before any record is sent. */
export class Store {
  readonly path: string;
  state?: State;
  private release?: () => Promise<void>;

  constructor(directory: string, readonly session: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `${createHash("sha256").update(session).digest("hex")}.json`);
  }

  async acquire(): Promise<void> {
    this.release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 10_000,
      onCompromised: (error) => { throw error; },
    });
    try {
      if (!existsSync(this.path)) return;
      const value = JSON.parse(readFileSync(this.path, "utf8")) as State;
      if (value.version !== 1 || value.session !== this.session || value.source !== "pi" ||
          !Number.isSafeInteger(value.next) || value.next < 1 || !Array.isArray(value.pending) ||
          !Array.isArray(value.captured) || typeof value.delivered !== "object" || !value.delivered) {
        throw new DeltaError("Invalid deltapi state; restore it or start a new Pi session. Never reset sequence numbers.");
      }
      let previous = 0;
      for (const record of value.pending) {
        if (!Number.isSafeInteger(record.sequence) || record.sequence <= previous || record.sequence >= value.next ||
            record.schemaVersion !== 1 || typeof record.update?.sessionUpdate !== "string") {
          throw new DeltaError("Invalid deltapi outbox; restore the matching state before reconnecting.");
        }
        previous = record.sequence;
      }
      this.state = value;
    } catch (error) { await this.close(); throw error; }
  }

  save(): void {
    if (!this.release || !this.state) throw new DeltaError("Deltapi state is not locked");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    if (process.platform !== "win32") {
      const directoryFd = openSync(dirname(this.path), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  }

  enqueue(updates: Json[], turn?: number, captured?: string): RecordEntry[] {
    const state = this.state!;
    const records = updates.map((update): RecordEntry => ({
      schemaVersion: 1,
      sequence: state.next++,
      ...(turn === undefined ? {} : { turnSequence: turn }),
      update,
    }));
    state.pending.push(...records);
    if (captured) state.captured.push(captured);
    this.save();
    return records;
  }

  async close(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    await release?.();
  }
}
