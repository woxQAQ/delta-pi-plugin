import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import deltapi from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function session(confirmation: boolean) {
  const root = mkdtempSync(join(tmpdir(), "deltapi-session-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const binary = join(root, "delta");
  copyFileSync(resolve("test/fixtures/delta.mjs"), binary);
  chmodSync(binary, 0o755);
  const oldCli = process.env.DELTAPI_CLI;
  const oldState = process.env.DELTAPI_STATE_DIR;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  process.env.DELTAPI_CLI = binary;
  process.env.DELTAPI_STATE_DIR = join(root, "state");
  cleanup.push(async () => {
    if (oldCli === undefined) delete process.env.DELTAPI_CLI; else process.env.DELTAPI_CLI = oldCli;
    if (oldState === undefined) delete process.env.DELTAPI_STATE_DIR; else process.env.DELTAPI_STATE_DIR = oldState;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const remote: any[] = [];
  const branch: any[] = [{ type: "message", message: { role: "user", content: "Original session", timestamp: 1 } }];
  let switched: string | undefined;
  const api = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: any, options: any) => { remote.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, hasUI: true, mode: "tui", isIdle: () => true, abort: () => {},
    sessionManager: {
      getSessionId: () => "session_test",
      getSessionName: () => undefined,
      getBranch: () => branch,
    },
    ui: {
      confirm: async () => confirmation,
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
    },
    switchSession: async (path: string, options: any) => {
      switched = path;
      await handlers.get("session_shutdown")?.({}, ctx);
      await options.withSession(ctx);
      return { cancelled: false };
    },
  };
  deltapi(api);
  await handlers.get("session_start")!({}, ctx);
  cleanup.push(async () => { await handlers.get("session_shutdown")?.({}, ctx); });
  return {
    root, notices, remote, switched: () => switched,
    command: async (value: string) => commands.get("delta").handler(value, ctx),
    restart: async () => {
      await handlers.get("session_shutdown")?.({}, ctx);
      await handlers.get("session_start")?.({}, ctx);
    },
    persistRemote: () => {
      for (const { message } of remote) branch.push({ type: "custom_message", ...message });
    },
    commands: () => existsSync(join(root, "commands.jsonl"))
      ? readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

test("declining share leaves the session local and starts no Delta process", async () => {
  const env = await session(false);
  await env.command("share");
  expect(env.commands()).toEqual([]);
});

test("sharing exports the current session only after confirmation and starts passive remote context", async () => {
  const env = await session(true);
  await env.command("share");
  expect(env.notices.some((notice) => notice.startsWith("Delta connected:"))).toBe(true);
  const commands = env.commands();
  expect(commands.some((command) => command[0] === "worktree" && command[1] === "attach")).toBe(true);
  expect(commands.some((command) => command[1] === "share" && command.includes("organization"))).toBe(true);
  expect(env.remote).toHaveLength(2);
  expect(env.remote.every((delivery) => delivery.options.triggerTurn === false && delivery.options.deliverAs === "nextTurn")).toBe(true);
  await env.command("disconnect");
  const records = JSON.parse(readFileSync(join(env.root, "ledger.json"), "utf8"));
  expect(records[0].update.content[0].text).toBe("Original session");
});

test("restart redelivers queued context but preserves deliveries already stored in Pi history", async () => {
  const env = await session(true);
  await env.command("share");
  expect(env.remote).toHaveLength(2);
  await env.restart();
  expect(env.remote).toHaveLength(4);
  env.persistRemote();
  await env.restart();
  expect(env.remote).toHaveLength(4);
});

test("joining creates a separate session in the mounted directory without exporting the original conversation", async () => {
  const env = await session(true);
  await env.command("join https://delta.dev/join/thread_test");
  const path = env.switched();
  expect(path).toBeDefined();
  // Pi session creation uses its native storage; remove the disposable test session afterwards.
  cleanup.push(async () => { if (path) rmSync(path, { force: true }); });
  const entries = readFileSync(path!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(entries[0].cwd).toBe(env.root);
  expect(entries[0].id).not.toBe("session_test");
  expect(entries.some((entry) => entry.message?.content === "Original session")).toBe(false);
  expect(env.commands().some((command) => ["append", "share", "attach"].includes(command[1]))).toBe(false);
  expect(env.notices.some((notice) => notice.startsWith("Delta session ready"))).toBe(true);
});
