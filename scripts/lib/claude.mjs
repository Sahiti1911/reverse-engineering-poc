// Headless Claude Code calls.
// - callClaude: minimal mode for pipeline stages (no tools, no MCP servers, no settings/CLAUDE.md, a
//   stage system prompt and a JSON schema), so the fixed overhead per call stays around 1-2k tokens.
// - spawnClaude: the raw runner, also used by the agent chain (scripts/agents.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

export function resolveClaudeBin(configured = "auto") {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (configured && configured !== "auto") return configured;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(cmd, ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).find(Boolean);
    if (found) return found.trim();
  } catch {}
  // Fall back to the binary bundled with the VS Code / Cursor extension (newest version wins).
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [];
  for (const editorDir of [".vscode", ".vscode-insiders", ".cursor"]) {
    const extDir = path.join(os.homedir(), editorDir, "extensions");
    if (!fs.existsSync(extDir)) continue;
    for (const d of fs.readdirSync(extDir).filter((d) => d.startsWith("anthropic.claude-code-"))) {
      const bin = path.join(extDir, d, "resources", "native-binary", exe);
      if (fs.existsSync(bin)) candidates.push({ bin, mtime: fs.statSync(bin).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates[0]) return candidates[0].bin;
  throw new Error("Claude CLI not found. Install Claude Code, put `claude` on PATH, or set CLAUDE_BIN in .env");
}

/** Token numbers of one `claude -p --output-format json` result. */
export function usageRecord(j, extra = {}) {
  const u = j.usage ?? {};
  return {
    model: Object.keys(j.modelUsage ?? {})[0] ?? extra.model ?? "",
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    duration_ms: j.duration_ms ?? 0,
    num_turns: j.num_turns ?? 0,
    ...extra,
  };
}

/** Run the CLI with `args`, feed `prompt` on stdin, resolve to the parsed JSON result. */
export function spawnClaude({ bin, args, prompt, cwd, timeoutMs = 900_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`claude exited ${code} without JSON output: ${(stderr || stdout).slice(0, 500)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

const workDir = path.join(os.tmpdir(), "coverage-gap-claude");

/**
 * One structured pipeline call. Resolves to { output, record } where record carries the token numbers;
 * rejects on CLI error, timeout, API error or missing structured output.
 */
export async function callClaude({ bin, model, system, prompt, schema, timeoutMs = 900_000 }) {
  fs.mkdirSync(workDir, { recursive: true });
  const sysFile = path.join(workDir, `sys-${crypto.randomUUID()}.md`);
  fs.writeFileSync(sysFile, system);
  const args = [
    "-p", "--output-format", "json", "--model", model,
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    "--system-prompt-file", sysFile,
    "--json-schema", JSON.stringify(schema),
  ];
  try {
    const j = await spawnClaude({ bin, args, prompt, cwd: workDir, timeoutMs });
    const record = usageRecord(j, { model, input_bytes: Buffer.byteLength(prompt) + Buffer.byteLength(system) });
    if (j.is_error || !j.structured_output) {
      const err = new Error(`claude returned no structured output (${j.subtype ?? "error"}): ${String(j.result ?? "").slice(0, 400)}`);
      err.record = record;
      throw err;
    }
    return { output: j.structured_output, record };
  } finally {
    fs.rmSync(sysFile, { force: true });
  }
}
