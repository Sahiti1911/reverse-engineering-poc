// Zephyr Scale Cloud REST client, shared by the MCP server and the coverage scripts.

export function zephyrBaseUrl(region) {
  return region === "eu" || region === true || region === "true"
    ? "https://eu.api.zephyrscale.smartbear.com/v2"
    : "https://api.zephyrscale.smartbear.com/v2";
}

export function createZephyrClient({ token, region }) {
  if (!token) throw new Error("Missing Zephyr API token (ZEPHYR_API_TOKEN)");
  const baseUrl = zephyrBaseUrl(region);

  async function request(method, pathOrUrl, { params, body } = {}) {
    // Pagination hands back absolute `next` URLs, so accept either form.
    const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : baseUrl + pathOrUrl);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`Zephyr API ${method} ${url.pathname} -> ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /** Follow `next` links until the last page or until `limit` values are collected. */
  async function getAll(pathname, params, { pageSize = 100, limit = Infinity } = {}) {
    const values = [];
    let page = await request("GET", pathname, { params: { ...params, maxResults: pageSize } });
    const total = page.total;
    for (;;) {
      values.push(...(page.values ?? []));
      if (values.length >= limit || page.isLast || !page.next) break;
      page = await request("GET", page.next);
    }
    const truncated = values.length > limit || (!page.isLast && !!page.next);
    return { total, values: values.slice(0, limit), truncated };
  }

  return { baseUrl, request, getAll };
}
