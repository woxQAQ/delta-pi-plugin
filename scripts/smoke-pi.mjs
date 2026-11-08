import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "deltapi-pi-smoke-"));
const child = spawn("pi", [
  "--mode", "rpc", "--no-session", "--offline", "--no-approve",
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
  "-e", resolve("src/index.ts"),
], {
  cwd: directory,
  env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "pi-agent"), DELTAPI_STATE_DIR: join(directory, "state"), PI_TELEMETRY: "0" },
  stdio: "pipe",
});
let stdout = "";
let stderr = "";
let verified = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  for (const line of stdout.split("\n")) {
    try {
      const frame = JSON.parse(line);
      if (frame.type !== "response" || frame.id !== "commands") continue;
      if (!frame.success || !frame.data.commands.some((command) => command.name === "delta")) {
        throw new Error("Pi did not register the delta command");
      }
      verified = true;
      child.stdin.end();
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      stderr += String(error);
      child.kill("SIGTERM");
    }
  }
});
child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (!verified || code !== 0 || /Failed to load extension|Extension error/i.test(stderr)) {
    throw new Error(`Pi smoke test failed (${code})\n${stderr}\n${stdout}`);
  }
  console.log("Pi loaded deltapi and exposed /delta through RPC; no model request was sent.");
} finally {
  clearTimeout(timer);
  rmSync(directory, { recursive: true, force: true });
}
