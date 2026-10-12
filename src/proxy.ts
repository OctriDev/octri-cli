/**
 * Proxy support for every request the CLI, its MCP server and the library make.
 *
 * Node's built-in fetch ignores HTTPS_PROXY, HTTP_PROXY and NO_PROXY unless
 * NODE_USE_ENV_PROXY=1 is set, and older Node releases ignore them even then, so
 * a CI runner that can only reach the internet through a proxy times out.
 *
 * When a proxy variable is set, requests go through undici's own fetch with its
 * EnvHttpProxyAgent. They ship in one package, so they always agree. Installing
 * the agent as Node's global dispatcher would not: Node bundles its own undici,
 * and newer bundles look the global dispatcher up under a different key and
 * drive it with a different handler API, so an agent from another undici major
 * is silently ignored there.
 *
 * With no proxy variable set this is the built-in fetch, looked up on each call,
 * and undici is never loaded.
 */

/** Variables that name a proxy. NO_PROXY only matters alongside one of them. */
export const PROXY_VARIABLES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
] as const;

/**
 * The parts of RequestInit Octri sends. Both fetch implementations take them,
 * while their full RequestInit types (from different undici majors) disagree.
 */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

type Fetch = (url: string, init?: FetchInit) => Promise<Response>;

let proxiedFetch: Promise<Fetch> | undefined;

function proxyConfigured(): boolean {
  return PROXY_VARIABLES.some((name) => (process.env[name] ?? "") !== "");
}

/**
 * `fetch`, through the proxy the environment names when it names one.
 *
 * https:// requests use HTTPS_PROXY (falling back to HTTP_PROXY), http://
 * requests use HTTP_PROXY, lowercase names win over uppercase ones, and hosts
 * matching NO_PROXY connect directly. These are the rules Node itself applies
 * under NODE_USE_ENV_PROXY=1. The proxy addresses are read on the first
 * proxied request; NO_PROXY is re-read on every request.
 */
export async function fetchWithProxy(
  url: string,
  init?: FetchInit,
): Promise<Response> {
  if (!proxyConfigured()) return fetch(url, init);
  proxiedFetch ??= loadProxiedFetch();
  const send = await proxiedFetch;
  return send(url, init);
}

async function loadProxiedFetch(): Promise<Fetch> {
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new EnvHttpProxyAgent();
  return (url, init) => undiciFetch(url, { ...init, dispatcher });
}
