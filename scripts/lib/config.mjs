import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Ajv from "ajv";
import YAML from "yaml";
import { readJson } from "./util.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function loadEnv() {
  // First file wins per variable; zephyr_mcp/.env is the fallback so secrets live in one place.
  dotenv.config({
    path: [path.join(ROOT, ".env.local"), path.join(ROOT, ".env"), path.join(ROOT, "zephyr_mcp", ".env")],
    quiet: true,
  });
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing environment variable(s): ${missing.join(", ")} (see .env.example)`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

export const CONFIG_FILE = path.join(ROOT, "config", "config.yaml");

/** config/config.yaml: pipeline, environments, scope filters, agent options and stage tuning. */
export function loadRunConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(ROOT, file)} (the run configuration).`);
  const cfg = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  cfg.scope ??= {};
  cfg.agents ??= {};
  cfg.validation ??= {};
  return cfg;
}

/** --profile is optional when config/config.yaml has a defaultProfile. */
export function profileName(name) {
  const resolved = name ?? loadRunConfig().defaultProfile;
  if (!resolved) throw new Error("No --profile given and no defaultProfile in config/config.yaml");
  return resolved;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[-_/.]+/g, " ").replace(/\s+/g, " ").trim();
const singular = (s) => s.split(" ").map((w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(?<!s)s$/, "") : w)).join(" ");

/** profiles/<name>/modules.json: the names you use for modules → path, keywords, story include/exclude. */
export function loadModulesCatalog(dir) {
  const file = path.join(dir, "modules.json");
  if (!fs.existsSync(file)) return {};
  const catalog = readJson(file);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(readJson(path.join(ROOT, "schema", "modules.schema.json")));
  if (!validate(catalog)) {
    const details = validate.errors.map((e) => `  ${e.instancePath || "(root)"} ${e.message}`).join("\n");
    throw new Error(`Invalid ${file}:\n${details}`);
  }
  return catalog.modules;
}

/** Find a catalogue module by its name, an alias or its path ("import job", "bundle import", "admin/import-job"). */
export function resolveModule(profile, words) {
  const q = singular(norm(words));
  if (!q) return null;
  for (const [modPath, m] of Object.entries(profile.modules ?? {})) {
    if (!m.name) continue;
    const names = [m.name, ...(m.aliases ?? []), modPath, modPath.split("/").pop()].map((n) => singular(norm(n)));
    if (names.includes(q)) return { path: modPath, ...m };
  }
  return null;
}

export function loadProfile(name) {
  name = profileName(name);
  const dir = path.join(ROOT, "profiles", name);
  const file = path.join(dir, "profile.json");
  if (!fs.existsSync(file)) {
    const available = fs.readdirSync(path.join(ROOT, "profiles")).filter((d) => !d.startsWith("_"));
    throw new Error(`Profile '${name}' not found at ${file}. Available: ${available.join(", ")}`);
  }
  const profile = readJson(file);
  validateProfile(profile, file);
  const conventionsFile = path.join(dir, profile.zephyr.conventions ?? "conventions.md");
  profile.conventionsText = fs.existsSync(conventionsFile) ? fs.readFileSync(conventionsFile, "utf8") : "";
  profile.dir = dir;
  // Merge the module catalogue into profile.modules (keyed by code path), which the stages already use.
  profile.modules ??= {};
  for (const [modName, m] of Object.entries(loadModulesCatalog(dir))) {
    const keywords = m.keywords ?? [];
    const pattern = keywords
      .map((k) => k.trim().split(/[\s_-]+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]?"))
      .filter(Boolean)
      .join("|");
    profile.modules[m.path] = { ...profile.modules[m.path], ...m, name: modName, ...(pattern && { summaryPattern: pattern }) };
  }
  return profile;
}

export function validateProfile(profile, label = "profile") {
  const schema = readJson(path.join(ROOT, "schema", "profile.schema.json"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(profile)) {
    const details = validate.errors.map((e) => `  ${e.instancePath || "(root)"} ${e.message}`).join("\n");
    throw new Error(`Invalid ${label}:\n${details}`);
  }
  for (const [where, rx] of [
    ["jira.nonTestable.summaryPattern", profile.jira.nonTestable?.summaryPattern],
    ["code.featurePathPattern", profile.code?.featurePathPattern],
  ]) {
    if (rx) {
      try {
        new RegExp(rx);
      } catch (err) {
        throw new Error(`Invalid ${label}: ${where} is not a valid regular expression (${err.message})`);
      }
    }
  }
}

export function loadPrompt(stage) {
  return fs.readFileSync(path.join(ROOT, "prompts", `${stage}.md`), "utf8");
}

export function loadLlmSchema(stage) {
  return readJson(path.join(ROOT, "schema", "llm", `${stage}.schema.json`));
}
