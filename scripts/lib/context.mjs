// Shared state of one analysis run. Every stage loads it from <runDir>/state.json, works on it and saves it,
// so stages can run in one process (run.mjs) or one per agent (scripts/agents.mjs).
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadRunConfig, loadProfile } from "./config.mjs";
import { createLlm, BudgetExceeded } from "./llm.mjs";
import { checkOutputConfig } from "./workbook.mjs";
import { TokenLog } from "./tokens.mjs";
import { readJson, writeJson, nowIso } from "./util.mjs";
import { exportZephyr } from "./zephyr.mjs";
import { createJiraClient } from "./jira.mjs";

export const STAGES = ["scope", "requirements", "code", "zephyr", "context", "draft", "validate", "gap-review", "report"];

export class RunContext {
  constructor({ runDir, state, profile, cfg, opts = {}, freshTokens = false }) {
    this.runDir = runDir;
    this.state = state;
    this.profile = profile;
    this.cfg = cfg;
    this.opts = opts;
    this.dryRun = !!opts.dryRun;
    this.concurrency = Number(opts.concurrency ?? cfg.concurrency ?? 2);
    this.cacheDir = path.join(ROOT, "cache", profile.name);
    this.tokenLog = new TokenLog(path.join(runDir, "token_log.jsonl"), { fresh: freshTokens });
    // config output: checked here so a typo fails before any tokens are spent.
    this.outputFields = checkOutputConfig(cfg.output);
    this.llm = createLlm({
      runCfg: cfg, cacheDir: this.cacheDir, tokenLog: this.tokenLog, force: opts.force, dryRun: this.dryRun,
      extraSystem: { draft: profile.conventionsText }, fields: this.outputFields,
    });
    this._zephyr = null;
    this.jira = createJiraClient({ baseUrl: profile.jira.baseUrl, email: process.env.ATLASSIAN_EMAIL ?? "", token: process.env.ATLASSIAN_API_TOKEN ?? "" });
  }

  static create({ runDir, profileName, opts }) {
    fs.mkdirSync(runDir, { recursive: true });
    const profile = loadProfile(profileName);
    const state = { profile: profile.name, runAt: nowIso(), scope: null, stories: [], runLog: [], stagesDone: [], codeCommits: [], repos: {}, budgetHit: null };
    return new RunContext({ runDir, state, profile, cfg: loadRunConfig(), opts, freshTokens: true });
  }

  static load(runDir, opts = {}) {
    const file = path.join(runDir, "state.json");
    if (!fs.existsSync(file)) throw new Error(`No run state at ${file}. Run the scope stage first.`);
    const state = readJson(file);
    return new RunContext({ runDir, state, profile: loadProfile(state.profile), cfg: loadRunConfig(), opts });
  }

  save() {
    writeJson(path.join(this.runDir, "state.json"), this.state);
  }

  get stories() {
    return this.state.stories;
  }

  R(key) {
    return this.state.stories.find((r) => r.story.key === key);
  }

  testable() {
    return this.state.stories.filter((r) => r.triage?.testable && !r.dropped);
  }

  log(msg) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  step(name, o = {}) {
    this.state.runLog.push({
      step: name, at: nowIso(), batch: o.batch ?? "", countIn: o.in ?? "", countOut: o.out ?? "",
      notes: o.notes ?? "", skipped: o.skipped ?? "", errors: o.errors ?? "",
    });
    this.log(`${name}${o.batch ? ` [${o.batch}]` : ""}: ${o.notes ?? ""}${o.skipped ? ` SKIPPED: ${o.skipped}` : ""}${o.errors ? ` ERRORS: ${o.errors}` : ""}`);
  }

  /** Errors are tagged with their stage so a re-run of that stage replaces only its own. */
  clearErrors(stage) {
    for (const r of this.state.stories) r.errors = (r.errors ?? []).filter((e) => !e.startsWith(`${stage}:`));
  }

  async zephyr() {
    this._zephyr ??= await exportZephyr({
      profile: this.profile, cacheDir: this.cacheDir, maxAgeHours: this.cfg.zephyr.exportMaxAgeHours,
      force: this.opts.refreshZephyr && !this._refreshed, log: (m) => this.log(m),
    });
    this._refreshed = true;
    this.state.zephyrExportedAt = this._zephyr.exportedAt;
    return this._zephyr;
  }

  /** LLM call that turns budget exhaustion into a logged skip instead of a crash. */
  async llmRun(stage, opts) {
    if (this.state.budgetHit) return { output: null, skipped: this.state.budgetHit };
    try {
      return await this.llm.run(stage, opts);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        this.state.budgetHit = err.message;
        this.step("budget", { notes: err.message, errors: "Remaining Claude work was skipped; the workbook shows what was finished." });
        return { output: null, skipped: err.message };
      }
      throw err;
    }
  }

  skipReason(res) {
    return res.skipped === "dry-run" ? "not analysed: --dry-run (no Claude calls)" : `not analysed: ${res.skipped}`;
  }

  /** Re-running a stage makes every later stage stale. */
  markDone(stage) {
    const idx = STAGES.indexOf(stage);
    this.state.stagesDone = STAGES.slice(0, idx + 1).filter((s) => s === stage || this.state.stagesDone.includes(s));
  }

  reviewFile(agentKey) {
    return path.join(this.runDir, "review", `${agentKey}.json`);
  }

  handoffs() {
    const dir = path.join(this.runDir, "handoff");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readJson(path.join(dir, f)));
  }
}
