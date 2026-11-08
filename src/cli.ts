import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type Json = Record<string, any>;

export class DeltaError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfterMs = 2000,
    readonly code = "plugin_error",
  ) {
    super(message);
  }
}

export function checkError(value: Json): void {
  if (value.error) {
    const error = value.error;
    throw new DeltaError(
      `${error.code}${error.reason ? ` (${error.reason})` : ""}: ${error.message}`,
      error.retryable === true,
      typeof error.retry_after_ms === "number" ? Math.max(0, error.retry_after_ms) : 2000,
      error.code,
    );
  }
}

/** Only LF delimits records; Unicode separators can occur inside JSON strings. */
export class JsonLines {
  private buffer = "";
  push(chunk: string, consume: (value: Json) => void): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (line) consume(JSON.parse(line));
    }
  }
  end(consume: (value: Json) => void): void {
    if (this.buffer.trim()) consume(JSON.parse(this.buffer));
    this.buffer = "";
  }
}

export class DeltaProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  private stopped = false;

  constructor(binary: string, args: string[], cwd: string, onFrame: (frame: Json) => void) {
    this.child = spawn(binary, ["--json", ...args], { cwd, stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    const lines = new JsonLines();
    let stderr = "";
    let failure: unknown;
    const consume = (frame: Json) => {
      checkError(frame);
      onFrame(frame);
    };
    this.child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    this.child.stdout.on("data", (chunk: string) => {
      try { lines.push(chunk, consume); }
      catch (error) { failure = error; this.child.kill("SIGTERM"); }
    });
    this.done = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code) => {
        try { lines.end(consume); } catch (error) { failure ??= error; }
        if (this.stopped) resolve();
        else if (failure) reject(failure);
        else reject(new DeltaError(stderr.trim() || `Delta stream exited (${code})`, false));
      });
    });
    // Callers attach recovery handlers after constructing the process.
    void this.done.catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.done.catch(() => {});
    this.stopped = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
    timer.unref();
    await this.done.catch(() => {});
    clearTimeout(timer);
  }
}

export class DeltaCli {
  constructor(readonly binary: string, readonly cwd: string) {}

  async run(args: string[], input?: string, signal?: AbortSignal): Promise<Json[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["--json", ...args], { cwd: this.cwd, stdio: "pipe", signal });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
      child.stdin.on("error", () => {});
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          let frames: Json[];
          try { frames = [JSON.parse(stdout)]; }
          catch { frames = stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)); }
          for (const frame of frames) checkError(frame);
          if (timedOut || code !== 0 || frames.length === 0) {
            throw new DeltaError(stderr.trim() || `Delta command failed (${code}): ${stdout.trim().slice(0, 8192)}`, false);
          }
          resolve(frames);
        } catch (error) {
          reject(error instanceof SyntaxError
            ? new DeltaError(`Delta returned invalid JSON. Check DELTAPI_CLI points to delta.dev's CLI. ${stderr.trim()}`)
            : error);
        }
      });
      child.stdin.end(input);
    });
  }

  async one(args: string[]): Promise<Json> {
    const frames = await this.run(args);
    if (frames.length !== 1) throw new DeltaError("Expected one Delta command result");
    return frames[0];
  }

  async contract(): Promise<void> {
    const range = await this.one(["thread", "contract"]);
    if (range.operation !== "contract" || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max)) {
      throw new DeltaError("Invalid Delta contract. Configure DELTAPI_CLI with the delta.dev CLI path.");
    }
    if (range.max < 8) throw new DeltaError("Update Delta: this plugin requires recording contract 8.");
    if (range.min > 8) throw new DeltaError("Update deltapi: this Delta CLI no longer supports recording contract 8.");
  }

  stream(args: string[], onFrame: (frame: Json) => void): DeltaProcess {
    return new DeltaProcess(this.binary, args, this.cwd, onFrame);
  }

  async mount(args: string[]): Promise<{ process: DeltaProcess; ready: Json }> {
    let accept!: (frame: Json) => void;
    const ready = new Promise<Json>((resolve) => { accept = resolve; });
    const process = this.stream(args, (frame) => {
      if (frame.operation === "mounted") accept(frame);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frame = await Promise.race([
        ready,
        process.done.then(() => { throw new DeltaError("Mount stopped before becoming ready"); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeltaError("Delta mount readiness timed out")), 60_000);
        }),
      ]);
      return { process, ready: frame };
    } catch (error) {
      await process.stop();
      throw error;
    } finally { clearTimeout(timer); }
  }
}
