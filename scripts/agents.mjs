#!/usr/bin/env node
// Agent chain: six agents with one job each; every agent gets the findings of the ones before it.
//   node scripts/agents.mjs                                   (module and profile default to config/run.json)
//   node scripts/agents.mjs --module "import job"            (names from modules.json)
//   node scripts/agents.mjs --profile avl --module "import job" --from coverage-matcher      (resume latest run)
//   node scripts/agents.mjs --profile avl --module "conductor" --skip code-analyst --limit 10
//   node scripts/agents.mjs --module "grid export" --extra-stories runs/avl/rovo/grid-export.json   (Rovo candidates)
// Each agent runs headless (claude -p --agent <name>) with a tool allowlist, runs its own pipeline stage,
// may write one review file, and ends with a structured handoff. Tokens of every agent session are
// logged next to the pipeline tokens (stage "agent:<name>").
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ROOT, loadEnv, loadProfile, loadRunConfig, resolveModule } from "./lib/config.mjs";
import { resolveClaudeBin, spawnClaude, usageRecord } from "./lib/claude.mjs";
import { RunContext } from "./lib/context.mjs";
import { STAGE_FUNCS } from "./lib/stages.mjs";
import { loadReview } from "./lib/reviews.mjs";
import { TokenLog, totalTokens, summarizeTokens } from "./lib/tokens.mjs";
import { readJson, writeJson, slug } from "./lib/util.mjs";

export const CHAIN = [
  { name: "module-scout", stage: "scope", review: "scout" },
  { name: "requirements-analyst", stage: "requirements", review: "requirements" },
  { name: "code-analyst", stage: "code", review: "code" },
  { name: "coverage-matcher", stage: "match", review: "match" },
  { name: "test-designer", stage: "draft", review: "drafts" },
  { name: "reporter", stage: "report", review: null },
];

const ZEPHYR_READ = ["get_test_case", "get_test_steps", "get_issue_test_cases", "search_test_cases", "list_folders"].map((t) => `mcp__zephyr__${t}`);

/** Exactly what each agent may do. Everything else is denied (--permission-mode dontAsk). */
export function allowedTools(agent, rel) {
  const common = ["Read", "Glob", "Grep", "Bash(node scripts/inspect.mjs *)"];
  const review = agent.review ? [`Edit(./${rel}/review/*.json)`] : [];
  // Only the scout runs its stage itself (it chooses the keywords); later stages are run by the orchestrator.
  const stage = agent.stage === "scope" ? ["Bash(node scripts/run.mjs --stage scope *)"] : [];
  const extra = {
    "module-scout": ["Bash(node scripts/modules.mjs *)", "Bash(node scripts/code-map.mjs *)", "mcp__zephyr__list_folders"],
    "code-analyst": ["Bash(node scripts/code-map.mjs *)"],
    "coverage-matcher": ZEPHYR_READ,
    "test-designer": ["mcp__zephyr__list_folders", "mcp__zephyr__get_test_case"],
  }[agent.name] ?? [];
  return [...common, ...stage, ...review, ...extra];
}

const DENIED = ["Read(./.env)", "Read(./.env.local)", "Read(./zephyr_mcp/.env)", "Read(./**/.env*)"];

export function buildPrompt({ agent, rel, profile, moduleWords, keywords, limit, previous, configured = null, extraStories = null }) {
  const L = [];
  L.push(`Run directory: ${rel}   (use exactly this path in every command)`);
  L.push(`Profile: ${profile.name} (Jira ${profile.jira.projectKey}, Zephyr ${profile.zephyr.projectKey}, folder root "${profile.zephyr.folderRoot}")`);
  L.push(`Module requested by the user: "${moduleWords}"`);
  if (configured) {
    L.push(`This module is CONFIGURED in profiles/${profile.name}/modules.json as "${configured.name}" — the user's settings, use them as given:`);
    L.push(`  path: ${configured.path}`);
    L.push(`  keywords: ${(configured.keywords ?? []).join(", ") || "(none)"} — applied automatically by the scope stage; you may ADD keywords, never remove these`);
    if (configured.includeStories?.length) L.push(`  always included: ${configured.includeStories.join(", ")}`);
    if (configured.excludeStories?.length) L.push(`  always excluded (already dropped by the scope stage): ${configured.excludeStories.join(", ")}`);
    if (configured.zephyrFolder) L.push(`  Zephyr folder for new cases: ${configured.zephyrFolder}`);
    if (configured.notes) L.push(`  notes: ${configured.notes}`);
    if (agent.name === "module-scout") L.push(`  → Skip module discovery; run the scope stage with --scope module:${configured.path} (add --keywords only for extra words), then check the story set.`);
  }
  if (keywords) L.push(`Keywords suggested by the user: ${keywords}`);
  if (limit) L.push(`Story limit for this run: ${limit} (pass --limit ${limit} to the scope stage)`);
  if (extraStories) L.push(`Candidate stories from a Rovo search: ${extraStories} (pass --extra-stories ${extraStories} to the scope stage; they show as module source "rovo" and must be confirmed or dropped by you)`);
  if (agent.review) L.push(`Your review file (optional, only if you change something): ${rel}/review/${agent.review}.json — schema: schema/review/${agent.review}.schema.json`);
  L.push("");
  L.push("Commands you may run:");
  if (agent.name === "module-scout") {
    L.push(`  node scripts/modules.mjs --profile ${profile.name} --find "<words>"`);
    L.push(`  node scripts/run.mjs --stage scope --run-dir ${rel} --profile ${profile.name} --scope module:<path> --keywords "<k1>,<k2>"${limit ? ` --limit ${limit}` : ""}${extraStories ? ` --extra-stories ${extraStories}` : ""}`);
  } else if (agent.stage !== "report") {
    L.push(`  (The ${agent.stage} stage has ALREADY been run for you — do not run it; review its results.)`);
  }
  L.push(`  node scripts/inspect.mjs --run-dir ${rel} --what <stories|story|scenarios|code|matches|candidates|gaps|handoffs> [--key KEY] [--filter text]`);
  L.push("");
  if (previous.length) {
    L.push("Findings forwarded by the earlier agents:");
    for (const h of previous) {
      L.push(`## ${h.agent} (${h.status})`);
      for (const f of h.findings ?? []) L.push(`- ${f}`);
      if (h.forwardNotes) L.push(`Forwarded to you: ${h.forwardNotes}`);
    }
    L.push("");
  }
  L.push("Working rules:");
  L.push("- Only the commands above are allowed in Bash. Use Read, Glob and Grep for files (no cat/ls/heredocs); write your review file with the Write tool.");
  if (agent.review) L.push("- Your review file is applied when the NEXT stage runs. Do not re-run your own stage to see it take effect.");
  L.push("- inspect.mjs output is a compact VIEW of the run state; a shortened view does not mean the source data is incomplete.");
  L.push("");
  L.push("Do your task as described in your instructions, then finish with the structured handoff.");
  return L.join("\n");
}

function latestRunDir(profile, moduleWords) {
  const base = path.join(ROOT, "runs", profile.name);
  const suffix = `_agents-${slug(moduleWords)}`;
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.endsWith(suffix)).sort() : [];
  return dirs.length ? path.join(base, dirs.at(-1)) : null;
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      profile: { type: "string" }, module: { type: "string" }, keywords: { type: "string" }, limit: { type: "string" },
      "extra-stories": { type: "string" }, "run-dir": { type: "string" }, from: { type: "string" }, until: { type: "string" }, skip: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cfg = loadRunConfig();
  a.module ??= cfg.defaultModule; // --module overrides config/run.json defaultModule
  if (a.help || !a.module) {
    console.log(`Usage: node scripts/agents.mjs [--profile <name>] [--module "<plain words>"] [--keywords "a,b"] [--limit n]
         [--extra-stories <file|K1,K2>] [--from <agent>] [--until <agent>] [--skip <agent,agent>] [--run-dir <dir>]
--module defaults to config/run.json defaultModule (${cfg.defaultModule ? `"${cfg.defaultModule}"` : "not set"}).
Agents: ${CHAIN.map((c) => c.name).join(" → ")}`);
    process.exit(a.help ? 0 : 2);
  }
  loadEnv();
  const profile = loadProfile(a.profile); // defaults to config/run.json defaultProfile
  const configured = resolveModule(profile, a.module);
  const names = CHAIN.map((c) => c.name);
  for (const n of [a.from, a.until, ...(a.skip ?? "").split(",")].filter(Boolean)) {
    if (!names.includes(n)) throw new Error(`Unknown agent '${n}'. Agents: ${names.join(", ")}`);
  }
  const fromIdx = a.from ? names.indexOf(a.from) : 0;
  const untilIdx = a.until ? names.indexOf(a.until) : names.length - 1;
  const skip = new Set((a.skip ?? "").split(",").filter(Boolean));
  if (skip.has("module-scout")) throw new Error("module-scout cannot be skipped: it decides the scope. Use run.mjs --scope module:<path> for a plain pipeline run.");

  let runDir = a["run-dir"] ? path.resolve(a["run-dir"]) : fromIdx > 0 ? latestRunDir(profile, a.module) : null;
  if (fromIdx > 0 && !runDir) throw new Error(`--from ${a.from}: no earlier agent run found for "${a.module}". Pass --run-dir.`);
  if (!runDir) runDir = path.join(ROOT, "runs", profile.name, `${new Date().toISOString().slice(0, 10)}_agents-${slug(a.module)}`);
  if (fromIdx === 0) {
    fs.rmSync(path.join(runDir, "handoff"), { recursive: true, force: true });
    fs.rmSync(path.join(runDir, "review"), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(runDir, "handoff"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "review"), { recursive: true });
  const rel = path.relative(ROOT, runDir).split(path.sep).join("/");
  const bin = resolveClaudeBin(cfg.claude.bin);
  const handoffSchema = readJson(path.join(ROOT, "schema", "handoff.schema.json"));
  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  log(`Agent chain for "${a.module}" (profile ${profile.name}) → ${rel}`);

  const handoffPath = (i, name) => path.join(runDir, "handoff", `${String(i + 1).padStart(2, "0")}-${name}.json`);
  const previousHandoffs = (i) => CHAIN.slice(0, i).map((c, j) => readJson(handoffPath(j, c.name), null)).filter(Boolean);
  const stateExists = () => fs.existsSync(path.join(runDir, "state.json"));
  const tokenLog = () => new TokenLog(path.join(runDir, "token_log.jsonl"));
  if (fromIdx === 0) fs.rmSync(path.join(runDir, "token_log.jsonl"), { force: true });

  const runStage = async (stage) => {
    const ctx = RunContext.load(runDir, {});
    await STAGE_FUNCS[stage](ctx);
    ctx.save();
  };

  let stopped = null;
  for (let i = fromIdx; i <= untilIdx; i++) {
    const agent = CHAIN[i];
    const budget = cfg.claude.maxTokensPerRun;
    if (budget && tokenLog().newTokens() >= budget) {
      stopped = { agent: agent.name, status: "failed", question: `Token budget of ${budget.toLocaleString("en-US")} reached before ${agent.name}.` };
      break;
    }
    if (skip.has(agent.name)) {
      log(`${agent.name}: skipped — running stage ${agent.stage} without agent review`);
      if (agent.stage !== "report") await runStage(agent.stage);
      writeJson(handoffPath(i, agent.name), { order: i + 1, agent: agent.name, status: "ok", findings: [`Skipped by --skip; stage ${agent.stage} ran without agent review.`], forwardNotes: "", outputs: [], tokens: 0 });
      continue;
    }
    if (agent.name === "reporter") {
      // The reporter reads the finished report, so build it first (0 tokens); it is rebuilt after with the reporter's summary.
      await runStage("report");
    } else if (agent.stage !== "scope") {
      // The orchestrator runs the stage (no shell time limit, no agent tokens spent waiting); the agent then reviews it.
      log(`${agent.name}: running stage ${agent.stage}…`);
      await runStage(agent.stage);
    }

    const prompt = buildPrompt({ agent, rel, profile, moduleWords: a.module, keywords: a.keywords, limit: a.limit, previous: previousHandoffs(i), configured, extraStories: a["extra-stories"] });
    const model = cfg.agents?.model?.[agent.name] ?? cfg.agents?.model?.default;
    const args = [
      "-p", "--agent", agent.name, "--output-format", "json", "--json-schema", JSON.stringify(handoffSchema),
      "--permission-mode", "dontAsk", "--allowedTools", ...allowedTools(agent, rel), "--disallowedTools", ...DENIED,
      "--mcp-config", path.join(ROOT, ".mcp.json"), "--strict-mcp-config", "--no-session-persistence",
      ...(model ? ["--model", model] : []),
    ];
    log(`${agent.name}: started`);
    const started = Date.now();
    let handoff;
    try {
      const j = await spawnClaude({ bin, args, prompt, cwd: ROOT, timeoutMs: cfg.agents?.timeoutMs ?? 1_800_000 });
      const record = usageRecord(j, { model: model ?? "" });
      tokenLog().add({ ...record, stage: `agent:${agent.name}`, jiraKeys: [], module: null, items_in: 0, items_out: 0, denied: (j.permission_denials ?? []).length });
      const out = j.structured_output;
      handoff = out
        ? { ...out }
        : { status: "failed", findings: [`Agent ended without a structured handoff: ${String(j.result ?? "").slice(0, 300)}`], forwardNotes: "", outputs: [] };
      handoff.tokens = totalTokens(record);
      if (j.permission_denials?.length) handoff.findings.push(`${j.permission_denials.length} tool call(s) were denied by the allowlist: ${[...new Set(j.permission_denials.map((d) => d.tool_name))].join(", ")}`);
    } catch (err) {
      handoff = { status: "failed", findings: [`Agent process failed: ${err.message.slice(0, 300)}`], forwardNotes: "", outputs: [], tokens: 0 };
    }
    Object.assign(handoff, { order: i + 1, agent: agent.name, model: model ?? "", durationMs: Date.now() - started });

    // Validate the review file now, so a bad one is reported here instead of failing the next stage.
    if (agent.review && fs.existsSync(path.join(runDir, "review", `${agent.review}.json`)) && stateExists()) {
      try {
        loadReview(RunContext.load(runDir, {}), agent.review);
      } catch (err) {
        const bad = path.join(runDir, "review", `${agent.review}.invalid.json`);
        fs.renameSync(path.join(runDir, "review", `${agent.review}.json`), bad);
        handoff.findings.push(`Review file rejected and set aside (${path.basename(bad)}): ${err.message.slice(0, 200)}`);
      }
    }
    if (agent.stage === "scope" && handoff.status === "ok" && !stateExists()) {
      handoff.status = "failed";
      handoff.findings.push("module-scout reported ok but never ran the scope stage.");
    }
    writeJson(handoffPath(i, agent.name), handoff);
    log(`${agent.name}: ${handoff.status} · ${handoff.tokens.toLocaleString("en-US")} tokens · ${Math.round(handoff.durationMs / 1000)}s`);
    for (const f of handoff.findings ?? []) log(`   - ${f}`);
    if (handoff.status !== "ok") {
      stopped = handoff;
      break;
    }
  }

  // Final report: includes every handoff and every agent's tokens.
  if (stateExists()) {
    const ctx = RunContext.load(runDir, {});
    const result = await STAGE_FUNCS.report(ctx);
    ctx.save();
    const tok = summarizeTokens(ctx.tokenLog.records);
    console.log(`
${stopped ? `STOPPED at ${stopped.agent} (${stopped.status}): ${stopped.question ?? stopped.findings?.at(-1) ?? ""}\n` : ""}Tokens used: ${tok.total.total_tokens.toLocaleString("en-US")} (agents ${tok.agents.total_tokens.toLocaleString("en-US")}, pipeline ${tok.pipeline.total_tokens.toLocaleString("en-US")})
Workbook: ${result.workbookPath}
Summary:  ${result.summaryPath}
Latest:   ${path.join(ROOT, "runs", profile.name, "latest-summary.md")}`);
  } else {
    const text = `# Coverage summary — "${a.module}"\n\n> **The agent chain stopped at \`${stopped?.agent}\` (${stopped?.status}).** ${stopped?.question ?? ""}\n\n${(stopped?.findings ?? []).map((f) => `- ${f}`).join("\n")}\n\nRe-run with a more specific module, e.g. \`node scripts/agents.mjs --profile ${profile.name} --module "<exact module>"\`.\n`;
    fs.writeFileSync(path.join(runDir, "summary.md"), text);
    fs.writeFileSync(path.join(ROOT, "runs", profile.name, "latest-summary.md"), text);
    console.log(`\nSTOPPED at ${stopped?.agent}: ${stopped?.question ?? ""}\nSummary: ${path.join(runDir, "summary.md")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
