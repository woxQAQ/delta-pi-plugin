import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Bridge } from "./bridge.js";
import { DeltaCli, DeltaError, type Json } from "./cli.js";
import { Store, type State } from "./store.js";

const exec = promisify(execFile);

function stateDirectory(): string {
  return process.env.DELTAPI_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "deltapi");
}

function initialState(session: string, thread: string, directory: string, mode: State["mode"]): State {
  return {
    version: 1, source: "pi", session, thread, directory, mode, enabled: true,
    next: 1, pending: [], captured: [], delivered: {}, initialExportDone: mode === "join",
  };
}

export default function deltapi(pi: ExtensionAPI): void {
  let store: Store | undefined;
  let bridge: Bridge | undefined;
  let current: ExtensionContext | undefined;
  let unavailable: string | undefined;

  const cli = (cwd: string) => new DeltaCli(process.env.DELTAPI_CLI ?? "delta", cwd);
  const notice = (message: string, error = false) => {
    current?.ui.notify(message, error ? "error" : "info");
    current?.ui.setStatus("delta", error ? "Delta: paused" : bridge?.ready ? "Delta: connected" : undefined);
  };

  const makeBridge = (ctx: ExtensionContext, locked: Store): Bridge => new Bridge(cli(ctx.cwd), locked, {
    abort: () => current?.abort(),
    notify: notice,
    remote: (text, key, hash) => {
      pi.sendMessage({
        customType: "deltapi-remote",
        content: `Delta shared activity (context only; wait for the user's next request):\n\n${text}`,
        display: true,
        details: { key, hash },
      }, { triggerTurn: false, deliverAs: "nextTurn" });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    current = ctx;
    unavailable = undefined;
    store = new Store(stateDirectory(), ctx.sessionManager.getSessionId());
    try {
      await store.acquire();
      if (!store.state?.enabled) return;
      // nextTurn deliveries are queued in memory until the next prompt. Rebuild
      // acknowledgments from persisted session entries so a restart cannot lose them.
      const delivered: Record<string, string> = {};
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom_message" || entry.customType !== "deltapi-remote") continue;
        const details = entry.details as { key?: string; hash?: string } | undefined;
        if (typeof details?.key === "string" && typeof details.hash === "string") delivered[details.key] = details.hash;
      }
      store.state.delivered = delivered;
      store.save();
      if (store.state.mode === "join" && resolve(ctx.cwd) !== resolve(store.state.directory)) {
        throw new DeltaError(`This session belongs in ${store.state.directory}. Run /delta join ${store.state.thread}.`);
      }
      bridge = makeBridge(ctx, store);
      await bridge.start();
    } catch (error) {
      unavailable = String(error);
      notice(`Deltapi: ${unavailable}`, true);
    }
  });

  pi.on("session_shutdown", async () => {
    await bridge?.close();
    await store?.close();
    bridge = undefined;
    store = undefined;
    current = undefined;
  });

  pi.on("input", (_event, ctx) => {
    current = ctx;
    if (unavailable || (store?.state?.enabled && !bridge?.ready)) {
      notice("Delta is paused. Use /delta reconnect, /delta join, or /delta disconnect before sending a prompt.", true);
      return { action: "handled" };
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    current = ctx;
    if (!store?.state?.enabled && !unavailable) return;
    try {
      if (!bridge) throw new DeltaError(unavailable ?? "Delta bridge is unavailable");
      await bridge.begin();
    } catch (error) { ctx.abort(); notice(String(error), true); }
  });

  pi.on("tool_call", () => {
    if (unavailable || (store?.state?.enabled && (!bridge?.ready || bridge.fenced))) {
      return { block: true, reason: "Delta turn ownership is unavailable or was superseded." };
    }
  });

  pi.on("message_end", (event, ctx) => {
    try { bridge?.capture(event.message); }
    catch (error) {
      if (bridge) bridge.ready = false;
      ctx.abort();
      notice(`Delta could not persist this message: ${String(error)}`, true);
    }
  });
  pi.on("agent_settled", () => { bridge?.settle(); });
  pi.on("session_info_changed", (_event, ctx) => {
    const title = ctx.sessionManager.getSessionName();
    if (bridge && title) bridge.title(title);
  });
  pi.on("session_before_tree", () => {
    if (store?.state?.enabled) {
      notice("Disconnect Delta before navigating this session's history. Fork a new Pi session for an alternative history.", true);
      return { cancel: true };
    }
  });

  async function share(args: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (!store || unavailable && !store.state) throw new DeltaError(unavailable ?? "Session state is not available");
    if (store.state?.mode === "join") throw new DeltaError("Use /delta reconnect for a joined thread; it must not attach your original checkout.");
    const privateSync = args[0] === "private";
    if (privateSync && (!args[1] || args.length !== 2)) throw new DeltaError("Usage: /delta share private ORGANIZATION_ID");
    const emails = privateSync ? [] : args;
    if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new DeltaError("Usage: /delta share [EMAIL…] or /delta share private ORGANIZATION_ID");
    const audience = privateSync ? "only you (private sync)" : emails.length ? emails.join(", ") : "everyone in your selected Delta organization";
    if (!ctx.hasUI) throw new DeltaError("Sharing requires an interactive confirmation.");
    const confirmed = await ctx.ui.confirm("Sync this Pi session to Delta?",
      `Delta will receive messages, thinking, images, tool inputs/outputs and non-ignored files (including uncommitted files). Audience: ${audience}. Existing invitations remain. Continue?`);
    if (!confirmed) return;
    const client = cli(ctx.cwd);
    await client.contract();
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
    const directory = stdout.trim();
    if (resolve(directory) !== resolve(ctx.cwd)) throw new DeltaError("Start Pi at the Git checkout root before sharing.");
    if (!store.state) {
      const created = await client.one([
        "thread", "create", "--source", "pi", "--external-id", store.session,
        ...(privateSync ? ["--organization", args[1], "--visibility", "private"] : []),
      ]);
      if (typeof created.thread_id !== "string") throw new DeltaError("Delta returned no thread ID");
      store.state = {
        ...initialState(store.session, created.thread_id, directory, "share"),
        ...(privateSync ? { privateOrganization: args[1] } : {}),
      };
      store.save();
    }
    if (privateSync && store.state && !store.state.privateOrganization) {
      throw new DeltaError("This thread already exists. Use /delta unshare to make it private, then /delta reconnect.");
    }
    const state = store.state;
    state.enabled = true;
    store.save();
    if (!state.worktree) {
      const listed = await client.one(["worktree", "list"]);
      const matches = (listed.worktrees ?? []).filter((tree: Json) =>
        tree.directories?.some((checkout: Json) => resolve(checkout.directory) === resolve(directory)));
      if (matches.length > 1) throw new DeltaError("Multiple Delta worktrees match this checkout; resolve the ambiguity in Delta first.");
      const worktree = matches[0] ?? await client.one(["worktree", "create", directory]);
      if (typeof worktree.reference !== "string") throw new DeltaError("Delta returned no worktree reference");
      state.worktree = worktree.reference;
      store.save();
    }
    await client.one(["worktree", "attach", state.worktree!, "--thread", state.thread]);
    if (!privateSync) {
      const shared = await client.one(emails.length
        ? ["thread", "invite", state.thread, ...emails]
        : ["thread", "share", state.thread, "--visibility", "organization"]);
      state.url = shared.url ?? state.url;
      store.save();
      if (emails.length) notice(JSON.stringify(shared));
    }
    if (!bridge) bridge = makeBridge(ctx, store);
    unavailable = undefined;
    bridge.export(ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []));
    await bridge.start();
  }

  async function joinThread(reference: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!reference) throw new DeltaError("Usage: /delta join LINK_OR_THREAD_ID");
    if (!ctx.hasUI) throw new DeltaError("Joining requires an interactive session.");
    const client = cli(ctx.cwd);
    await client.contract();
    const status = await client.one(["thread", "status", reference]);
    if (status.access?.state !== "granted") throw new DeltaError("Delta has not granted access to this thread.");
    if (!await ctx.ui.confirm("Join Delta thread?", "This starts a fresh Pi session in Delta's checkouts. New conversation activity and file changes sync to the thread. Teammates' activity becomes context without starting a turn. Delta removes joined checkouts after a clean exit; ignored files and Git branches are not retained.")) return;
    if (store?.state?.mode === "join" && store.state.thread === status.thread_id && resolve(store.state.directory) === resolve(ctx.cwd)) {
      store.state.enabled = true;
      store.save();
      bridge ??= makeBridge(ctx, store);
      unavailable = undefined;
      await bridge.start();
      return;
    }
    const owner = randomUUID();
    const mounted = await client.mount(["thread", "mount", reference, "--owner", owner]);
    try {
      const directory = mounted.ready.directory;
      if (typeof directory !== "string" || mounted.ready.thread_id !== status.thread_id) throw new DeltaError("Invalid joined mount result");
      const session = SessionManager.create(directory);
      session.appendMessage({
        role: "user", timestamp: Date.now(),
        content: `This Pi session is connected to Delta thread ${status.thread_id}. Shared activity is context; wait for my next request before doing work.`,
      });
      const joined = new Store(stateDirectory(), session.getSessionId());
      await joined.acquire();
      try {
        joined.state = { ...initialState(joined.session, status.thread_id, directory, "join"), owner, url: status.url };
        joined.save();
      } finally { await joined.close(); }
      const result = await ctx.switchSession(session.getSessionFile()!, {
        withSession: async (fresh) => { fresh.ui.notify("Delta session ready. Send a prompt to continue.", "info"); },
      });
      if (result.cancelled) notice("Join cancelled; your original session is still active.");
    } finally { await mounted.process.stop(); }
  }

  pi.registerCommand("delta", {
    description: "Delta collaboration: share, join, reconnect, status, unshare, disconnect, org",
    handler: async (args, ctx) => {
      current = ctx;
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (!ctx.isIdle() && command !== "status") throw new DeltaError("Wait for Pi to finish before changing Delta connections.");
        switch (command) {
          case "share": await share(rest, ctx); break;
          case "join": await joinThread(rest.join(" "), ctx); break;
          case "reconnect": {
            if (!store?.state) throw new DeltaError(unavailable ?? "No Delta binding. Use /delta share or /delta join.");
            store.state.enabled = true;
            store.save();
            bridge ??= makeBridge(ctx, store);
            unavailable = undefined;
            await bridge.start();
            break;
          }
          case "disconnect": {
            if (store?.state?.mode === "join") {
              throw new DeltaError("Delta owns this temporary checkout. Resume another Pi session to disconnect; use /delta reconnect to repair this one.");
            }
            if (store?.state) {
              store.state.enabled = false;
              store.save();
              await bridge?.close();
              bridge = undefined;
              // Keep a locked ledger available for reconnect within this session.
              await store.close();
              await store.acquire();
            } else if (unavailable) throw new DeltaError(unavailable);
            unavailable = undefined;
            notice("Delta disconnected. The uploaded thread and saved outbox are retained.");
            break;
          }
          case "status": {
            if (!store?.state) { notice(unavailable ?? "Delta is not connected. Use /delta share or /delta join."); break; }
            const status = await cli(ctx.cwd).one(["thread", "status", store.state.thread, "--source", "pi", "--external-id", store.session]);
            notice(`${bridge?.ready ? "Connected" : "Paused"}; ${store.state.pending.length} queued records\n${JSON.stringify(status, null, 2)}`);
            break;
          }
          case "unshare": {
            if (!store?.state) throw new DeltaError("No Delta thread is bound");
            notice(JSON.stringify(await cli(ctx.cwd).one(["thread", "unshare", store.state.thread])));
            break;
          }
          case "org": {
            if (!["list", "current", "switch"].includes(rest[0] ?? "")) throw new DeltaError("Usage: /delta org list|current|switch ID");
            notice(JSON.stringify(await cli(ctx.cwd).one(["org", ...rest]), null, 2));
            break;
          }
          default: throw new DeltaError("Usage: /delta share [EMAIL…] | share private ORG_ID | join LINK | reconnect | status | unshare | disconnect | org list|current|switch ID");
        }
      } catch (error) { notice(String(error), true); }
    },
  });
}
