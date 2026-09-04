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

export interface Membership {
  orgId: string;
  orgName: string;
  role: string;
  status: string;
}

export interface Me {
  user: { id: string; email: string; name?: string };
  org: { id: string; name: string; plan: string; billingStatus?: string };
  role?: string;
  memberships?: Membership[];
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

/**
 * Ingestion progress. Note the nesting: the spec's own row status and the
 * generation pipeline's roll-up are separate — a spec can be `complete` while
 * its doc pages are still being written.
 */
export interface SpecStatus {
  spec: {
    id: string;
    version: string;
    status: string;
    endpointCount?: number;
    isCurrent?: boolean;
  };
  project: { id: string; status: string; docsUrl?: string };
  generation: {
    overallStatus: "queued" | "generating" | "complete" | "partial" | "failed";
    percentComplete: number;
    jobs: {
      type: string;
      status: string;
      progress: { total: number; completed: number; failed: number };
    }[];
    allComplete: boolean;
    anyFailed: boolean;
  };
}

export function specStatus(
  client: OctriClient,
  projectId: string,
  specId: string,
): Promise<SpecStatus> {
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

export type AuditSeverity = "error" | "warning" | "info" | string;

export interface AuditFinding {
  key: string;
  ruleId: string;
  title: string;
  why?: string;
  severity: AuditSeverity;
  target: string;
  message: string;
  fixable: boolean;
  fix?: { label: string; kind: string; field: string };
}

export interface AuditRule {
  ruleId: string;
  title: string;
  weight: number;
  findings: number;
  deduction: number;
}

export interface AuditResult {
  score: number;
  maxScore: number;
  findings: AuditFinding[];
  ignoredFindings: AuditFinding[];
  appliedFindings: AuditFinding[];
  byRule: AuditRule[];
  surface: { operations: number; models: number };
}

/** Spec-quality report. A read — the generator scores the stored spec in place. */
export function auditSdk(
  client: OctriClient,
  projectId: string,
): Promise<AuditResult> {
  return client.request(`/projects/${projectId}/sdk/audit`, {
    timeoutMs: 120_000,
  });
}

/** Applies one fixable finding to the spec, returning the re-scored audit. */
export function applyAuditFinding(
  client: OctriClient,
  projectId: string,
  key: string,
  input?: unknown,
): Promise<AuditResult & { appliedKey: string }> {
  return client.request(`/projects/${projectId}/sdk/audit/apply`, {
    method: "POST",
    body: input === undefined ? { key } : { key, input },
    timeoutMs: 120_000,
  });
}

/** Mutes (or un-mutes) one finding, returning the re-scored audit. */
export function ignoreAuditFinding(
  client: OctriClient,
  projectId: string,
  key: string,
  ignored: boolean,
): Promise<AuditResult> {
  return client.request(`/projects/${projectId}/sdk/audit/ignore`, {
    method: "POST",
    body: { key, ignored },
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

// ─── Monitoring ───────────────────────────────────────────────────────────────
//
// Every read and write here goes through the dashboard's monitoring proxy, which
// scopes the call to the project's `environment` and keeps the platform's
// internal token server-side. The CLI therefore never holds a monitoring
// credential for these — only the artifact uploads use the project ingest token,
// and those talk to the monitoring service directly (see `./monitoring/upload.js`).

export interface MonitoringConnection {
  configured: boolean;
  enabled: boolean;
  statusPageEnabled?: boolean;
  docsBannerEnabled?: boolean;
  statusDomain?: string;
  environment?: string;
  ingestUrl?: string;
}

/** Credentials a CI job needs to upload symbolication artifacts. */
export interface MonitoringSdkConfig {
  baseUrl: string;
  ingestUrl: string;
  token?: string;
  environment: string;
}

export interface MonitoringWindow {
  since: string;
  until: string;
}

export interface MonitoringSummary {
  window: MonitoringWindow;
  total: number;
  errors: number;
  errorRate: number;
  distinctIssues: number;
  byLevel: Record<string, number>;
}

/** A de-minified stack frame; `resolved` marks one matched to an uploaded map. */
export interface MonitoringStackFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
  resolved?: boolean;
  contextLine?: string;
}

export interface MonitoringErrorInfo {
  name?: string | null;
  message?: string | null;
  stack?: string;
  frames?: MonitoringStackFrame[];
}

export interface MonitoringIssue {
  _id: string;
  fingerprint: string;
  title?: string;
  culprit?: string | null;
  level?: string;
  method?: string | null;
  path?: string | null;
  status: "unresolved" | "resolved" | "ignored";
  count: number;
  usersAffected: number;
  firstSeen: string;
  lastSeen: string;
  lastMessage?: string | null;
  lastStatusCode?: number | null;
  lastError?: MonitoringErrorInfo | null;
  assignee?: { id?: string; name?: string; email?: string } | null;
}

export interface MonitoringLogEvent {
  _id: string;
  timestamp: string;
  level: string;
  method?: string | null;
  path?: string | null;
  message?: string | null;
  error?: MonitoringErrorInfo | null;
  statusCode?: number | null;
  latencyMs?: number | null;
  release?: string | null;
  requestId?: string | null;
}

export interface MonitoringTraceListItem {
  traceId: string;
  rootName?: string | null;
  rootService?: string | null;
  start: string;
  durationMs?: number | null;
  spanCount: number;
  hasError: boolean;
}

export interface MonitoringRelease {
  release: string;
  events: number;
  errors: number;
  errorRate: number;
  issues: number;
  usersAffected: number;
  firstSeen: string;
  lastSeen: string;
  newIssues: number;
  regressions: number;
}

export interface MonitoringAlertRule {
  _id: string;
  name: string;
  enabled: boolean;
  kind: "threshold" | "new_issue" | "regression";
  query?: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  channel: { type: "webhook" | "slack"; url: string };
  lastTriggeredAt?: string | null;
  triggerCount: number;
}

export interface MonitoringCheck {
  _id: string;
  name: string;
  method: string;
  url: string;
  intervalMinutes: number;
  timeoutMs: number;
  enabled: boolean;
  source: "spec" | "manual";
  lastStatus?: string | null;
  lastRunAt?: string | null;
  uptime?: number | null;
}

export interface MonitoringTransactionStat {
  transaction: string;
  count: number;
  errorRate: number;
  p50: number;
  p95: number;
  avgMs: number;
}

export interface MonitoringArtifactRow {
  filename?: string;
  path?: string;
  release?: string;
  size?: number;
  uploadedAt?: string;
  createdAt?: string;
}

/** Range shorthand accepted by every windowed monitoring read. */
export type MonitoringRange = "1h" | "6h" | "24h" | "7d" | "30d" | "90d";

function monitoringPath(projectId: string, suffix: string): string {
  return `/projects/${projectId}/monitoring${suffix}`;
}

export function monitoringConnection(
  client: OctriClient,
  projectId: string,
): Promise<MonitoringConnection> {
  return client.request(monitoringPath(projectId, "/connection"));
}

export function setMonitoringEnabled(
  client: OctriClient,
  projectId: string,
  enabled: boolean,
): Promise<MonitoringConnection> {
  return client.request(
    monitoringPath(projectId, enabled ? "/enable" : "/disable"),
    { method: "POST" },
  );
}

export function monitoringSdkConfig(
  client: OctriClient,
  projectId: string,
): Promise<MonitoringSdkConfig> {
  return client.request(monitoringPath(projectId, "/sdk-config"));
}

export function monitoringSummary(
  client: OctriClient,
  projectId: string,
  range: string,
): Promise<MonitoringSummary> {
  return client.request(monitoringPath(projectId, "/summary"), {
    query: { range },
  });
}

export async function monitoringIssues(
  client: OctriClient,
  projectId: string,
  query: Record<string, string | number | undefined>,
): Promise<{ items: MonitoringIssue[]; count: number }> {
  const body = await client.request<{
    items?: MonitoringIssue[];
    count?: number;
  }>(monitoringPath(projectId, "/issues"), { query });
  return { items: body.items ?? [], count: body.count ?? 0 };
}

export function monitoringIssue(
  client: OctriClient,
  projectId: string,
  issueId: string,
): Promise<{ issue: MonitoringIssue; events: MonitoringLogEvent[] }> {
  return client.request(monitoringPath(projectId, `/issues/${issueId}`));
}

export function setIssueStatus(
  client: OctriClient,
  projectId: string,
  issueId: string,
  status: "unresolved" | "resolved" | "ignored",
): Promise<MonitoringIssue> {
  return client.request(monitoringPath(projectId, `/issues/${issueId}`), {
    method: "PATCH",
    body: { status },
  });
}

export function commentOnIssue(
  client: OctriClient,
  projectId: string,
  issueId: string,
  body: string,
): Promise<unknown> {
  return client.request(
    monitoringPath(projectId, `/issues/${issueId}/comments`),
    { method: "POST", body: { body } },
  );
}

export async function monitoringLogs(
  client: OctriClient,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ items: MonitoringLogEvent[]; count: number }> {
  const result = await client.request<{
    items?: MonitoringLogEvent[];
    count?: number;
  }>(monitoringPath(projectId, "/logs/query"), { method: "POST", body });
  return { items: result.items ?? [], count: result.count ?? 0 };
}

export async function monitoringTraces(
  client: OctriClient,
  projectId: string,
  query: Record<string, string | number | undefined>,
): Promise<{ items: MonitoringTraceListItem[]; count: number }> {
  const body = await client.request<{
    items?: MonitoringTraceListItem[];
    count?: number;
  }>(monitoringPath(projectId, "/traces"), { query });
  return { items: body.items ?? [], count: body.count ?? 0 };
}

export function monitoringTrace(
  client: OctriClient,
  projectId: string,
  traceId: string,
): Promise<Record<string, unknown>> {
  return client.request(monitoringPath(projectId, `/traces/${traceId}`));
}

export function monitoringPerformance(
  client: OctriClient,
  projectId: string,
  range: string,
): Promise<{
  transactions: MonitoringTransactionStat[];
  nPlusOne: { query: string; service: string; tracesAffected: number }[];
}> {
  return client.request(monitoringPath(projectId, "/performance"), {
    query: { range },
  });
}

export async function monitoringReleases(
  client: OctriClient,
  projectId: string,
  range: string,
): Promise<MonitoringRelease[]> {
  const body = await client.request<{ items?: MonitoringRelease[] }>(
    monitoringPath(projectId, "/releases"),
    { query: { range } },
  );
  return body.items ?? [];
}

export async function monitoringAlerts(
  client: OctriClient,
  projectId: string,
): Promise<MonitoringAlertRule[]> {
  const body = await client.request<{ items?: MonitoringAlertRule[] }>(
    monitoringPath(projectId, "/alerts"),
  );
  return body.items ?? [];
}

export function createMonitoringAlert(
  client: OctriClient,
  projectId: string,
  body: Record<string, unknown>,
): Promise<MonitoringAlertRule> {
  return client.request(monitoringPath(projectId, "/alerts"), {
    method: "POST",
    body,
  });
}

export function deleteMonitoringAlert(
  client: OctriClient,
  projectId: string,
  alertId: string,
): Promise<unknown> {
  return client.request(monitoringPath(projectId, `/alerts/${alertId}`), {
    method: "DELETE",
  });
}

export function evaluateMonitoringAlerts(
  client: OctriClient,
  projectId: string,
): Promise<{ evaluated: number; results: { rule: string; triggered?: boolean }[] }> {
  return client.request(monitoringPath(projectId, "/alerts/evaluate"), {
    method: "POST",
  });
}

export async function monitoringChecks(
  client: OctriClient,
  projectId: string,
): Promise<MonitoringCheck[]> {
  const body = await client.request<{ items?: MonitoringCheck[] }>(
    monitoringPath(projectId, "/checks"),
  );
  return body.items ?? [];
}

export function runMonitoringCheck(
  client: OctriClient,
  projectId: string,
  checkId: string,
): Promise<Record<string, unknown>> {
  return client.request(monitoringPath(projectId, `/checks/${checkId}/run`), {
    method: "POST",
    timeoutMs: 60_000,
  });
}

/**
 * Derives one check per endpoint from the current spec. `baseUrl` is only needed
 * when the spec declares no absolute server URL — otherwise the first server wins.
 */
export function generateMonitoringChecks(
  client: OctriClient,
  projectId: string,
  options: { baseUrl?: string; intervalMinutes?: number } = {},
): Promise<{
  generated?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  baseUrl?: string;
}> {
  return client.request(monitoringPath(projectId, "/checks/generate"), {
    method: "POST",
    body: {
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.intervalMinutes === undefined
        ? {}
        : { intervalMinutes: options.intervalMinutes }),
    },
    timeoutMs: 120_000,
  });
}

export function sendMonitoringTestEvent(
  client: OctriClient,
  projectId: string,
): Promise<Record<string, unknown>> {
  return client.request(monitoringPath(projectId, "/test-event"), {
    method: "POST",
    timeoutMs: 60_000,
  });
}

export async function monitoringArtifacts(
  client: OctriClient,
  projectId: string,
  kind: "sourcemaps" | "source-files",
  release?: string,
): Promise<MonitoringArtifactRow[]> {
  const body = await client.request<
    { items?: MonitoringArtifactRow[] } | MonitoringArtifactRow[]
  >(monitoringPath(projectId, `/${kind}`), {
    query: release === undefined ? {} : { release },
  });
  return Array.isArray(body) ? body : (body.items ?? []);
}

// ─── Organisation, members, invites ───────────────────────────────────────────

export interface Org {
  id: string;
  name: string;
  slug?: string;
  plan: string;
  /** Only set when the org came from the membership list. */
  role?: string;
  status?: string;
  planLimits?: Record<string, unknown>;
  usage?: Record<string, number>;
  preferredSdkLanguages?: string[];
  createdAt?: string;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  mfaEnabled?: boolean;
  lastActiveAt?: string;
  joinedAt?: string;
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface BillingStatus {
  plan: string;
  status?: string;
  trialEndsAt?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  usage?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

export interface Invoice {
  id?: string;
  number?: string;
  amount?: number;
  currency?: string;
  status?: string;
  createdAt?: string;
  hostedUrl?: string;
}

/**
 * Orgs the signed-in user belongs to.
 *
 * There is no `GET /orgs` collection route — org membership is part of the
 * session, so the switcher (and this) reads it off `/auth/me`. The plan is only
 * known for the *active* org, which is why it is blank for the others.
 */
export async function listOrgs(client: OctriClient): Promise<Org[]> {
  const who = await me(client);
  const memberships = who.memberships ?? [];
  if (memberships.length === 0) {
    return [{ id: who.org.id, name: who.org.name, plan: who.org.plan }];
  }
  return memberships.map((m) => ({
    id: m.orgId,
    name: m.orgName,
    plan: m.orgId === who.org.id ? who.org.plan : "",
    role: m.role,
    status: m.status,
  }));
}

export async function getOrg(client: OctriClient, orgId: string): Promise<Org> {
  const body = await client.request<{ org: Org }>(`/orgs/${orgId}`);
  return body.org;
}

export async function listMembers(
  client: OctriClient,
  orgId: string,
): Promise<Member[]> {
  const body = await client.request<{ members?: Member[] }>(
    `/orgs/${orgId}/members`,
  );
  return body.members ?? [];
}

export function updateMember(
  client: OctriClient,
  orgId: string,
  userId: string,
  patch: { role?: string; status?: string },
): Promise<unknown> {
  return client.request(`/orgs/${orgId}/members/${userId}`, {
    method: "PATCH",
    body: patch,
  });
}

export function removeMember(
  client: OctriClient,
  orgId: string,
  userId: string,
): Promise<unknown> {
  return client.request(`/orgs/${orgId}/members/${userId}`, {
    method: "DELETE",
  });
}

export async function listInvites(
  client: OctriClient,
  orgId: string,
): Promise<Invite[]> {
  const body = await client.request<{ invites?: Invite[] }>(
    `/orgs/${orgId}/invites`,
  );
  return body.invites ?? [];
}

export function createInvite(
  client: OctriClient,
  orgId: string,
  email: string,
  role: string,
): Promise<unknown> {
  return client.request(`/orgs/${orgId}/invites`, {
    method: "POST",
    body: { email, role },
  });
}

export function resendInvite(
  client: OctriClient,
  orgId: string,
  inviteId: string,
): Promise<unknown> {
  return client.request(`/orgs/${orgId}/invites/${inviteId}/resend`, {
    method: "POST",
  });
}

export function revokeInvite(
  client: OctriClient,
  orgId: string,
  inviteId: string,
): Promise<unknown> {
  return client.request(`/orgs/${orgId}/invites/${inviteId}`, {
    method: "DELETE",
  });
}

export function orgUsage(
  client: OctriClient,
  orgId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/orgs/${orgId}/usage`);
}

export function billingStatus(
  client: OctriClient,
  orgId: string,
): Promise<BillingStatus> {
  return client.request(`/orgs/${orgId}/billing/status`);
}

export async function listInvoices(
  client: OctriClient,
  orgId: string,
): Promise<Invoice[]> {
  const body = await client.request<{ invoices?: Invoice[] }>(
    `/orgs/${orgId}/billing/invoices`,
  );
  return body.invoices ?? [];
}

/** Re-issues the session against another org. Returns the new tokens. */
export function switchOrg(
  client: OctriClient,
  orgId: string,
): Promise<{ accessToken?: string; refreshToken?: string }> {
  return client.request("/auth/switch-org", {
    method: "POST",
    body: { orgId },
  });
}

// ─── API keys ─────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  prefix?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  createdBy?: string;
}

export async function listApiKeys(client: OctriClient): Promise<ApiKey[]> {
  const body = await client.request<{ keys?: ApiKey[] } | ApiKey[]>(
    "/api-keys",
  );
  return Array.isArray(body) ? body : (body.keys ?? []);
}

/** `plaintext` is returned once, on creation, and is never readable again. */
export function createApiKey(
  client: OctriClient,
  name: string,
  expiresAt?: string,
): Promise<{ key: ApiKey; plaintext: string }> {
  return client.request("/api-keys", {
    method: "POST",
    body: expiresAt === undefined ? { name } : { name, expiresAt },
  });
}

export function revokeApiKey(
  client: OctriClient,
  keyId: string,
): Promise<unknown> {
  return client.request(`/api-keys/${keyId}`, { method: "DELETE" });
}

// ─── Docs authoring: pages, guides, nav, versions, domain ─────────────────────

export interface DocPageDetail extends DocPage {
  hasDraft?: boolean;
  noindex?: boolean;
  publishedAt?: string;
}

export interface GenerationSummary {
  total?: number;
  generated?: number;
  stale?: number;
  missing?: number;
  edited?: number;
  [key: string]: unknown;
}

export function docsGenerationSummary(
  client: OctriClient,
  projectId: string,
): Promise<GenerationSummary> {
  return client.request(`/projects/${projectId}/doc-pages/generation-summary`);
}

/**
 * Rebuilds doc pages. `missing` leaves fingerprints alone and lets the freshness
 * classifier decide; `all` drops them so every page is rewritten.
 */
export function generateDocPages(
  client: OctriClient,
  projectId: string,
  mode: "missing" | "all",
  clearOverrides: boolean,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/doc-pages/generate`, {
    method: "POST",
    body: { mode, clearOverrides },
    timeoutMs: 300_000,
  });
}

export function regenerateDocPage(
  client: OctriClient,
  projectId: string,
  docPageId: string,
): Promise<Record<string, unknown>> {
  return client.request(
    `/projects/${projectId}/doc-pages/${docPageId}/regenerate`,
    { method: "POST", body: {}, timeoutMs: 300_000 },
  );
}

export function publishDocPageDraft(
  client: OctriClient,
  projectId: string,
  docPageId: string,
): Promise<Record<string, unknown>> {
  return client.request(
    `/projects/${projectId}/doc-pages/${docPageId}/draft/publish`,
    { method: "POST", body: {} },
  );
}

export function setDocPageTitle(
  client: OctriClient,
  projectId: string,
  docPageId: string,
  title: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/doc-pages/${docPageId}/title`, {
    method: "PATCH",
    body: { title },
  });
}

export interface NavTab {
  id?: string;
  title?: string;
  label?: string;
  items?: unknown[];
}

export function getNav(
  client: OctriClient,
  projectId: string,
): Promise<{ sections: unknown; tabs: NavTab[]; hasDraft: boolean }> {
  return client.request(`/projects/${projectId}/nav`);
}

export function publishNav(
  client: OctriClient,
  projectId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/nav/publish`, {
    method: "POST",
    body: {},
  });
}

export interface Guide {
  id: string;
  title: string;
  slug: string;
  groupId: string | null;
  order?: number;
  published: boolean;
  hasUnpublishedChanges: boolean;
}

export async function listGuides(
  client: OctriClient,
  projectId: string,
): Promise<Guide[]> {
  const body = await client.request<{ guides?: Guide[] }>(
    `/projects/${projectId}/guides`,
  );
  return body.guides ?? [];
}

export function getGuide(
  client: OctriClient,
  projectId: string,
  guideId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/guides/${guideId}`);
}

export function publishGuide(
  client: OctriClient,
  projectId: string,
  guideId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/guides/${guideId}/publish`, {
    method: "POST",
    body: {},
  });
}

export interface DocsVersion {
  specId: string;
  version: string;
  versionLabel?: string;
  publishedAt?: string;
  endpointCount?: number;
  isCurrent?: boolean;
}

export async function listVersions(
  client: OctriClient,
  projectId: string,
): Promise<DocsVersion[]> {
  const body = await client.request<{ versions?: DocsVersion[] }>(
    `/projects/${projectId}/versions`,
  );
  return body.versions ?? [];
}

export function publishVersion(
  client: OctriClient,
  projectId: string,
  specId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/versions/${specId}/publish`, {
    method: "POST",
    body: {},
  });
}

export function unpublishVersion(
  client: OctriClient,
  projectId: string,
  specId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/versions/${specId}/unpublish`, {
    method: "DELETE",
  });
}

export function labelVersion(
  client: OctriClient,
  projectId: string,
  specId: string,
  versionLabel: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/versions/${specId}/label`, {
    method: "PATCH",
    body: { versionLabel },
  });
}

export function setDefaultVersion(
  client: OctriClient,
  projectId: string,
  specId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/versions/default`, {
    method: "PATCH",
    body: { specId },
  });
}

export interface CustomDomain {
  cnameTarget: string;
  domain: {
    hostname: string;
    status: "pending_verification" | "verified" | "failed";
    addedAt?: string;
    verifiedAt?: string | null;
    lastError?: string | null;
  } | null;
  instructions: {
    cnameRecord: { type: string; name: string; value: string };
    txtRecord: { type: string; name: string; value: string };
  } | null;
}

export function getCustomDomain(
  client: OctriClient,
  projectId: string,
): Promise<CustomDomain> {
  return client.request(`/projects/${projectId}/custom-domain`);
}

export function setCustomDomain(
  client: OctriClient,
  projectId: string,
  hostname: string,
): Promise<CustomDomain> {
  return client.request(`/projects/${projectId}/custom-domain`, {
    method: "POST",
    body: { hostname },
  });
}

export function verifyCustomDomain(
  client: OctriClient,
  projectId: string,
): Promise<CustomDomain> {
  return client.request(`/projects/${projectId}/custom-domain/verify`, {
    method: "POST",
    body: {},
    timeoutMs: 60_000,
  });
}

export function removeCustomDomain(
  client: OctriClient,
  projectId: string,
): Promise<unknown> {
  return client.request(`/projects/${projectId}/custom-domain`, {
    method: "DELETE",
  });
}

// ─── GitHub spec sync ─────────────────────────────────────────────────────────

export interface GitHubStatus {
  connected: boolean;
  autoSync: boolean;
  reverseSyncSpec?: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  specPath?: string;
  webhookId?: string;
  lastSyncedAt?: string;
  lastSyncedSha?: string;
}

export function githubStatus(
  client: OctriClient,
  projectId: string,
): Promise<GitHubStatus> {
  return client.request(`/projects/${projectId}/github/status`);
}

export function githubConnect(
  client: OctriClient,
  projectId: string,
  body: { owner: string; repo: string; branch: string; specPath: string },
): Promise<GitHubStatus> {
  return client.request(`/projects/${projectId}/github/connect`, {
    method: "POST",
    body,
    timeoutMs: 120_000,
  });
}

export function githubDisconnect(
  client: OctriClient,
  projectId: string,
): Promise<unknown> {
  return client.request(`/projects/${projectId}/github/disconnect`, {
    method: "DELETE",
  });
}

export function githubSyncNow(
  client: OctriClient,
  projectId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/github/sync-now`, {
    method: "POST",
    body: {},
    timeoutMs: 180_000,
  });
}

export function githubSyncToggle(
  client: OctriClient,
  projectId: string,
  autoSync: boolean,
): Promise<GitHubStatus> {
  return client.request(`/projects/${projectId}/github/sync-toggle`, {
    method: "PATCH",
    body: { autoSync },
  });
}

export function githubAppStatus(
  client: OctriClient,
  projectId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/github/app/status`);
}

// ─── Generation jobs ──────────────────────────────────────────────────────────

export interface JobSummary {
  total: number;
  queued: number;
  processing: number;
  complete: number;
  failed: number;
}

export function jobSummary(
  client: OctriClient,
  projectId: string,
): Promise<JobSummary> {
  return client.request(`/projects/${projectId}/jobs`);
}

export function getJob(
  client: OctriClient,
  projectId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  return client.request(`/projects/${projectId}/jobs/${jobId}`);
}
