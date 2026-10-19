import { htmlToText } from "./util.mjs";

const FIELDS = ["summary", "status", "issuetype", "labels", "created", "updated", "parent", "issuelinks", "description"];

export function createJiraClient({ baseUrl, email, token }) {
  const base = baseUrl.replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

  async function get(pathAndQuery) {
    const res = await fetch(base + pathAndQuery, { headers: { Authorization: auth, Accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Jira API ${res.status} for ${pathAndQuery.split("?")[0]}: ${JSON.stringify(data).slice(0, 500)}`);
    return data;
  }

  /** All issues for a JQL, following nextPageToken; descriptions come back as rendered HTML. */
  async function search(jql, { pageSize = 100, onPage } = {}) {
    const issues = [];
    let token;
    do {
      const params = new URLSearchParams({ jql, fields: FIELDS.join(","), expand: "renderedFields", maxResults: String(pageSize) });
      if (token) params.set("nextPageToken", token);
      const page = await get(`/rest/api/3/search/jql?${params}`);
      issues.push(...(page.issues ?? []));
      onPage?.(issues.length);
      token = page.isLast ? undefined : page.nextPageToken;
    } while (token);
    return issues;
  }

  /** Approximate number of issues for a JQL (one request, no issues fetched). */
  async function count(jql) {
    const res = await fetch(base + "/rest/api/3/search/approximate-count", { method: "POST", headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ jql }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Jira API ${res.status} for approximate-count: ${JSON.stringify(data).slice(0, 300)}`);
    return data.count ?? 0;
  }

  const browseUrl = (key) => `${base}/browse/${key}`;
  return { search, count, browseUrl, get };
}

export function normalizeIssue(raw) {
  const f = raw.fields ?? {};
  const html = raw.renderedFields?.description ?? "";
  return {
    key: raw.key,
    id: Number(raw.id),
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    type: f.issuetype?.name ?? "",
    labels: f.labels ?? [],
    created: f.created,
    updated: f.updated,
    epicKey: f.parent?.key ?? null,
    epicSummary: f.parent?.fields?.summary ?? null,
    descriptionHtml: html,
    descriptionText: htmlToText(html),
    links: (f.issuelinks ?? []).map((l) => {
      const other = l.inwardIssue ?? l.outwardIssue;
      return {
        type: l.type?.name,
        direction: l.inwardIssue ? "inward" : "outward",
        key: other?.key,
        id: Number(other?.id),
        summary: other?.fields?.summary,
      };
    }),
  };
}
