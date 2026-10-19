import fs from "node:fs";
import { appendJsonl, readJsonl } from "./util.mjs";

export const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];

export const totalTokens = (r) => TOKEN_FIELDS.reduce((s, f) => s + (r[f] ?? 0), 0);

/**
 * Append-only token ledger of one run (token_log.jsonl). Stages and agents run as separate processes,
 * so a log opened on an existing run picks up what earlier processes recorded.
 */
export class TokenLog {
  constructor(file, { fresh = false } = {}) {
    this.file = file;
    if (fresh && file) fs.rmSync(file, { force: true });
    this.records = file ? readJsonl(file) : [];
  }

  add(record) {
    const { cost_usd, ...rest } = record; // tokens only: money is deliberately not recorded
    const r = { at: new Date().toISOString(), ...rest };
    this.records.push(r);
    if (this.file) appendJsonl(this.file, r);
    return r;
  }

  /** Tokens actually consumed in this run (results served from cache consumed none). */
  newTokens() {
    return this.records.filter((r) => !r.reused).reduce((s, r) => s + totalTokens(r), 0);
  }
}

function blank() {
  return { calls: 0, reused: 0, failed: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0 };
}

function add(acc, r) {
  acc.calls++;
  if (r.reused) { acc.reused++; return acc; }
  if (r.failed) acc.failed++;
  for (const f of TOKEN_FIELDS) acc[f] += r[f] ?? 0;
  acc.total_tokens += totalTokens(r);
  return acc;
}

/**
 * Aggregate tokens consumed (non-reused) by stage, model, module and story. A call that covered N
 * stories is split evenly across them. Agent sessions are logged with stage "agent:<name>".
 */
export function summarizeTokens(records) {
  const byStage = {}, byModel = {}, byModule = {}, byStory = {};
  const total = blank();
  const pipeline = blank();
  const agents = blank();
  for (const r of records) {
    add(total, r);
    add(String(r.stage).startsWith("agent:") ? agents : pipeline, r);
    add((byStage[r.stage] ??= blank()), r);
    add((byModel[r.model || "(n/a)"] ??= blank()), r);
    add((byModule[r.module ?? "(n/a)"] ??= blank()), r);
    const keys = r.jiraKeys?.length ? r.jiraKeys : ["(n/a)"];
    for (const k of keys) {
      const share = { ...r };
      for (const f of TOKEN_FIELDS) share[f] = (r[f] ?? 0) / keys.length;
      add((byStory[k] ??= blank()), share);
    }
  }
  const cacheBase = total.input_tokens + total.cache_read_tokens + total.cache_creation_tokens;
  total.cache_hit_ratio = cacheBase ? total.cache_read_tokens / cacheBase : 0;
  return { total, pipeline, agents, byStage, byModel, byModule, byStory };
}
