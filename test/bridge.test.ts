import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bridge, type Host } from "../src/bridge.js";
import { DeltaCli } from "../src/cli.js";
import { Store, type State } from "../src/store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for integration state");
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "deltapi-test-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "delta");
  copyFileSync(resolve("test/fixtures/delta.mjs"), binary);
  chmodSync(binary, 0o755);
  const notices: string[] = [];
  const remote: string[] = [];
  let aborts = 0;
  const host: Host = {
    abort: () => { aborts++; },
    notify: (message) => { notices.push(message); },
    remote: (text) => { remote.push(text); },
  };
  const create = async () => {
    const store = new Store(join(root, "state"), "session_test");
    await store.acquire();
    if (!store.state) {
      store.state = {
        version: 1, session: "session_test", source: "pi", thread: "thread_test",
        mode: "share", directory: root, worktree: "repo#t=timeline", enabled: true,
        next: 1, pending: [], captured: [], delivered: {}, initialExportDone: false,
      } satisfies State;
      store.save();
    }
    const bridge = new Bridge(new DeltaCli(binary, root), store, host);
    cleanups.push(() => bridge.close());
    return bridge;
  };
  return {
    root, create, notices, remote, aborts: () => aborts,
    flag: (name: string) => writeFileSync(join(root, name), "yes"),
    ledger: () => JSON.parse(readFileSync(join(root, "ledger.json"), "utf8")),
  };
}

test("records a complete tool turn, deduplicates initial export, and releases watch and mount", async () => {
  const env = await fixture();
  const bridge = await env.create();
  const user = { role: "user", timestamp: 1, content: "Read the project" };
  bridge.export([user]);
  bridge.export([user]);
  await bridge.start();
  await bridge.begin();
  bridge.capture({ role: "assistant", timestamp: 2, content: [
    { type: "thinking", thinking: "Inspect first" },
    { type: "toolCall", id: "call1", name: "read", arguments: { path: "README.md" } },
  ] });
  bridge.capture({ role: "toolResult", timestamp: 3, toolCallId: "call1", content: [{ type: "text", text: "Project" }], isError: false });
  bridge.capture({ role: "assistant", timestamp: 4, content: [{ type: "text", text: "Done" }] });
  bridge.settle();
  await bridge.flush();
  const records = env.ledger();
  expect(records.map((record: any) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(records.map((record: any) => record.update.sessionUpdate)).toEqual([
    "user_message", "state_update", "agent_thought", "tool_call_update", "tool_call_update", "agent_message", "state_update",
  ]);
  expect(records.slice(1).every((record: any) => record.turnSequence === 2)).toBe(true);
  expect(env.remote).toEqual([
    "[Ada · agent_message]\nfirst message", "[Ada · agent_message]\nsecond\u2028message",
  ]);
  await bridge.close();
  const stopped = readFileSync(join(env.root, "stopped"), "utf8");
  expect(stopped).toContain("watch");
  expect(stopped).toContain("mount");
});

test("replays an immutable record after a lost receipt and process restart", async () => {
  const env = await fixture();
  env.flag("lose-receipt");
  const first = await env.create();
  first.export([{ role: "user", content: "Persist me", timestamp: 1 }]);
  const original = JSON.stringify(first.state.pending[0]);
  await first.start();
  await waitFor(() => env.notices.some((message) => message.includes("receipt lost")));
  expect(first.state.pending).toHaveLength(1);
  await first.close();
  const resumed = await env.create();
  expect(JSON.stringify(resumed.state.pending[0])).toBe(original);
  await resumed.start();
  await resumed.flush();
  expect(resumed.state.pending).toHaveLength(0);
  expect(env.ledger()).toHaveLength(1);
  expect(env.remote).toHaveLength(2);
});

test("fenced ownership aborts Pi and retains the old turn on late output", async () => {
  const env = await fixture();
  const bridge = await env.create();
  await bridge.start();
  env.flag("fence");
  await expect(bridge.begin()).rejects.toThrow("ownership");
  expect(bridge.fenced).toBe(true);
  expect(env.aborts()).toBeGreaterThan(0);
  bridge.capture({ role: "assistant", timestamp: 2, content: [{ type: "text", text: "late output" }] });
  bridge.settle();
  await bridge.flush();
  expect(bridge.state.pending.some((record) => record.update.sessionUpdate === "agent_message" && record.turnSequence === 1)).toBe(true);
  expect(env.ledger().every((record: any) => record.turnSequence === 1)).toBe(true);
});

test("a watch takeover stops the local turn", async () => {
  const env = await fixture();
  const bridge = await env.create();
  await bridge.start();
  await bridge.begin();
  env.flag("takeover");
  await waitFor(() => bridge.fenced);
  expect(env.aborts()).toBeGreaterThan(0);
});

test("reconnect rebuilds the snapshot without redelivering remote messages", async () => {
  const env = await fixture();
  const bridge = await env.create();
  await bridge.start();
  env.flag("reset-watch");
  await waitFor(() => !bridge.ready);
  unlinkSync(join(env.root, "reset-watch"));
  await waitFor(() => bridge.ready);
  expect(env.remote).toHaveLength(2);
});

test("invalid receipts retain the outbox and prevent local tools from obtaining ownership", async () => {
  const env = await fixture();
  const bridge = await env.create();
  await bridge.start();
  env.flag("bad-receipt");
  await expect(bridge.begin()).rejects.toThrow("acknowledgment");
  expect(bridge.state.pending).toHaveLength(1);
  expect(existsSync(bridge.store.path)).toBe(true);
});

test("long remote snapshots bound context while naming omitted history", async () => {
  const env = await fixture();
  env.flag("large-snapshot");
  const bridge = await env.create();
  await bridge.start();
  expect(env.remote.join("\n").length).toBeLessThan(65_000);
  expect(env.remote[0]).toContain("older Delta items omitted");
  expect(env.remote.some((text) => text.includes("Truncated"))).toBe(true);
});

test("a second process cannot own the same producer ledger", async () => {
  const env = await fixture();
  const first = await env.create();
  const second = new Store(join(env.root, "state"), "session_test");
  await expect(second.acquire()).rejects.toThrow();
  await first.close();
  await second.acquire();
  await second.close();
});

test("resuming a crashed turn closes it with its original turn sequence", async () => {
  const env = await fixture();
  const first = await env.create();
  await first.start();
  // Seed the durable ledger left by a dead process, without an active local run.
  first.state.turn = first.state.next;
  first.store.enqueue([{ sessionUpdate: "state_update", state: "running" }], first.state.turn);
  await first.flush();
  await first.close();
  const resumed = await env.create();
  await resumed.start();
  await resumed.flush();
  expect(env.ledger().map((record: any) => [record.update.state, record.turnSequence])).toEqual([
    ["running", 1], ["idle", 1],
  ]);
});
