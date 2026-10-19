import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "node-html-parser";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (fallback !== undefined && err.code === "ENOENT") return fallback;
    throw err;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** Stable short hash of any JSON-serialisable value (object keys sorted). */
export function hash(value) {
  const stable = (v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
      : Array.isArray(v) ? v.map(stable) : v;
  return crypto.createHash("sha1").update(JSON.stringify(stable(value))).digest("hex").slice(0, 16);
}

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
}

export function htmlToText(html) {
  if (!html) return "";
  const root = parse(html);
  // Keep block boundaries as newlines so lists and paragraphs stay readable.
  for (const el of root.querySelectorAll("p, li, h1, h2, h3, h4, tr, br")) el.insertAdjacentHTML("afterend", "\n");
  return root.textContent.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text ?? "";
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function promisePool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const STOPWORDS = new Set(
  "a an the and or of to in on for with by from is are be as at it this that page new old via vs migrate migration angular standalone testing test tests avl admin tms ui".split(" ")
);

export function tokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

export function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function nowIso() {
  return new Date().toISOString();
}
