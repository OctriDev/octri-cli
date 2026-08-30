/**
 * Typed façade over the Octri HTTP surface.
 *
 * Both the terminal commands and the MCP server call into this module, so a
 * route only ever gets spelled once and an agent driving the CLI over MCP sees
 * exactly the same behaviour a human does.
 *
 * Route split (see the repo's CLAUDE.md): client-facing project/spec/SDK-build
 * routes live under `routes/v1`, while Studio-shaped routes (settings, live
 * operations, preview, repos) are the dashboard's own — both are mounted under
 * the same `/api/v1` prefix, so they share one client.
 */

import type { OctriClient } from "./client.js";

// ─── Shared shapes ────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  docsUrl?: string;
  specCount?: number;
}

export interface Spec {
  id: string;
  version: string;
  title?: string;
  status?: string;
  createdAt?: string;
  endpointCount?: number;
  isCurrent?: boolean;
}

export type LangBuildStatus =
  | "queued"
  | "generating"
  | "verifying"
  | "packaging"
  | "installing"
  | "verified"
  | "ready"
  | "failed";

export type BuildStatus =
  | "queued"
  | "generating"
  | "ready"
  | "partial"
  | "failed";

export interface BuildArtifactSummary {
  languageId: string;
  languageName: string;
  status: LangBuildStatus;
  errorMessage?: string;
  downloadUrl?: string;
  publishStatus?: string;
  registry?: string;
  registryPackageName?: string;
  publishedVersion?: string;
  publishError?: string;
  generationVerification?: unknown;
}

export interface Build {
  id: string;
  version: string;
  languages: string[];
  trigger: string;
  status: BuildStatus;
  createdAt: string;
  artifacts: BuildArtifactSummary[];
}

export interface Artifact {
  id: string;
  language: string;
  version: string;
  fileSizeBytes?: number;
  downloadCount?: number;
  publishStatus?: string;
  registry?: string;
  registryPackageName?: string;
  publishedAt?: string;
  url?: string;
  generationVerification?: unknown;
}

export interface SdkLanguage {
  id: string;
  name: string;
  preferences?: Record<string, unknown>;
}

export interface SdkOperation {
  slug?: string;
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  tags?: string[];
  deprecated?: boolean;
  [key: string]: unknown;
}

export interface SdkSettingsBundle {
  sdkSettings: Record<string, unknown>;
  sdkEndpoints: Record<string, unknown>;
  deprecationBaselines: { sdk: unknown; docs: unknown };
  revision: number;
  release?: {
    revision: number;
    version: string;
    publishedAt: string;
    changelog: string;
  };
  repoHookKeys: { slug: string; langId: string }[];
}

export interface ValidationResult {
  valid: boolean;
  summary?: Record<string, unknown>;
  errors?: { message: string; path?: string; severity?: string }[];
  warnings?: { message: string; path?: string }[];
}

export interface DocPage {
  slug: string;
  title: string;
  type?: string;
  updatedAt?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

// ─── Auth / identity ──────────────────────────────────────────────────────────

export interface Me {
  user: { id: string; email: string; name?: string };
  org: { id: string; name: string; plan: string; billingStatus?: string };
}

export function me(client: OctriClient): Promise<Me> {
  return client.request<Me>("/auth/me");
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(client: OctriClient): Promise<Project[]> {
  const body = await client.request<{ projects?: Project[] } | Project[]>(
    "/projects",
  );
  return Array.isArray(body) ? body : (body.projects ?? []);
}

export async function getProject(
  client: OctriClient,
  projectId: string,
): Promise<Project> {
  const body = await client.request<{ project?: Project } & Project>(
    `/projects/${projectId}`,
  );
  return body.project ?? body;
}

export async function createProject(
  client: OctriClient,
  input: { name: string; description?: string },
): Promise<Project> {
  const body = await client.request<{ project?: Project } & Project>(
    "/projects",
    { method: "POST", body: input },
  );
  return body.project ?? body;
}

export function updateProject(
  client: OctriClient,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return client.request(`/projects/${projectId}`, {
    method: "PATCH",
    body: patch,
  });
}

// ─── Specs ────────────────────────────────────────────────────────────────────

export async function listSpecs(
  client: OctriClient,
  projectId: string,
): Promise<Spec[]> {
  const body = await client.request<{ specs?: Spec[] } | Spec[]>(
    `/projects/${projectId}/specs`,
  );
  return Array.isArray(body) ? body : (body.specs ?? []);
}

/**
 * Uploads spec text. Goes through `/specs/raw` rather than the multipart
 * `/specs/upload` route — same ingestion pipeline, no multipart encoding to
 * hand-roll, and it works identically for JSON and YAML.
 */
export interface SpecIngestResult {
  specId: string;
  version: string;
  endpointCount: number;
  jobs?: unknown;
}

export function uploadSpecContent(
  client: OctriClient,
  projectId: string,
  content: string,
): Promise<SpecIngestResult> {
  return client.request(`/projects/${projectId}/specs/raw`, {
    method: "POST",
    body: { content },
    // Large enterprise specs take a while to parse server-side.
    timeoutMs: 120_000,
  });
}

export function importSpecUrl(
  client: OctriClient,
  projectId: string,
  url: string,
): Promise<SpecIngestResult> {
  return client.request(`/projects/${projectId}/specs/url`, {
    method: "POST",
    body: { url },
    timeoutMs: 120_000,
  });
}

export function specStatus(
  client: OctriClient,
  projectId: string,
  specId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/specs/${specId}/status`);
}

export function deleteSpec(
  client: OctriClient,
  projectId: string,
  specId: string,
): Promise<unknown> {
  return client.request(`/projects/${projectId}/specs/${specId}`, {
    method: "DELETE",
  });
}

// ─── SDK: catalogue, config, preview ──────────────────────────────────────────

export async function listLanguages(
  client: OctriClient,
): Promise<SdkLanguage[]> {
  const body = await client.request<
    { languages?: SdkLanguage[] | Record<string, SdkLanguage> } | SdkLanguage[]
  >("/sdk/languages");

  const raw = Array.isArray(body) ? body : body.languages;
  if (raw === undefined) return [];
  // The generator returns an object keyed by language id; the dashboard
  // normalises it to an array. Accept both so a stubbed generator works too.
  return Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([id, value]) => ({ ...value, id }));
}

export async function listOperations(
  client: OctriClient,
  projectId: string,
): Promise<SdkOperation[]> {
  const body = await client.request<{ operations: SdkOperation[] }>(
    `/projects/${projectId}/sdk/operations`,
  );
  return body.operations ?? [];
}

export function getSdkSettings(
  client: OctriClient,
  projectId: string,
): Promise<SdkSettingsBundle> {
  return client.request(`/projects/${projectId}/sdk-settings`);
}

/**
 * Publishes the Studio draft. `revision` is an optimistic-concurrency guard —
 * pass the value from a fresh `getSdkSettings`, or the API rejects the write.
 */
export function putSdkSettings(
  client: OctriClient,
  projectId: string,
  body: {
    settings: Record<string, unknown>;
    endpoints?: Record<string, unknown>;
    revision: number;
    version?: string;
    changelog?: string;
  },
): Promise<unknown> {
  return client.request(`/projects/${projectId}/sdk-settings`, {
    method: "PUT",
    body: { endpoints: {}, changelog: "", ...body },
  });
}

export function getSdkCustomisation(
  client: OctriClient,
  projectId: string,
): Promise<{ sdkCustomisation: Record<string, unknown> }> {
  return client.request(`/projects/${projectId}/sdk-customisation`);
}

export function patchSdkCustomisation(
  client: OctriClient,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return client.request(`/projects/${projectId}/sdk-customisation`, {
    method: "PATCH",
    body: patch,
  });
}

export function validateSpec(
  client: OctriClient,
  projectId: string,
): Promise<ValidationResult> {
  return client.request(`/projects/${projectId}/sdk/validate`, {
    method: "POST",
    body: {},
    timeoutMs: 120_000,
  });
}

export function auditSdk(
  client: OctriClient,
  projectId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/sdk/audit`, {
    method: "POST",
    body: {},
    timeoutMs: 120_000,
  });
}

export interface PreviewFile {
  path: string;
  content: string;
}

/**
 * Single-language generator preview. This is the fast loop for generator work:
 * it returns real emitted files without spending a build.
 */
export async function previewSdk(
  client: OctriClient,
  projectId: string,
  language: string,
  preferences: Record<string, unknown> = {},
): Promise<PreviewFile[]> {
  const body = await client.request<{ files?: PreviewFile[] }>(
    `/projects/${projectId}/sdk/preview`,
    {
      method: "POST",
      body: { language, preferences },
      timeoutMs: 180_000,
    },
  );
  return body.files ?? [];
}

// ─── SDK: builds ──────────────────────────────────────────────────────────────

export interface TriggerResult {
  buildId: string;
  message: string;
}

export function triggerBuild(
  client: OctriClient,
  projectId: string,
  input: {
    languages: string[];
    version?: string;
    preferences?: Record<string, unknown>;
    languagePreferences?: Record<string, Record<string, unknown>>;
    releaseRevision?: number;
  },
): Promise<TriggerResult> {
  return client.request(`/projects/${projectId}/sdk/trigger`, {
    method: "POST",
    body: input,
  });
}

export interface BuildsPage {
  builds: Build[];
  total: number;
  page: number;
  pageSize: number;
}

export function listBuilds(
  client: OctriClient,
  projectId: string,
  page = 1,
): Promise<BuildsPage> {
  return client.request(`/projects/${projectId}/sdk/builds`, {
    query: { page },
  });
}

/** Single build, read off the paginated list (there is no by-id build route). */
export async function findBuild(
  client: OctriClient,
  projectId: string,
  buildId: string,
): Promise<Build | undefined> {
  for (let page = 1; page <= 5; page += 1) {
    const result = await listBuilds(client, projectId, page);
    const hit = result.builds.find((b) => b.id === buildId);
    if (hit !== undefined) return hit;
    if (result.builds.length === 0 || page * result.pageSize >= result.total) {
      return undefined;
    }
  }
  return undefined;
}

export async function listArtifacts(
  client: OctriClient,
  projectId: string,
  buildId: string,
  directDownload = false,
): Promise<Artifact[]> {
  const body = await client.request<{ artifacts: Artifact[] }>(
    `/projects/${projectId}/sdk/builds/${buildId}/artifacts`,
    directDownload ? { query: { delivery: "direct" } } : {},
  );
  return body.artifacts ?? [];
}

export function retryBuild(
  client: OctriClient,
  projectId: string,
  buildId: string,
  languages: string[],
): Promise<unknown> {
  return client.request(`/projects/${projectId}/sdk/builds/${buildId}/retry`, {
    method: "POST",
    body: { languages },
  });
}

export function publishBuild(
  client: OctriClient,
  projectId: string,
  buildId: string,
  input: {
    languages?: string[];
    mode?: "pack" | "release";
    skipValidate?: boolean;
  },
): Promise<unknown> {
  return client.request(
    `/projects/${projectId}/sdk/builds/${buildId}/publish`,
    { method: "POST", body: input },
  );
}

// ─── SDK: per-language repos ──────────────────────────────────────────────────

export interface SdkRepoQuality {
  state: string;
}

export interface SdkRepoTarget {
  owner: string;
  repo: string;
  branch: string;
  commitSha?: string | null;
  stagedAt?: string | null;
  quality?: SdkRepoQuality;
}

export interface SdkRepo {
  langId: string;
  staging: SdkRepoTarget;
  production?: SdkRepoTarget | null;
  initializedAt?: string;
  lastVersion?: string | null;
}

export interface InitializeRepoInput {
  staging: Pick<SdkRepoTarget, "owner" | "repo" | "branch">;
  production: Pick<SdkRepoTarget, "owner" | "repo" | "branch">;
}

export async function listRepos(
  client: OctriClient,
  projectId: string,
): Promise<SdkRepo[]> {
  const body = await client.request<{ repos?: SdkRepo[] } | SdkRepo[]>(
    `/projects/${projectId}/sdk/repos`,
  );
  return Array.isArray(body) ? body : (body.repos ?? []);
}

export function initializeRepo(
  client: OctriClient,
  projectId: string,
  langId: string,
  body: InitializeRepoInput,
): Promise<unknown> {
  return client.request(
    `/projects/${projectId}/sdk/repos/${langId}/initialize`,
    { method: "POST", body, timeoutMs: 180_000 },
  );
}

export function promoteRepo(
  client: OctriClient,
  projectId: string,
  langId: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return client.request(`/projects/${projectId}/sdk/repos/${langId}/promote`, {
    method: "POST",
    body,
    timeoutMs: 180_000,
  });
}

// ─── Docs / changelog / MCP ───────────────────────────────────────────────────

export async function listDocPages(
  client: OctriClient,
  projectId: string,
): Promise<DocPage[]> {
  const body = await client.request<{ pages?: DocPage[] } | DocPage[]>(
    `/projects/${projectId}/docs/pages`,
  );
  return Array.isArray(body) ? body : (body.pages ?? []);
}

export function getDocPage(
  client: OctriClient,
  projectId: string,
  slug: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/docs/pages/${slug}`);
}

export function listChangelog(
  client: OctriClient,
  projectId: string,
  limit = 20,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/changelog`, {
    query: { limit },
  });
}

/** Public MCP tool catalogue derived from the project's SDK config. */
export async function listMcpTools(
  client: OctriClient,
  projectId: string,
): Promise<McpTool[]> {
  const body = await client.request<{ tools?: McpTool[] } | McpTool[]>(
    `/public/mcp/${projectId}/tools`,
  );
  return Array.isArray(body) ? body : (body.tools ?? []);
}

// ─── Polling helper ───────────────────────────────────────────────────────────

/** Language states that still have no terminal verdict. */
export const IN_FLIGHT: ReadonlySet<LangBuildStatus> = new Set([
  "queued",
  "generating",
  "verifying",
  "packaging",
  "installing",
  "verified",
]);

export function isTerminal(build: Build): boolean {
  if (build.status === "queued" || build.status === "generating") return false;
  return build.artifacts.every((a) => !IN_FLIGHT.has(a.status));
}

export interface WatchOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (build: Build) => void;
}

/**
 * Polls a build to completion.
 *
 * Polling rather than the `/ws/sdk` socket on purpose: that socket authenticates
 * from an `Authorization` header or cookie, neither of which Node's built-in
 * WebSocket can set, and adding a WebSocket dependency to buy ~1s of latency on
 * a multi-minute build is a bad trade.
 */
export async function watchBuild(
  client: OctriClient,
  projectId: string,
  buildId: string,
  { intervalMs = 2_000, timeoutMs = 45 * 60_000, onTick }: WatchOptions = {},
): Promise<Build> {
  const deadline = Date.now() + timeoutMs;
  let last: Build | undefined;

  while (Date.now() < deadline) {
    const build = await findBuild(client, projectId, buildId);
    if (build !== undefined) {
      last = build;
      onTick?.(build);
      if (isTerminal(build)) return build;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (last !== undefined) return last;
  throw new Error(`Build ${buildId} not found on this project.`);
}
