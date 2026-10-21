// UI sweep (0 tokens): a plain Playwright script that opens EVERY page of the app's navigation, finds the
// feature's trigger (e.g. the grid's Export button), triggers it and records the request the page sends,
// without letting it reach the server. Same safety as the ui-explorer: only the environment's origin, the saved
// session, the read-only init script; on top of that the browser's network layer aborts every write that is
// not an allowed read, and ALWAYS aborts the feature request after recording it.
import fs from "node:fs";
import path from "node:path";
import { launch } from "./ui-session.mjs";
import { blockWritesScript } from "./pipeline.mjs";
import { ROOT } from "./config.mjs";

const SAFE = ["GET", "HEAD", "OPTIONS"];
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Pages to visit: navigation links plus configured routes, deduplicated, in order, at most `max`. */
export function sweepTargets(links, extraRoutes = [], max = 120) {
  const seen = new Set();
  const out = [];
  for (const l of [...extraRoutes.map((r) => ({ href: r, text: "" })), ...links]) {
    const href = String(l.href ?? "").trim();
    if (!href.startsWith("#/") || seen.has(href)) continue;
    seen.add(href);
    out.push({ route: href, title: String(l.text ?? "").replace(/\s+/g, " ").trim() });
  }
  return out.slice(0, max);
}

/** In-page links not yet queued: hash routes without a record id (…/123) or a query, deduplicated. */
export function discoveredLinks(links, known = []) {
  const seen = new Set(known);
  const out = [];
  for (const l of links) {
    const href = String(l.href ?? "").split("?")[0];
    if (!href.startsWith("#/") || href === "#/" || seen.has(href) || /\/\d+(\/|$)/.test(href)) continue;
    seen.add(href);
    out.push({ href, text: String(l.text ?? "").trim() });
  }
  return out;
}

/** What a captured feature request says: surface id, exported column names and the other body fields. */
export function parseFeatureRequest(url, body, requestPattern) {
  const m = String(url).match(new RegExp(requestPattern));
  const cols = Array.isArray(body?.headers) ? body.headers : Array.isArray(body?.columns) ? body.columns : [];
  return {
    url: String(url).replace(/^https?:\/\/[^/]+/, ""), id: m?.[1] ?? null,
    columns: cols.map((h) => (typeof h === "string" ? h : h.displayName ?? h.header ?? h.name ?? h.field ?? "")).filter(Boolean),
    fields: body && typeof body === "object" ? Object.keys(body).sort() : [],
    selectedIds: Array.isArray(body?.selectedIds) ? body.selectedIds.length : null,
    predefined: body?.usePredefinedHeaders ?? null,
  };
}

/**
 * Grid columns vs exported columns (case/space-insensitive; a header's trailing sort number, "Name 2", is
 * ignored). Grids render only the columns in view, so a column the export has and the grid does not is only
 * informative; match = false means the grid shows a column the export leaves out. No grid or body: null.
 */
export function compareColumns(grid, exported) {
  const e = exported.map(norm).filter(Boolean);
  const g = grid.map(norm).filter(Boolean).map((x) => (e.includes(x) ? x : x.replace(/\s+\d+$/, "")));
  if (!g.length || !e.length) return { match: null, onlyInGrid: [], onlyInExport: [] };
  const onlyInGrid = [...new Set(g.filter((x) => !e.includes(x)))];
  const onlyInExport = e.filter((x) => !g.includes(x));
  // Under half the grid's columns in the export: the request names columns differently (keys, not labels) or
  // belongs to another grid on the page, so the lists cannot be compared.
  if (onlyInGrid.length > new Set(g).size / 2) return { match: null, onlyInGrid, onlyInExport, note: "not comparable" };
  return { match: !onlyInGrid.length, onlyInGrid, onlyInExport };
}

/**
 * Sweep the environment. ui = modules.json surfaces.ui; opts = agents.ui-explorer (allowedWriteUrls, sweep: {...}).
 * Writes <outDir>/sweep.json and screenshots; returns { pages, notes }.
 */
export async function runSweep({ env, ui, opts = {}, outDir, extraRoutes = [], onlyRoutes = null, log = console.log }) {
  if (!ui?.requestPattern || !ui?.trigger) throw new Error("modules.json surfaces.ui needs requestPattern and trigger for the UI sweep.");
  const conf = { maxPages: 200, pageTimeoutMs: 30_000, settleMs: 1500, headless: opts.headless ?? true, ...(opts.sweep ?? {}) };
  const origin = new URL(env.uiBaseUrl).origin;
  const allowed = (opts.allowedWriteUrls ?? []).map((p) => new RegExp(p));
  const featureRx = new RegExp(ui.requestPattern);
  const triggerRx = new RegExp(ui.trigger, "i");
  const overflowRx = ui.overflow ? new RegExp(ui.overflow, "i") : null;
  const confirmRx = ui.confirm ? new RegExp(ui.confirm, "i") : triggerRx;
  fs.mkdirSync(path.join(outDir, "sweep"), { recursive: true });
  const notes = [];
  const browser = await launch(env, conf.headless);
  const pages = [];
  let navLinks = 0;
  try {
    const storageState = env.login?.method === "storage-state" ? path.resolve(ROOT, env.login.storageState) : undefined;
    const context = await browser.newContext({ storageState, viewport: { width: 1600, height: 1000 } });
    // The feature request is let out of the page so its body can be read here; the network layer aborts it.
    await context.addInitScript(blockWritesScript([...(opts.allowedWriteUrls ?? []), ui.requestPattern]));
    let captured = [];
    let leaked = 0;
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (!url.startsWith("data:") && !url.startsWith("blob:") && new URL(url).origin !== origin) return route.abort();
      if (SAFE.includes(req.method())) return route.continue();
      if (featureRx.test(url)) {
        let body = null;
        try { body = req.postDataJSON(); } catch { body = null; }
        captured.push(parseFeatureRequest(url, body, ui.requestPattern));
        return route.abort();
      }
      if (allowed.some((rx) => rx.test(url))) return route.continue();
      leaked++;
      return route.abort();
    });
    const page = await context.newPage();
    let consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 300)));
    page.on("dialog", (d) => d.dismiss().catch(() => {}));

    await page.goto(env.uiBaseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: conf.pageTimeoutMs }).catch(() => {});
    // The navigation renders after the app boots; without it the sweep would silently visit nothing.
    await page.locator('a[href^="#/"]').first().waitFor({ state: "attached", timeout: conf.pageTimeoutMs * 2 }).catch(() => {});
    const links = await page.$$eval('a[href^="#/"]', (as) => as.map((a) => ({ href: a.getAttribute("href"), text: (a.textContent || a.getAttribute("title") || "").trim() })));
    if (!links.length) {
      const login = await page.getByRole("textbox", { name: /password/i }).isVisible().catch(() => false);
      throw new Error(`No navigation links on ${env.uiBaseUrl} after ${(conf.pageTimeoutMs * 2) / 1000} s${login ? ": the app shows the login form (run npm run ui-login)" : ": the app did not finish loading"}.`);
    }
    navLinks = links.length;
    const targets = onlyRoutes?.length ? sweepTargets(onlyRoutes.map((r) => links.find((l) => l.href === r) ?? { href: r, text: "" }), [], conf.maxPages) : sweepTargets(links, [...(ui.routes ?? []), ...extraRoutes], conf.maxPages);
    log(`UI sweep: ${links.length} navigation link(s), visiting ${targets.length} page(s) on ${origin}…`);

    // One view = the page as opened, or one of its tabs: find the trigger, use it, record what was sent.
    const blank = (route, title, tab = null) => ({ route, title, tab, trigger: false, options: [], dialog: null, gridColumns: [], requests: [], columnsMatch: null, columnDiff: null, screenshot: null, consoleErrors: [], problem: "" });
    const waitGrid = async () => {
      await page.waitForLoadState("networkidle", { timeout: conf.pageTimeoutMs }).catch(() => {});
      await page.getByRole("columnheader").first().waitFor({ timeout: conf.gridWaitMs ?? 8000 }).catch(() => {});
      await page.waitForTimeout(conf.settleMs);
    };
    const say = (n, rec) => log(`  ${n} ${rec.route}${rec.tab ? ` › ${rec.tab}` : ""} ${rec.trigger ? `trigger ✓ ${rec.requests.map((q) => `id ${q.id}`).join(", ") || "no request"}` : "no trigger"}${rec.problem && !rec.trigger ? ` (${rec.problem})` : ""}`);

    for (const [i, t] of targets.entries()) {
      const n = `${String(i + 1).padStart(3)}/${targets.length}`;
      const rec = blank(t.route, t.title);
      let tabs = [];
      try {
        // A dialog or menu left open by the previous page must not carry over to this route.
        await closeOverlays(page);
        await page.goto(`${origin}${new URL(env.uiBaseUrl).pathname}${t.route}`, { waitUntil: "domcontentloaded", timeout: conf.pageTimeoutMs });
        await waitGrid();
        const at = "#" + (page.url().split("#")[1] ?? "").split("?")[0];
        if (at !== t.route) rec.problem = `Navigation ended at ${at}`;
        const heading = await page.locator("h1, h2, .page-title, .breadcrumb .active").first().innerText({ timeout: 1000 }).catch(() => "");
        if (!rec.title) rec.title = heading.trim();
        // Tabs on the page are separate grids (e.g. one report per tab): each is swept as its own view.
        tabs = (await page.locator('[role="tab"], .nav-tabs > li > a').allInnerTexts().catch(() => [])).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
        tabs = [...new Set(tabs)].slice(0, conf.maxTabs ?? 12);
        // Links a page offers that the navigation does not (e.g. legacy tabs, which are routes of their own) join
        // the queue; detail links with a record id in the route are left to the ui-explorer.
        const own = await page.$$eval('a[href^="#/"]', (as) => as.map((a) => ({ href: a.getAttribute("href"), text: (a.textContent || "").replace(/\s+/g, " ").trim() })));
        // Navigation links count as known even when --routes limits the sweep; new links are swept right after
        // the page that offers them.
        const found = discoveredLinks(own, [...targets.map((x) => x.route), ...links.map((l) => String(l.href).split("?")[0])]);
        const room = Math.max(0, conf.maxPages - targets.length);
        targets.splice(i + 1, 0, ...found.slice(0, room).map((l) => ({ route: l.href, title: l.text ? `${rec.title} › ${l.text}` : "", from: t.route })));
      } catch (err) {
        rec.problem = `Page failed: ${err.message.split("\n")[0].slice(0, 200)}`;
        pages.push(rec);
        say(n, rec);
        continue;
      }
      say(n, await captureView(rec, String(i + 1).padStart(3, "0")));
      for (const [j, tab] of tabs.entries()) {
        if (j === 0) continue; // the first tab is the view already swept
        const sub = blank(t.route, `${rec.title} › ${tab}`, tab);
        try {
          const el = (await visible(page.getByRole("tab", { name: tab, exact: true }))) ?? (await visible(page.locator(".nav-tabs > li > a", { hasText: tab })));
          if (!el) { sub.problem = "Tab not visible"; pages.push(sub); continue; }
          await el.click();
          await waitGrid();
        } catch (err) {
          sub.problem = `Tab failed: ${err.message.split("\n")[0].slice(0, 200)}`;
          pages.push(sub);
          continue;
        }
        say(" ".repeat(n.length), await captureView(sub, `${String(i + 1).padStart(3, "0")}-${j + 1}`));
      }
    }

    async function captureView(rec, shotName) {
      captured = [];
      consoleErrors = [];
      try {
        rec.gridColumns = (await page.getByRole("columnheader").allInnerTexts().catch(() => [])).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
        let trigger = await visible(page.getByRole("button", { name: triggerRx }));
        if (!trigger && overflowRx) {
          const more = await visible(page.getByRole("button", { name: overflowRx }));
          if (more) {
            await more.click();
            trigger = (await visible(page.getByRole("menuitem", { name: triggerRx }))) ?? (await visible(page.getByRole("button", { name: triggerRx })));
            if (!trigger) await page.keyboard.press("Escape");
          }
        }
        if (trigger) {
          rec.trigger = true;
          await trigger.click();
          await page.waitForTimeout(conf.settleMs);
          // A menu of export options: trigger each one (at most 4), reopening the menu in between.
          const items = await page.getByRole("menuitem").allInnerTexts().catch(() => []);
          rec.options = items.map((x) => x.trim()).filter(Boolean).slice(0, 8);
          if (!captured.length && rec.options.length) {
            for (const name of rec.options.slice(0, 4)) {
              const item = await visible(page.getByRole("menuitem", { name, exact: true }));
              if (!item) { await trigger.click().catch(() => {}); await page.waitForTimeout(500); }
              const again = await visible(page.getByRole("menuitem", { name, exact: true }));
              if (again) { await again.click(); await page.waitForTimeout(conf.settleMs); await confirmDialog(page, confirmRx, rec, conf); }
            }
          } else if (!captured.length) {
            await confirmDialog(page, confirmRx, rec, conf);
          }
        }
        const shot = path.join(outDir, "sweep", `${shotName}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        rec.screenshot = path.relative(path.dirname(outDir), shot).split(path.sep).join("/");
        await closeOverlays(page);
      } catch (err) {
        rec.problem = `View failed: ${err.message.split("\n")[0].slice(0, 200)}`;
      }
      rec.requests = captured;
      const cols = captured.flatMap((q) => q.columns);
      if (cols.length) {
        const diff = compareColumns(rec.gridColumns, [...new Set(cols)]);
        rec.columnsMatch = diff.match;
        rec.columnDiff = diff.match === false ? { onlyInGrid: diff.onlyInGrid, onlyInExport: diff.onlyInExport } : null;
      }
      if (rec.trigger && !captured.length && !rec.problem) rec.problem = "Trigger clicked but no feature request was captured (needs a selection, a filled dialog or a detail page).";
      rec.consoleErrors = [...new Set(consoleErrors)].slice(0, 10);
      pages.push(rec);
      return rec;
    }
    if (leaked) notes.push(`${leaked} other write request(s) were aborted by the network guard.`);
    await context.close();
  } finally {
    await browser.close();
  }
  const result = { sweptAt: new Date().toISOString(), env: env.name, origin, navLinks, pages, notes };
  fs.writeFileSync(path.join(outDir, "sweep.json"), JSON.stringify(result, null, 2));
  return result;
}

/** Close open dialogs and menus: Escape, then the dialog's own close button. */
async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const dialog = await visible(page.getByRole("dialog"));
    if (!dialog) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    if (!(await dialog.isVisible().catch(() => false))) return;
    const close = (await visible(dialog.getByRole("button", { name: /close|cancel|×/i }))) ?? (await visible(dialog.locator(".close, [ng-click*='dismiss'], [ng-click*='cancel']")));
    if (close) await close.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function visible(locator) {
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** A dialog opened by the trigger: record its fields and confirm it (the request is aborted by the guard). */
async function confirmDialog(page, confirmRx, rec, conf) {
  const dialog = await visible(page.getByRole("dialog"));
  if (!dialog) return;
  const title = await dialog.locator("h1, h2, h3, h4, .modal-title").first().innerText({ timeout: 500 }).catch(() => "");
  const fields = [];
  for (const role of ["textbox", "combobox", "checkbox", "radio", "spinbutton"]) {
    for (const el of await dialog.getByRole(role).all().catch(() => [])) {
      const name = (await el.getAttribute("aria-label").catch(() => null)) ?? (await el.getAttribute("placeholder").catch(() => null)) ?? (await el.getAttribute("name").catch(() => null)) ?? "";
      fields.push(`${role}${name ? `: ${name}` : ""}`);
    }
  }
  rec.dialog = { title: title.trim(), fields };
  // Dialog actions are buttons, links or plain clickable labels (e.g. an "Export" action in the dialog header).
  const ok = (await visible(dialog.getByRole("button", { name: confirmRx })))
    ?? (await visible(dialog.getByRole("link", { name: confirmRx })))
    ?? (await visible(dialog.getByText(confirmRx)));
  if (ok && (await ok.isEnabled().catch(() => false))) {
    await ok.click();
    await page.waitForTimeout(conf.settleMs);
  } else {
    rec.dialog.note = "Confirm button not found or disabled (required input missing).";
  }
  await page.keyboard.press("Escape").catch(() => {});
}
