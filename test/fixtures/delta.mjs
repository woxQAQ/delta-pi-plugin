#!/usr/bin/env node
// A process-level Delta contract simulator; no network or account is involved.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const root = process.cwd();
const ledgerPath = join(root, "ledger.json");
const ledger = () => existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const option = (name) => args[args.indexOf(name) + 1];
const marker = (name) => join(root, name);
appendFileSync(marker("commands.jsonl"), `${JSON.stringify(args)}\n`);

if (args[0] === "thread" && args[1] === "contract") {
  emit({ operation: "contract", min: 8, max: existsSync(marker("old-contract")) ? 7 : 10 });
} else if (args[0] === "thread" && args[1] === "create") {
  emit({ operation: "created", thread_id: "thread_test" });
} else if (args[0] === "worktree" && args[1] === "list") {
  emit({ operation: "listed", worktrees: [] });
} else if (args[0] === "worktree" && args[1] === "create") {
  emit({ operation: "created", reference: "repo#t=timeline" });
} else if (args[0] === "worktree" && args[1] === "attach") {
  emit({ operation: "attached" });
} else if (args[0] === "thread" && ["share", "invite", "unshare"].includes(args[1])) {
  emit({ operation: args[1], thread_id: "thread_test", url: "https://delta.dev/join/thread_test" });
} else if (args[0] === "thread" && args[1] === "status") {
  const entries = ledger();
  emit({
    operation: "status", thread_id: "thread_test", url: "https://delta.dev/join/thread_test",
    access: { state: "granted", is_owner: true },
    producer: entries.length ? {
      source: "pi", external_id: "session_test", next_sequence: entries.length + 1, turn: null,
    } : null,
  });
} else if (args[1] === "mount") {
  emit({ operation: "mounted", thread_id: "thread_test", owner: option("--owner"), directory: root, worktrees: [] });
  process.on("SIGTERM", () => { appendFileSync(marker("stopped"), "mount\n"); process.exit(0); });
  setInterval(() => {}, 1000);
} else if (args[0] === "thread" && args[1] === "watch") {
  emit({ type: "ready", thread_id: "thread_test", producer: null });
  const item = (id, after_id, text) => ({
    type: "item", item: { id, after_id, kind: "agent_message", open: false, author: { name: "Ada" }, content: { text } },
  });
  emit(item("second", "first", "second\u2028message"));
  emit(item("first", null, "first message"));
  if (existsSync(marker("large-snapshot"))) {
    for (let index = 0; index < 20; index++) {
      emit(item(`large-${index}`, index ? `large-${index - 1}` : "second", "x".repeat(9000)));
    }
  }
  emit({ type: "live" });
  let delivered = false;
  const timer = setInterval(() => {
    if (!delivered && existsSync(marker("takeover"))) {
      const running = ledger().findLast((record) => record.update.state === "running");
      if (running) {
        delivered = true;
        emit({ type: "producer.turn", sequence: running.sequence, status: "superseded" });
      }
    }
    if (existsSync(marker("reset-watch"))) {
      emit({ error: { code: "watch_reset", message: "reconnect", retryable: true, retry_after_ms: 20 } });
      clearInterval(timer);
    }
  }, 10);
  process.on("SIGTERM", () => { appendFileSync(marker("stopped"), "watch\n"); process.exit(0); });
} else if (args[0] === "thread" && args[1] === "append") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const record = JSON.parse(input);
  const entries = ledger();
  const prior = entries[record.sequence - 1];
  if (prior && JSON.stringify(prior) !== JSON.stringify(record)) {
    emit({ error: { code: "invalid_record", message: "sequence reused with different content", retryable: false } });
    process.exit(1);
  }
  if (!prior) {
    if (record.sequence !== entries.length + 1) {
      emit({ error: { code: "sequence_gap", message: "gap", retryable: false } });
      process.exit(1);
    }
    entries.push(record);
    writeFileSync(ledgerPath, JSON.stringify(entries));
  }
  if (existsSync(marker("lose-receipt")) && !existsSync(marker("receipt-lost"))) {
    writeFileSync(marker("receipt-lost"), "yes");
    emit({ error: { code: "unavailable", message: "receipt lost after commit", retryable: false } });
    process.exit(1);
  }
  if (existsSync(marker("bad-receipt"))) {
    emit({ operation: "appended", thread_id: "wrong_thread", sequence: record.sequence });
  } else {
    emit({
      operation: "appended", thread_id: "thread_test", sequence: record.sequence,
      next_sequence: record.sequence + 1, duplicate: !!prior, version: "actor.1",
      turn_sequence: record.turnSequence ?? null,
      disposition: existsSync(marker("fence")) && record.turnSequence ? "fenced" : prior ? "duplicate" : "recorded",
    });
  }
} else {
  emit({ error: { code: "invalid_invocation", message: args.join(" "), retryable: false } });
  process.exit(1);
}
