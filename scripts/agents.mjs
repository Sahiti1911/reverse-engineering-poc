#!/usr/bin/env node
// Agent pipeline, configured in config/config.yaml (`pipeline`): phases run in order, the agents of one phase
// run in parallel, and every agent gets the findings of the phases before it.
//   node scripts/agents.mjs                                   (module and profile default to config/config.yaml)
//   node scripts/agents.mjs --module "import job"            (names from modules.json)
//   node scripts/agents.mjs --module "import job" --from context-builder       (resume the latest run from that phase)
//   node scripts/agents.mjs --module "conductor" --skip ui-explorer --limit 10
//   node scripts/agents.mjs --module "grid export" --env test --extra-stories runs/avl/rovo/grid-export.json
// The orchestrator runs each phase's script stages first (0 agent tokens); then the phase's agents run headless
// (claude -p --agent <name>) with a tool allowlist, may write one review file, and end with a structured handoff.
// Tokens of every agent session are logged next to the pipeline tokens (stage "agent:<name>").
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ROOT, loadEnv, loadProfile, loadRunConfig, resolveModule } from "./lib/config.mjs";
import { resolveClaudeBin, spawnClaude, usageRecord } from "./lib/claude.mjs";
import { RunContext } from "./lib/context.mjs";
import { STAGE_FUNCS } from "./lib/stages.mjs";
import { loadReview } from "./lib/reviews.mjs";
import { AGENTS, PHASES, resolvePipeline, resolveEnvironment, uiTools, checkUiMode, playwrightArgs, blockWritesScript } from "./lib/pipeline.mjs";
import { TokenLog, totalTokens, summarizeTokens } from "./lib/tokens.mjs";
import { readJson, writeJson, slug } from "./lib/util.mjs";

/** Script stages per phase, run by the orchestrator before the phase's agents. Explorer stages run only when their agent is configured. */
const PHASE_STAGES = {
  scope: [], // the module-scout runs the scope stage itself: it chooses the module and keywords
  explore: [{ stage: "requirements" }, { stage: "code", agent: "code-analyst" }, { stage: "zephyr", agent: "zephyr-explorer" }],
  context: [{ stage: "context" }],
  design: [{ stage: "draft" }],
  validate: [{ stage: "validate" }],
  report: [{ stage: "report" }],
};

/** Explorers whose failure does not stop the run (when agents.continueWhenExplorerFails is true). */
const OPTIONAL_EXPLORERS = ["code-analyst", "ui-explorer", "zephyr-explorer"];

const ZEPHYR_READ = ["get_test_case", "get_test_steps", "get_issue_test_cases", "search_test_cases", "list_folders"].map((t) => `mcp__zephyr__${t}`);

/** Exactly what each agent may do. Everything else is denied (--permission-mode dontAsk). */
export function allowedTools(agent, rel, { uiMode = "read-only" } = {}) {
  const common = ["Read", "Glob", "Grep", "Bash(node scripts/inspect.mjs *)"];
  const review = agent.review ? [`Edit(./${rel}/review/*.json)`] : [];
  // Only the scout runs its stage itself (it chooses the keywords); later stages are run by the orchestrator.
  const stage = agent.stage === "scope" ? ["Bash(node scripts/run.mjs --stage scope *)"] : [];
  const extra = {
    "module-scout": ["Bash(node scripts/modules.mjs *)", "Bash(node scripts/code-map.mjs *)", "mcp__zephyr__list_folders"],
    "code-analyst": ["Bash(node scripts/code-map.mjs *)"],
    "ui-explorer": uiTools(uiMode),
    "zephyr-explorer": ZEPHYR_READ,
    "context-builder": ZEPHYR_READ,
    "test-designer": ["mcp__zephyr__list_folders", "mcp__zephyr__get_test_case"],
    "coverage-validator": ZEPHYR_READ,
  }[agent.name] ?? [];
  return [...common, ...stage, ...review, ...extra];
}

const DENIED = ["Read(./.env)", "Read(./.env.local)", "Read(./zephyr_mcp/.env)", "Read(./**/.env*)", "Read(./cache/*/ui/**)"];

export function buildPrompt({ agent, rel, profile, moduleWords, keywords, limit, previous, configured = null, extraStories = null, ui = null, redesign = null }) {
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
    if (configured.uiRoutes?.length) L.push(`  UI routes: ${configured.uiRoutes.join(", ")}`);
    if (configured.notes) L.push(`  notes: ${configured.notes}`);
    if (agent.name === "module-scout") L.push(`  → Skip module discovery; run the scope stage with --scope module:${configured.path} (add --keywords only for extra words), then check the story set.`);
  }
  if (keywords) L.push(`Keywords suggested by the user: ${keywords}`);
  if (limit) L.push(`Story limit for this run: ${limit} (pass --limit ${limit} to the scope stage)`);
  if (extraStories) L.push(`Candidate stories from a Rovo search: ${extraStories} (pass --extra-stories ${extraStories} to the scope stage; they show as module source "rovo" and must be confirmed or dropped by you)`);
  if (ui) {
    L.push(`UI environment: ${ui.envName} — ${ui.baseUrl} (the browser can only reach this origin)`);
    L.push(`UI mode: ${ui.mode} — ${{ observe: "navigate and read pages only; you have no click or type tools", "read-only": "you may click, type and open dialogs; the browser blocks every POST/PUT/PATCH/DELETE the app sends, so saving fails on purpose", full: "the app may save and delete data on this environment" }[ui.mode]}`);
    L.push(`Page budget: at most ${ui.maxPages} distinct pages or dialogs. Screenshots are saved under ${ui.outputDir}.`);
  }
  if (agent.review) L.push(`Your review file (optional, only if you change something): ${rel}/review/${agent.review}.json — schema: schema/review/${agent.review}.schema.json`);
  L.push("");
  L.push("Commands you may run:");
  if (agent.name === "module-scout") {
    L.push(`  node scripts/modules.mjs --profile ${profile.name} --find "<words>"`);
    L.push(`  node scripts/run.mjs --stage scope --run-dir ${rel} --profile ${profile.name} --scope module:<path> --keywords "<k1>,<k2>"${limit ? ` --limit ${limit}` : ""}${extraStories ? ` --extra-stories ${extraStories}` : ""}`);
  } else if (!agent.stage) {
    L.push("  (There is no script stage for you: you explore the source yourself.)");
  } else if (agent.stage !== "report") {
    L.push(`  (The ${agent.stage} stage has ALREADY been run for you — do not run it; review its results.)`);
  }
  L.push(`  node scripts/inspect.mjs --run-dir ${rel} --what <stories|story|scenarios|code|candidates|matches|gaps|validation|handoffs> [--key KEY] [--filter text]`);
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
  if (redesign?.length) {
    L.push("REDESIGN ROUND: the coverage-validator sent these drafts back. Fix each one through `edits` in your review file (keep your earlier edits in the file):");
    for (const v of redesign) L.push(`- ${v.gapId}: ${v.reasoning}`);
    L.push("");
  }
  L.push("Working rules:");
  L.push("- Only the commands above are allowed in Bash. Use Read, Glob and Grep for files (no cat/ls/heredocs); write your review file with the Write tool.");
  if (agent.review) L.push("- Your review file is applied when a LATER stage runs. Do not re-run any stage to see it take effect.");
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

/**
 * MCP servers for one run: the project's servers (.mcp.json) plus Playwright when the UI explorer runs.
 * Returns { file, ui } where ui is null when the UI explorer cannot run (with the reason in `uiProblem`).
 */
function prepareMcp({ runDir, cfg, envName, uiWanted }) {
  const servers = { ...readJson(path.join(ROOT, ".mcp.json")).mcpServers };
  let ui = null;
  let uiProblem = null;
  if (uiWanted) {
    try {
      const opts = cfg.agents["ui-explorer"] ?? {};
      const env = resolveEnvironment(cfg, envName);
      const mode = opts.mode ?? "read-only";
      checkUiMode(mode, env);
      const outputDir = path.join(runDir, "ui");
      fs.mkdirSync(outputDir, { recursive: true });
      let storageStatePath = null;
      if (env.login.method === "storage-state") {
        storageStatePath = path.resolve(ROOT, env.login.storageState ?? "");
        if (!env.login.storageState || !fs.existsSync(storageStatePath)) {
          throw new Error(`No saved login for environment '${env.name}' at ${env.login.storageState}. Run: npm run ui-login -- --env ${env.name}`);
        }
      }
      let initScriptPath = null;
      if (mode === "read-only") {
        initScriptPath = path.join(outputDir, "block-writes.js");
        fs.writeFileSync(initScriptPath, blockWritesScript(opts.allowedWriteUrls ?? []));
      }
      const args = playwrightArgs({ pkg: opts.playwrightMcp ?? "@playwright/mcp@0.0.83", env, headless: opts.headless ?? true, outputDir, storageStatePath, initScriptPath });
      servers.playwright = process.platform === "win32" ? { type: "stdio", command: "cmd", args: ["/c", "npx", ...args] } : { type: "stdio", command: "npx", args };
      ui = { envName: env.name, baseUrl: env.uiBaseUrl, mode, maxPages: opts.maxPages ?? 8, outputDir: path.relative(ROOT, outputDir).split(path.sep).join("/") };
    } catch (err) {
      uiProblem = err.message;
    }
  }
  const file = path.join(runDir, "mcp.json");
  writeJson(file, { mcpServers: servers });
  return { file, ui, uiProblem };
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      profile: { type: "string" }, module: { type: "string" }, keywords: { type: "string" }, limit: { type: "string" }, env: { type: "string" },
      "extra-stories": { type: "string" }, "run-dir": { type: "string" }, from: { type: "string" }, until: { type: "string" }, skip: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cfg = loadRunConfig();
  const phases = resolvePipeline(cfg);
  const configuredAgents = phases.flatMap((p) => p.agents);
  a.module ??= cfg.defaultModule; // --module overrides config.yaml defaultModule
  if (a.help || !a.module) {
    console.log(`Usage: node scripts/agents.mjs [--profile <name>] [--module "<plain words>"] [--env <environment>] [--keywords "a,b"] [--limit n]
         [--extra-stories <file|K1,K2>] [--from <agent>] [--until <agent>] [--skip <agent,agent>] [--run-dir <dir>]
--module defaults to config.yaml defaultModule (${cfg.defaultModule ? `"${cfg.defaultModule}"` : "not set"}); --env to environment (${cfg.environment ?? "not set"}).
Pipeline (config/config.yaml): ${phases.map((p) => p.agents.map((x) => x.name).join(" + ")).join(" → ")}`);
    process.exit(a.help ? 0 : 2);
  }
  loadEnv();
  const profile = loadProfile(a.profile); // defaults to config.yaml defaultProfile
  const configured = resolveModule(profile, a.module);
  const names = configuredAgents.map((x) => x.name);
  for (const n of [a.from, a.until, ...(a.skip ?? "").split(",")].filter(Boolean)) {
    if (!names.includes(n)) throw new Error(`Agent '${n}' is not in the configured pipeline. Agents: ${names.join(", ")}`);
  }
  const phaseOf = (n) => PHASES.indexOf(AGENTS[n].phase);
  const fromPhase = a.from ? phaseOf(a.from) : 0;
  const untilPhase = a.until ? phaseOf(a.until) : PHASES.length - 1;
  const skip = new Set((a.skip ?? "").split(",").filter(Boolean));
  if (skip.has("module-scout")) throw new Error("module-scout cannot be skipped: it decides the scope. Use run.mjs --scope module:<path> for a plain pipeline run.");

  let runDir = a["run-dir"] ? path.resolve(a["run-dir"]) : fromPhase > 0 ? latestRunDir(profile, a.module) : null;
  if (fromPhase > 0 && !runDir) throw new Error(`--from ${a.from}: no earlier agent run found for "${a.module}". Pass --run-dir.`);
  if (!runDir) runDir = path.join(ROOT, "runs", profile.name, `${new Date().toISOString().slice(0, 10)}_agents-${slug(a.module)}`);
  // Agents that run again write fresh reviews and handoffs; stale ones would be merged on top of new results.
  const rerun = configuredAgents.filter((x) => phaseOf(x.name) >= fromPhase);
  if (fromPhase === 0) {
    fs.rmSync(path.join(runDir, "handoff"), { recursive: true, force: true });
    fs.rmSync(path.join(runDir, "review"), { recursive: true, force: true });
    fs.rmSync(path.join(runDir, "token_log.jsonl"), { force: true });
  } else {
    for (const x of rerun.filter((y) => y.review)) fs.rmSync(path.join(runDir, "review", `${x.review}.json`), { force: true });
  }
  fs.mkdirSync(path.join(runDir, "handoff"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "review"), { recursive: true });
  const rel = path.relative(ROOT, runDir).split(path.sep).join("/");
  const bin = resolveClaudeBin(cfg.claude.bin);
  const handoffSchema = readJson(path.join(ROOT, "schema", "handoff.schema.json"));
  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const uiWanted = names.includes("ui-explorer") && !skip.has("ui-explorer") && untilPhase >= phaseOf("ui-explorer") && fromPhase <= phaseOf("ui-explorer");
  const mcp = prepareMcp({ runDir, cfg, envName: a.env, uiWanted });
  log(`Agent pipeline for "${a.module}" (profile ${profile.name}) → ${rel}`);
  log(`Phases: ${phases.map((p) => `${p.phase}[${p.agents.map((x) => x.name).join(", ")}]`).join(" → ")}`);
  if (mcp.ui) log(`UI: ${mcp.ui.envName} ${mcp.ui.baseUrl} (mode ${mcp.ui.mode})`);

  const order = new Map(configuredAgents.map((x, i) => [x.name, i + 1]));
  const handoffPath = (name) => path.join(runDir, "handoff", `${String(order.get(name)).padStart(2, "0")}-${name}.json`);
  const handoffsBefore = (phaseIdx) => configuredAgents.filter((x) => phaseOf(x.name) < phaseIdx).map((x) => readJson(handoffPath(x.name), null)).filter(Boolean);
  const stateExists = () => fs.existsSync(path.join(runDir, "state.json"));
  const tokenLog = () => new TokenLog(path.join(runDir, "token_log.jsonl"));

  const runStage = async (stage) => {
    const ctx = RunContext.load(runDir, {});
    await STAGE_FUNCS[stage](ctx);
    ctx.save();
  };

  const finishHandoff = (agent, handoff) => {
    writeJson(handoffPath(agent.name), handoff);
    log(`${agent.name}: ${handoff.status} · ${(handoff.tokens ?? 0).toLocaleString("en-US")} tokens · ${Math.round((handoff.durationMs ?? 0) / 1000)}s`);
    for (const f of handoff.findings ?? []) log(`   - ${f}`);
    return handoff;
  };

  const runAgent = async (agent, phaseIdx, { redesign = null } = {}) => {
    const base = { order: order.get(agent.name), agent: agent.name };
    if (skip.has(agent.name)) {
      return finishHandoff(agent, { ...base, status: "ok", findings: [`Skipped by --skip; ${agent.stage ? `stage ${agent.stage} ran without agent review` : "no exploration done"}.`], forwardNotes: "", outputs: [], tokens: 0 });
    }
    if (agent.name === "ui-explorer" && !mcp.ui) {
      return finishHandoff(agent, { ...base, status: "failed", findings: [`UI exploration not started: ${mcp.uiProblem}`], forwardNotes: "", outputs: [], tokens: 0 });
    }
    const prompt = buildPrompt({
      agent, rel, profile, moduleWords: a.module, keywords: a.keywords, limit: a.limit, previous: handoffsBefore(phaseIdx), configured,
      extraStories: a["extra-stories"], ui: agent.name === "ui-explorer" ? mcp.ui : null, redesign,
    });
    const model = cfg.agents.model?.[agent.name] ?? cfg.agents.model?.default;
    const args = [
      "-p", "--agent", agent.name, "--output-format", "json", "--json-schema", JSON.stringify(handoffSchema),
      "--permission-mode", "dontAsk", "--allowedTools", ...allowedTools(agent, rel, { uiMode: mcp.ui?.mode }), "--disallowedTools", ...DENIED,
      "--mcp-config", mcp.file, "--strict-mcp-config", "--no-session-persistence",
      ...(model ? ["--model", model] : []),
    ];
    log(`${agent.name}: started${redesign ? " (redesign round)" : ""}`);
    const started = Date.now();
    let handoff;
    try {
      const j = await spawnClaude({ bin, args, prompt, cwd: ROOT, timeoutMs: cfg.agents.timeoutMs ?? 1_800_000 });
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
    Object.assign(handoff, base, { model: model ?? "", durationMs: Date.now() - started });

    // Validate the review file now, so a bad one is reported here instead of failing a later stage.
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
    return finishHandoff(agent, handoff);
  };

  const stops = (h) => h.status === "blocked" || (h.status !== "ok" && !(OPTIONAL_EXPLORERS.includes(h.agent) && cfg.agents.continueWhenExplorerFails !== false));

  let stopped = null;
  for (let p = fromPhase; p <= untilPhase && !stopped; p++) {
    const phaseName = PHASES[p];
    const agents = phases.find((x) => x.phase === phaseName)?.agents ?? [];
    const budget = cfg.claude.maxTokensPerRun;
    if (budget && tokenLog().newTokens() >= budget) {
      stopped = { agent: agents[0]?.name ?? phaseName, status: "failed", question: `Token budget of ${budget.toLocaleString("en-US")} reached before the ${phaseName} phase.` };
      break;
    }
    // 1. Script stages of this phase (0 agent tokens). The scope stage is run by the module-scout.
    for (const s of PHASE_STAGES[phaseName]) {
      if (s.agent && !names.includes(s.agent)) {
        log(`stage ${s.stage}: off (${s.agent} is not in the pipeline)`);
        continue;
      }
      log(`stage ${s.stage}…`);
      await runStage(s.stage);
    }
    // 2. The phase's agents, side by side.
    if (!agents.length) continue;
    if (agents.length > 1) log(`${phaseName}: ${agents.length} agents in parallel`);
    const results = await Promise.all(agents.map((x) => runAgent(x, p)));
    const failedExplorers = results.filter((h) => h.status !== "ok" && !stops(h));
    for (const h of failedExplorers) log(`${h.agent} failed; the run goes on without it (agents.continueWhenExplorerFails).`);
    stopped = results.find(stops) ?? null;

    // 3. Validator loop: drafts sent back for redesign go to the test-designer again, then are re-validated.
    if (!stopped && phaseName === "validate" && names.includes("test-designer") && !skip.has("test-designer") && !skip.has("coverage-validator")) {
      const maxRounds = cfg.agents["coverage-validator"]?.maxRounds ?? 1;
      for (let round = 1; round <= maxRounds; round++) {
        const redesign = (readJson(path.join(runDir, "review", "validation.json"), {}).results ?? []).filter((v) => v.verdict === "redesign");
        if (!redesign.length) break;
        log(`validation round ${round}/${maxRounds}: ${redesign.length} draft(s) back to test-designer`);
        const designer = configuredAgents.find((x) => x.name === "test-designer");
        const h1 = await runAgent(designer, p, { redesign });
        if (stops(h1)) { stopped = h1; break; }
        await runStage("validate");
        const h2 = await runAgent(configuredAgents.find((x) => x.name === "coverage-validator"), p);
        if (stops(h2)) { stopped = h2; break; }
      }
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
JSON:     ${result.jsonPath}
Summary:  ${result.summaryPath}
Latest:   ${path.join(ROOT, "runs", profile.name, "latest-summary.md")}`);
  } else {
    const text = `# Coverage summary — "${a.module}"\n\n> **The agent pipeline stopped at \`${stopped?.agent}\` (${stopped?.status}).** ${stopped?.question ?? ""}\n\n${(stopped?.findings ?? []).map((f) => `- ${f}`).join("\n")}\n\nRe-run with a more specific module, e.g. \`node scripts/agents.mjs --profile ${profile.name} --module "<exact module>"\`.\n`;
    fs.mkdirSync(path.join(ROOT, "runs", profile.name), { recursive: true });
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
