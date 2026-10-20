// Stage-level LLM wrapper: content-fingerprint cache (resume + incremental runs for free),
// retries, run token budget, and one token-log record per call (reused results are logged as reused).
import path from "node:path";
import { callClaude, resolveClaudeBin } from "./claude.mjs";
import { loadPrompt, loadLlmSchema } from "./config.mjs";
import { hash, readJson, writeJson, slug } from "./util.mjs";
import { withExtraFields, extraFieldsPrompt } from "./output.mjs";

export class BudgetExceeded extends Error {}

export function createLlm({ runCfg, cacheDir, tokenLog, force = false, dryRun = false, extraSystem = {}, fields = [] }) {
  let bin;
  const stagePrompt = {};
  const stageSchema = {};

  async function run(stage, { cacheKey, fingerprint, prompt, jiraKeys = [], module = null, itemsIn = 0, countOut = () => 0 }) {
    // config output.fields extend the schema and prompt; both are in the fingerprint, so only this stage's cache changes.
    stagePrompt[stage] ??= [loadPrompt(stage), extraSystem[stage], extraFieldsPrompt(fields, stage)].filter(Boolean).join("\n\n");
    stageSchema[stage] ??= withExtraFields(loadLlmSchema(stage), stage, fields);
    const model = runCfg.models[stage];
    const fp = hash({ fingerprint, system: stagePrompt[stage], schema: stageSchema[stage], model });
    const file = path.join(cacheDir, "llm", stage, `${slug(cacheKey)}-${hash(cacheKey).slice(0, 6)}.json`);
    const meta = { stage, cacheKey, jiraKeys, module, items_in: itemsIn };

    const cached = force ? null : readJson(file, null);
    if (cached?.fingerprint === fp) {
      const { cost_usd, ...record } = cached.record;
      tokenLog.add({ ...record, ...meta, items_out: countOut(cached.output), reused: true });
      return { output: cached.output, reused: true };
    }
    if (dryRun) return { output: null, skipped: "dry-run" };
    const cap = runCfg.claude.maxTokensPerRun;
    if (cap && tokenLog.newTokens() >= cap) {
      throw new BudgetExceeded(`Token budget of ${cap.toLocaleString("en-US")} tokens reached (config claude.maxTokensPerRun)`);
    }

    bin ??= resolveClaudeBin(runCfg.claude.bin);
    let lastErr;
    for (let attempt = 0; attempt <= (runCfg.claude.retries ?? 1); attempt++) {
      try {
        const { output, record } = await callClaude({
          bin, model, system: stagePrompt[stage], prompt, schema: stageSchema[stage], timeoutMs: runCfg.claude.timeoutMs,
        });
        tokenLog.add({ ...record, ...meta, items_out: countOut(output), attempt, reused: false });
        writeJson(file, { fingerprint: fp, cacheKey, createdAt: new Date().toISOString(), record, output });
        return { output, reused: false };
      } catch (err) {
        lastErr = err;
        // A failed attempt still consumed tokens; log it so the usage is visible.
        if (err.record) tokenLog.add({ ...err.record, ...meta, items_out: 0, attempt, reused: false, failed: true, error: err.message.slice(0, 300) });
      }
    }
    throw lastErr;
  }

  return { run };
}
