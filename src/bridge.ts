import { DeltaCli, DeltaError, type DeltaProcess, type Json } from "./cli.js";
import { fingerprint, messageKey, messageUpdates, RemoteView } from "./conversation.js";
import { Store } from "./store.js";

export interface Host {
  abort(): void;
  notify(message: string, error?: boolean): void;
  remote(text: string, key: string, hash: string): void;
}

/** Owns the producer ledger, delivery queue and session-scoped CLI processes. */
export class Bridge {
  ready = false;
  fenced = false;
  private closed = false;
  private active = false;
  private flushing?: Promise<void>;
  private starting?: Promise<void>;
  private watch?: DeltaProcess;
  private mount?: DeltaProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private watchRetry?: ReturnType<typeof setTimeout>;
  private view = new RemoteView();
  private disposal?: Promise<void>;
  private cancellation = new AbortController();

  constructor(readonly cli: DeltaCli, readonly store: Store, private host: Host) {}

  get state() { return this.store.state!; }
  get producer(): string[] { return ["--source", this.state.source, "--external-id", this.state.session]; }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async connect(): Promise<void> {
    this.ready = false;
    await this.cli.contract();
    const status = await this.cli.one(["thread", "status", this.state.thread, ...this.producer]);
    if (status.thread_id !== this.state.thread ||
        (status.access?.state !== "granted" && !(this.state.privateOrganization && status.access?.state === "local_only"))) {
      throw new DeltaError("Delta thread access is unavailable. Check sign-in and sharing.");
    }
    const producer = status.producer;
    const frontier = this.state.pending[0]?.sequence ?? this.state.next;
    if ((producer && (producer.source !== this.state.source || producer.external_id !== this.state.session ||
        producer.next_sequence < frontier || producer.next_sequence > this.state.next)) ||
        (!producer && frontier !== 1)) {
      throw new DeltaError("Delta producer history differs from the saved outbox. Restore matching state or start a new Pi session; do not reset sequences.");
    }
    if (producer && !Number.isSafeInteger(producer.next_sequence)) {
      throw new DeltaError("Delta returned an invalid producer sequence frontier.");
    }
    await this.watch?.stop();
    this.watch = undefined;
    await this.mount?.stop();
    this.mount = undefined;
    if (this.closed) return;
    const mounted = this.state.mode === "join"
      ? await this.cli.mount(["thread", "mount", this.state.thread, "--owner", this.state.owner!])
      : await this.cli.mount(["worktree", "mount", this.state.worktree!, this.state.directory, "--existing-checkout"]);
    this.mount = mounted.process;
    void this.mount.done.catch((error) => this.disconnected(error));
    if (this.state.mode === "join" && mounted.ready.directory !== this.state.directory) {
      throw new DeltaError(`Joined checkout moved to ${mounted.ready.directory}. Run /delta join ${this.state.thread} to enter it.`);
    }
    if (this.closed) { await this.mount.stop(); return; }
    this.view = new RemoteView();
    let live!: () => void;
    const synced = new Promise<void>((resolve) => { live = resolve; });
    this.watch = this.cli.stream([
      "thread", "watch", this.state.thread, ...this.producer, "--participate", "Pi", "--owner-pid", String(process.pid),
    ], (frame) => {
      if (this.closed) return;
      if (frame.type === "ready" && frame.thread_id !== this.state.thread) throw new DeltaError("Watch returned a different thread");
      if (frame.type === "producer.turn" && frame.status === "superseded" && frame.sequence === this.state.turn) this.superseded();
      if (frame.type === "worktrees" && this.view.live && this.state.mode === "join") {
        this.disconnected(new DeltaError("Thread worktrees changed; refreshing mounts", true, 0));
      }
      this.view.apply(frame);
      this.deliver();
      if (frame.type === "live") live();
    });
    void this.watch.done.catch((error) => this.disconnected(error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        synced, this.watch.done,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeltaError("Delta watch snapshot timed out")), 30_000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (this.closed) return;
    // A crashed run keeps its original turn attribution when closed on resume.
    if (this.state.turn !== undefined && !this.active) {
      this.store.enqueue([{ sessionUpdate: "state_update", state: "idle" }], this.state.turn);
      this.state.turn = undefined;
      this.store.save();
    }
    this.ready = true;
    this.host.notify(`Delta connected: ${this.state.url ?? this.state.thread}`);
    this.kick();
  }

  private deliver(): void {
    const all = this.view.deliveries();
    const selected: typeof all = [];
    let budget = 64_000;
    for (const delivery of all.toReversed()) {
      const suffix = `\n[Truncated. Read the full thread with Delta CLI: thread show ${this.state.thread}]`;
      const text = delivery.text.length > 8000 ? delivery.text.slice(0, 8000 - suffix.length) + suffix : delivery.text;
      if (text.length > budget) break;
      budget -= text.length;
      selected.unshift({ ...delivery, text });
    }
    const omitted = all.length - selected.length;
    if (omitted) {
      selected.unshift({
        key: "history:trimmed", hash: fingerprint({ omitted, first: selected[0]?.key }),
        text: `[${omitted} older Delta items omitted from context. Read older history with Delta CLI: thread show ${this.state.thread} --format messages --messages 1-20]`,
      });
    }
    for (const delivery of selected) {
      if (this.state.delivered[delivery.key] === delivery.hash) continue;
      this.host.remote(delivery.text, delivery.key, delivery.hash);
      this.state.delivered[delivery.key] = delivery.hash;
      this.store.save();
    }
  }

  private superseded(): void {
    this.fenced = true;
    this.host.abort();
    this.host.notify("A collaborator took over this Delta turn. Pi was stopped; completed tool effects remain.");
  }

  private disconnected(error: unknown): void {
    if (this.closed || this.disposal) return;
    this.ready = false;
    if (this.active) this.host.abort();
    this.host.notify(`Delta disconnected: ${String(error)}`, true);
    if (error instanceof DeltaError && error.retryable && !this.watchRetry) {
      this.watchRetry = setTimeout(() => {
        this.watchRetry = undefined;
        void this.start().catch((failure) => this.disconnected(failure));
      }, error.retryAfterMs);
      this.watchRetry.unref();
    }
  }

  capture(message: Json): void {
    if (this.closed || !this.state.enabled) return;
    const key = messageKey(message);
    if (this.state.captured.includes(key)) return;
    const updates = messageUpdates(message, key);
    if (!updates.length) return;
    this.store.enqueue(updates, this.state.turn, key);
    this.kick();
  }

  export(messages: Json[]): void {
    if (this.state.initialExportDone) return;
    for (const message of messages) this.capture(message);
    this.state.initialExportDone = true;
    this.store.save();
  }

  async begin(): Promise<void> {
    if (!this.ready || this.closed) throw new DeltaError("Delta is not connected. Run /delta reconnect or /delta disconnect before continuing.");
    if (this.active) return;
    this.fenced = false;
    this.active = true;
    this.state.turn = this.state.next;
    this.store.enqueue([{ sessionUpdate: "state_update", state: "running" }], this.state.turn);
    // Establish ownership before Pi can start a tool.
    try {
      await this.flush();
      if (this.state.pending.length || this.fenced || !this.ready) {
        throw new DeltaError("Delta has not acknowledged turn ownership; Pi was stopped.");
      }
    } catch (error) {
      this.ready = false;
      this.host.abort();
      throw error;
    }
  }

  settle(): void {
    this.active = false;
    if (this.state.turn === undefined) return;
    this.store.enqueue([{ sessionUpdate: "state_update", state: "idle" }], this.state.turn);
    this.state.turn = undefined;
    this.store.save();
    this.kick();
  }

  title(title: string): void {
    this.store.enqueue([{ sessionUpdate: "session_info_update", title }]);
    this.kick();
  }

  kick(): void {
    if (this.closed || this.disposal || !this.ready || this.retry) return;
    void this.flush().catch((error) => {
      this.host.notify(`Delta recording paused: ${String(error)}. Records remain saved.`, true);
      if (error instanceof DeltaError && error.retryable) {
        this.retry = setTimeout(() => { this.retry = undefined; this.kick(); }, error.retryAfterMs);
        this.retry.unref();
      } else {
        this.ready = false;
        if (this.active) this.host.abort();
      }
    });
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.send().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async send(): Promise<void> {
    while (this.state.pending.length && !this.closed && this.ready) {
      const record = this.state.pending[0];
      const frames = await this.cli.run([
        "thread", "append", this.state.thread, ...this.producer, "--producer-name", "Pi",
        ...(this.state.privateOrganization ? ["--acknowledge", "local"] : []),
      ], `${JSON.stringify(record)}\n`, this.cancellation.signal);
      const receipt = frames[0];
      if (frames.length !== 1 || receipt.operation !== "appended" || receipt.thread_id !== this.state.thread ||
          receipt.sequence !== record.sequence || typeof receipt.duplicate !== "boolean" ||
          typeof receipt.version !== "string" || !receipt.version || !Number.isSafeInteger(receipt.next_sequence) ||
          receipt.next_sequence <= record.sequence || receipt.turn_sequence !== (record.turnSequence ?? null) ||
          !["recorded", "duplicate", "fenced"].includes(receipt.disposition)) {
        throw new DeltaError("Invalid Delta acknowledgment; the original record remains saved.");
      }
      if (receipt.disposition === "fenced" && record.turnSequence === this.state.turn) this.superseded();
      this.state.pending.shift();
      this.store.save();
    }
  }

  close(): Promise<void> {
    this.disposal ??= this.dispose();
    return this.disposal;
  }

  private async dispose(): Promise<void> {
    clearTimeout(this.retry);
    clearTimeout(this.watchRetry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.active) this.settle();
      // Give a clean exit a bounded drain window while watch still owns the turn.
      await Promise.race([
        this.flush().catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
      this.closed = true;
      this.ready = false;
      this.cancellation.abort();
      await this.flushing?.catch(() => {});
      await this.starting?.catch(() => {});
      await Promise.all([this.watch?.stop(), this.mount?.stop()]);
      await this.store.close();
    }
  }
}
