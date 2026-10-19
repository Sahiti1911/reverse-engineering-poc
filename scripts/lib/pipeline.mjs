// The agent pipeline as configured in config/config.yaml (pure: no I/O, unit-tested).
// Phases run in order; the agents of one phase run in parallel. Each agent owns one pipeline stage (run by
// the orchestrator before the agent, 0 agent tokens) and one review file merged by a later stage.

/** Every agent the orchestrator knows. `stage` null = the agent does the work itself (no script stage). */
export const AGENTS = {
  "module-scout": { phase: "scope", stage: "scope", review: "scout", required: true },
  "requirements-analyst": { phase: "explore", stage: "requirements", review: "requirements", required: true },
  "code-analyst": { phase: "explore", stage: "code", review: "code" },
  "ui-explorer": { phase: "explore", stage: null, review: "ui" },
  "zephyr-explorer": { phase: "explore", stage: "zephyr", review: "zephyr" },
  "context-builder": { phase: "context", stage: "context", review: "context", required: true },
  "test-designer": { phase: "design", stage: "draft", review: "drafts" },
  "coverage-validator": { phase: "validate", stage: "validate", review: "validation" },
  reporter: { phase: "report", stage: "report", review: null },
};

export const PHASES = ["scope", "explore", "context", "design", "validate", "report"];

/**
 * config.pipeline → [{ phase, agents: [{ name, phase, stage, review }] }] in phase order.
 * Rejects unknown agents, agents in the wrong phase, duplicate agents and missing required agents.
 */
export function resolvePipeline(cfg) {
  const list = cfg.pipeline;
  if (!Array.isArray(list) || !list.length) throw new Error("config.yaml: `pipeline` must list the phases and their agents.");
  const seen = new Set();
  const phases = [];
  for (const p of list) {
    if (!PHASES.includes(p.phase)) throw new Error(`config.yaml: unknown phase '${p.phase}'. Phases: ${PHASES.join(", ")}`);
    if (phases.some((x) => x.phase === p.phase)) throw new Error(`config.yaml: phase '${p.phase}' is listed twice.`);
    const agents = (p.agents ?? []).map((name) => {
      const def = AGENTS[name];
      if (!def) throw new Error(`config.yaml: unknown agent '${name}'. Agents: ${Object.keys(AGENTS).join(", ")}`);
      if (def.phase !== p.phase) throw new Error(`config.yaml: agent '${name}' belongs in phase '${def.phase}', not '${p.phase}'.`);
      if (seen.has(name)) throw new Error(`config.yaml: agent '${name}' is listed twice.`);
      seen.add(name);
      return { name, ...def };
    });
    if (agents.length) phases.push({ phase: p.phase, agents });
  }
  const missing = Object.entries(AGENTS).filter(([n, d]) => d.required && !seen.has(n)).map(([n]) => n);
  if (missing.length) throw new Error(`config.yaml: required agent(s) missing from the pipeline: ${missing.join(", ")}`);
  phases.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  return phases;
}

/** The environment the UI explorer opens: config.environments[--env ?? config.environment]. */
export function resolveEnvironment(cfg, name) {
  const envName = name ?? cfg.environment;
  const envs = cfg.environments ?? {};
  if (!envName) return null;
  const env = envs[envName];
  if (!env) throw new Error(`config.yaml: environment '${envName}' not found. Environments: ${Object.keys(envs).join(", ") || "(none)"}`);
  if (!env.uiBaseUrl) throw new Error(`config.yaml: environment '${envName}' has no uiBaseUrl.`);
  return { name: envName, ...env, login: env.login ?? { method: "none" } };
}

export const UI_MODES = ["observe", "read-only", "full"];

/** Playwright MCP tools per UI mode. Never: code evaluation, file upload, storage/cookie writes, network routing. */
export function uiTools(mode) {
  if (!UI_MODES.includes(mode)) throw new Error(`config.yaml: agents.ui-explorer.mode must be one of ${UI_MODES.join(", ")} (got '${mode}').`);
  const observe = ["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_take_screenshot", "browser_wait_for", "browser_tabs", "browser_resize", "browser_console_messages", "browser_find"];
  const interact = ["browser_click", "browser_hover", "browser_type", "browser_fill_form", "browser_select_option", "browser_press_key", "browser_check", "browser_uncheck", "browser_handle_dialog"];
  return (mode === "observe" ? observe : [...observe, ...interact]).map((t) => `mcp__playwright__${t}`);
}

/** Refuse a UI mode the environment does not allow. */
export function checkUiMode(mode, env) {
  uiTools(mode);
  if (mode === "full" && !env?.allowWrites) {
    throw new Error(`UI mode 'full' lets the app save and delete data, but environment '${env?.name}' does not set allowWrites: true.`);
  }
}

/** Arguments for the Playwright MCP server of one run. */
export function playwrightArgs({ pkg, env, headless = true, outputDir, storageStatePath = null, initScriptPath = null }) {
  const origin = new URL(env.uiBaseUrl).origin;
  const args = ["-y", pkg, "--isolated", "--allowed-origins", origin, "--output-dir", outputDir, "--image-responses", "omit"];
  if (headless) args.push("--headless");
  if (storageStatePath) args.push("--storage-state", storageStatePath);
  if (initScriptPath) args.push("--init-script", initScriptPath);
  return args;
}

/**
 * Browser init script for read-only mode: the page cannot send POST/PUT/PATCH/DELETE (fetch, XHR, form submit,
 * sendBeacon) unless the URL matches an allowed pattern. Blocked requests fail like a network error and are
 * listed in window.__blockedWrites so the agent can report them.
 */
export function blockWritesScript(allowedWriteUrls = []) {
  for (const p of allowedWriteUrls) new RegExp(p); // fail early on a bad pattern
  return `(() => {
  const allowed = ${JSON.stringify(allowedWriteUrls)}.map((p) => new RegExp(p));
  const SAFE = ["GET", "HEAD", "OPTIONS"];
  window.__blockedWrites = [];
  const ok = (method, url) => SAFE.includes(String(method || "GET").toUpperCase()) || allowed.some((rx) => rx.test(String(url)));
  const note = (method, url) => { window.__blockedWrites.push(String(method).toUpperCase() + " " + url); console.warn("[read-only] blocked " + method + " " + url); };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const method = (init && init.method) || (input && input.method) || "GET";
    if (!ok(method, url)) { note(method, url); return Promise.reject(new TypeError("Blocked by read-only UI exploration")); }
    return origFetch.apply(this, arguments);
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__ro = !ok(method, url) && [method, url]; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (this.__ro) { note(this.__ro[0], this.__ro[1]); this.abort(); this.dispatchEvent(new ProgressEvent("error")); return; }
    return send.apply(this, arguments);
  };
  if (navigator.sendBeacon) navigator.sendBeacon = (url) => { if (ok("POST", url)) return true; note("POST", url); return false; };
  document.addEventListener("submit", (e) => {
    const f = e.target;
    if (f && !ok(f.method, f.action)) { e.preventDefault(); e.stopImmediatePropagation(); note(f.method, f.action); }
  }, true);
})();`;
}
