#!/usr/bin/env node
// Coverage gap analysis: Jira stories + code vs Zephyr → Excel + summary.md.
// All stages in one go:
//   node scripts/run.mjs --profile avl --scope issues:AVLN-2398
//   node scripts/run.mjs --profile avl --scope module:admin/import-job --keywords "import job,bundle import"
// One stage on an existing run (used by the agent chain, scripts/agents.mjs):
//   node scripts/run.mjs --stage scope --run-dir <dir> --profile avl --scope module:admin/import-job --keywords "…"
//   node scripts/run.mjs --stage requirements --run-dir <dir>      (then code, match, draft, report)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadEnv, loadProfile, profileName } from "./lib/config.mjs";
import { RunContext, STAGES } from "./lib/context.mjs";
import { STAGE_FUNCS } from "./lib/stages.mjs";
import { resolveScope } from "./lib/scope.mjs";
import { summarizeTokens } from "./lib/tokens.mjs";
import { readJson, writeJson } from "./lib/util.mjs";

const USAGE = `Usage:
  node scripts/run.mjs --module "<name>" [options]                         all stages for a module (name/alias from modules.json, or a code path)
  node scripts/run.mjs [--profile <name>] --scope <scope> [options]        all stages (profile defaults to config/config.yaml defaultProfile)
  node scripts/run.mjs --stage <stage> --run-dir <dir> [options]           one stage (${STAGES.join(" → ")})
  node scripts/run.mjs --create-approved <workbook.xlsx> [--yes]

Scopes: project | epic:KEY | sprint:active | sprint:<name> | module:<path> | issues:K1,K2 | jql:<query>
Options:
  --keywords "a,b"               module scope: related words (stories mentioning them belong to the module)
  --remember                     save the keywords into the profile for next time
  --extra-stories <file|K1,K2>   module scope: candidate stories found elsewhere (e.g. Rovo search, JSON
                                 [{key, summary, query}]); added for the scout to confirm, not keyword-matched
  --since <YYYY-MM-DD|last-run>  only stories updated since then
  --limit <n>                    first n stories of the scope (trial runs)
  --concurrency <n>              parallel Claude calls (default config/config.yaml)
  --no-code                      skip code-derived scenarios
  --refresh-zephyr               ignore the cached Zephyr export
  --force                        ignore cached Claude results (uses tokens again)
  --dry-run                      no Claude calls: deterministic stages + cached results only
  --out <file.xlsx>              workbook path (default: in the run folder)`;

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" }, scope: { type: "string" }, since: { type: "string" }, limit: { type: "string" },
    keywords: { type: "string" }, remember: { type: "boolean" }, "extra-stories": { type: "string" }, stage: { type: "string" }, "run-dir": { type: "string" },
    module: { type: "string" },
    concurrency: { type: "string" }, "no-code": { type: "boolean" }, "refresh-zephyr": { type: "boolean" },
    force: { type: "boolean" }, "dry-run": { type: "boolean" }, out: { type: "string" },
    "create-approved": { type: "string" }, yes: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
loadEnv();
if (args["create-approved"]) {
  const { createApproved } = await import("./create-approved.mjs");
  await createApproved({ file: args["create-approved"], profileName: args.profile, yes: args.yes });
  process.exit(0);
}

// --profile defaults to config/config.yaml defaultProfile; --module "<name>" is short for --scope module:<name>.
if (!args.stage || args.stage === "scope") args.profile = profileName(args.profile);
if (args.module && !args.scope) args.scope = `module:${args.module}`;

const opts = { dryRun: args["dry-run"], force: args.force, concurrency: args.concurrency, noCode: args["no-code"], refreshZephyr: args["refresh-zephyr"] };

function sinceArg(profileName) {
  if (args.since !== "last-run") return args.since;
  const since = readJson(path.join(ROOT, "runs", profileName, "state.json"), {}).lastRunAt?.slice(0, 10);
  if (!since) throw new Error("--since last-run: no previous run recorded for this profile");
  return since;
}

/** --extra-stories: a JSON file ([{key, summary, query}] or {stories: [...]}) or a list of keys. */
function extraStoriesArg() {
  const v = args["extra-stories"];
  if (!v) return undefined;
  if (!fs.existsSync(v)) return v;
  const json = readJson(path.resolve(v));
  return Array.isArray(json) ? json : json.stories ?? [];
}

function newRunDir(profileName) {
  const profile = loadProfile(profileName);
  const scope = resolveScope(args.scope, profile, { since: sinceArg(profileName), keywords: args.keywords });
  return path.join(ROOT, "runs", profile.name, `${new Date().toISOString().slice(0, 10)}_${scope.slug}`);
}

function printDone(ctx, result) {
  const tok = summarizeTokens(ctx.tokenLog.records);
  const c = result.built.counts;
  console.log(`
Done. ${ctx.stories.length} stories (${ctx.testable().length} testable), ${c.expected} expected scenarios, ${c.matches} matched, ${c.gaps} gap(s), ${c.orphans} orphan case(s).
Tokens used: ${tok.total.total_tokens.toLocaleString("en-US")} (pipeline ${tok.pipeline.total_tokens.toLocaleString("en-US")}, agents ${tok.agents.total_tokens.toLocaleString("en-US")}; ${tok.total.calls - tok.total.reused} new call(s), ${tok.total.reused} from cache)
Workbook: ${result.workbookPath}
Summary:  ${result.summaryPath}
Review the 9_Gaps sheet (Review decision column), then: node scripts/run.mjs --create-approved "${result.workbookPath}"`);
}

try {
  if (args.stage) {
    // ---------- one stage ----------
    if (!STAGES.includes(args.stage)) throw new Error(`Unknown stage '${args.stage}'. Stages: ${STAGES.join(", ")}`);
    if (!args["run-dir"]) throw new Error("--stage needs --run-dir");
    const runDir = path.resolve(args["run-dir"]);
    let ctx;
    if (args.stage === "scope") {
      if (!args.profile || !args.scope) throw new Error("--stage scope needs --profile and --scope");
      ctx = RunContext.create({ runDir, profileName: args.profile, opts });
      await STAGE_FUNCS.scope(ctx, { scopeArg: args.scope, since: sinceArg(args.profile), keywords: args.keywords, extraStories: extraStoriesArg(), limit: args.limit, remember: args.remember });
    } else {
      ctx = RunContext.load(runDir, opts);
      const missing = STAGES.slice(0, STAGES.indexOf(args.stage)).filter((s) => !ctx.state.stagesDone.includes(s));
      if (missing.length) ctx.step("warning", { notes: `Running ${args.stage} while earlier stage(s) are missing or stale: ${missing.join(", ")}.` });
      const result = await STAGE_FUNCS[args.stage](ctx, { out: args.out });
      if (args.stage === "report") printDone(ctx, result);
    }
    ctx.save();
    if (args.stage !== "report") {
      const tok = summarizeTokens(ctx.tokenLog.records);
      console.log(`Stage ${args.stage} done. Run tokens so far: ${tok.total.total_tokens.toLocaleString("en-US")}. State: ${path.join(runDir, "state.json")}`);
    }
  } else {
    // ---------- all stages ----------
    if (!args.profile || !args.scope) {
      console.error(USAGE);
      process.exit(2);
    }
    const runDir = newRunDir(args.profile);
    fs.mkdirSync(runDir, { recursive: true });
    const ctx = RunContext.create({ runDir, profileName: args.profile, opts });
    ctx.log(`Profile ${args.profile} | scope ${args.scope} | run folder ${path.relative(ROOT, runDir)}`);
    await STAGE_FUNCS.scope(ctx, { scopeArg: args.scope, since: sinceArg(args.profile), keywords: args.keywords, extraStories: extraStoriesArg(), limit: args.limit, remember: args.remember });
    ctx.save();
    if (!ctx.stories.length) {
      console.log("No stories in scope — nothing to analyse.");
      process.exit(0);
    }
    for (const stage of ["requirements", "code", "zephyr", "context", "draft", "validate"]) {
      await STAGE_FUNCS[stage](ctx);
      ctx.save();
    }
    const result = await STAGE_FUNCS.report(ctx, { out: args.out });
    if (!ctx.dryRun) {
      const statePath = path.join(ROOT, "runs", ctx.profile.name, "state.json");
      writeJson(statePath, { ...readJson(statePath, {}), lastRunAt: ctx.state.runAt, lastScope: args.scope });
    }
    printDone(ctx, result);
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
