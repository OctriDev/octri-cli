/**
 * Symbolication artifact uploads — source maps for minifying toolchains, source
 * bundles for compiled languages.
 *
 * These POST straight at the monitoring service with the project's ingest token
 * rather than through the Octri API, because that is what a CI job can do with
 * one secret and no interactive login. `octri monitoring sourcemaps upload`
 * resolves that connection for you when you are signed in; passing --url/--token
 * /--environment skips the API entirely, which is the shape CI usually wants.
 *
 * Previously published as `@octri/monitoring-cli`, folded in here so one binary
 * covers the whole product.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

export interface UploadOptions {
  /** Monitoring base URL, e.g. https://monitoring.example.com. */
  url: string;
  /** Ingest token (the same one baked into your generated SDK). */
  token: string;
  /** Project environment / id this build belongs to. */
  environment: string;
  /** Release identifier; must match the `release` your SDK reports at runtime. */
  release: string;
  /** Files / directories to search for `*.map` (directories are scanned recursively). */
  paths: string[];
  /** When true, find + report the maps but do not upload. */
  dryRun?: boolean;
}

export interface UploadResult {
  release: string;
  environment: string;
  files: string[];
  stored: number;
}

/** A single source map ready to upload. */
interface SourceMapFile {
  filename: string;
  content: string;
}

// ── Bounded upload retry ─────────────────────────────────────────────────────
// 429 (monitoring ingress burst ceiling) and 503 are transient — retry with a
// backoff that honours Retry-After so a CI upload rides out a short throttle
// instead of failing the build. Bounded attempts: after the cap the response is
// returned as-is and the caller surfaces it (never a hot-loop, never silent).

const RETRYABLE_UPLOAD_STATUSES = new Set([429, 503]);
const MAX_UPLOAD_ATTEMPTS = 4;
const MAX_UPLOAD_BACKOFF_MS = 8_000;

function uploadBackoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1_000, MAX_UPLOAD_BACKOFF_MS);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_UPLOAD_BACKOFF_MS);
  }
  return Math.min(500 * 2 ** (attempt - 1), MAX_UPLOAD_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POSTs a JSON body, retrying transient 429/503 with bounded Retry-After backoff. */
async function postJsonWithRetry(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(endpoint, { method: "POST", headers, body });
    if (res.ok || !RETRYABLE_UPLOAD_STATUSES.has(res.status) || attempt >= MAX_UPLOAD_ATTEMPTS) {
      return res;
    }
    await sleep(uploadBackoffMs(attempt, res.headers.get("retry-after")));
  }
}

// Resolve the release from the current git checkout, when not given explicitly.
export function gitRelease(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

// Recursively collect every `*.map` file under the given paths. A path that is
// itself a `.map` file is included directly.
async function findSourceMaps(paths: string[]): Promise<string[]> {
  const found = new Set<string>();

  const walk = async (path: string): Promise<void> => {
    const abs = resolve(path);
    const stats = await stat(abs).catch(() => null);
    if (stats === null) return;
    if (stats.isFile()) {
      if (abs.endsWith(".map")) found.add(abs);
      return;
    }
    if (!stats.isDirectory()) return;
    const entries = await readdir(abs, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) => {
        // Skip dependency + VCS dirs so we only pick up build output.
        if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === ".git")) {
          return Promise.resolve();
        }
        return walk(join(abs, entry.name));
      }),
    );
  };

  await Promise.all(paths.map(walk));
  return [...found].sort();
}

// Source maps can be large; keep each upload request comfortably under the
// service's 25 MB body limit by batching.
const MAX_BATCH_BYTES = 15 * 1024 * 1024;

function artifactIdempotencyKey(
  kind: "sourcemaps" | "source-files",
  environment: string,
  release: string,
  files: readonly { content: string }[],
): string {
  const digest = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(environment)
    .update("\0")
    .update(release)
    .update("\0")
    .update(JSON.stringify(files))
    .digest("base64url");
  return `octri-artifact-${digest}`;
}

function batch<T extends { content: string }>(files: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length > 0 && size + file.content.length > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.content.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Finds `*.map` files under `paths` and uploads them to the monitoring service,
 * keyed by `(environment, release, filename)`. Returns the list of uploaded
 * files and the count the service stored.
 */
export async function uploadSourceMaps(options: UploadOptions): Promise<UploadResult> {
  const { url, token, environment, release, paths, dryRun = false } = options;

  const mapPaths = await findSourceMaps(paths.length > 0 ? paths : ["."]);
  const files: SourceMapFile[] = await Promise.all(
    mapPaths.map(async (path) => ({ filename: basename(path), content: await readFile(path, "utf8") })),
  );

  const result: UploadResult = { release, environment, files: files.map((f) => f.filename), stored: 0 };
  if (dryRun || files.length === 0) return result;

  const endpoint = `${url.replace(/\/$/, "")}/sourcemaps`;
  for (const group of batch(files)) {
    const idempotencyKey = artifactIdempotencyKey("sourcemaps", environment, release, group);
    const res = await postJsonWithRetry(
      endpoint,
      {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      JSON.stringify({ environment, release, files: group }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upload failed (${res.status} ${res.statusText}): ${text.slice(0, 300)}`);
    }
    const body: unknown = await res.json().catch(() => null);
    const stored =
      typeof body === "object" && body !== null && typeof (body as { stored?: unknown }).stored === "number"
        ? (body as { stored: number }).stored
        : group.length;
    result.stored += stored;
  }

  return result;
}

// ── Source bundles (compiled languages) ──────────────────────────────────────
// Compiled stack frames (Go, Rust, Java/Kotlin, Swift, …) already carry their
// original file + line, but a production binary ships without the source TEXT.
// Uploading a source bundle per release lets the dashboard show the original
// code at each frame — the compiled-language analog of source maps.

/** Source extensions collected by `sources upload` when none are given. */
export const SOURCE_EXTENSIONS = [
  ".go", ".rs", ".swift", ".java", ".kt", ".kts", ".scala",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".m", ".mm",
  ".cs", ".py", ".rb", ".php", ".js", ".jsx", ".ts", ".tsx", ".dart",
];

// Dependency / build / VCS directories that never contain the user's own source.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "target", "build", "dist", ".next",
  ".dart_tool", "__pycache__", ".venv", "venv", ".gradle", "Pods", ".idea", ".vscode",
]);

export interface SourceUploadOptions {
  /** Monitoring base URL, e.g. https://monitoring.example.com. */
  url: string;
  /** Ingest token (the same one baked into your generated SDK). */
  token: string;
  /** Project environment / id this build belongs to. */
  environment: string;
  /** Release identifier; must match the `release` your SDK reports at runtime. */
  release: string;
  /** Files / directories to scan for source (directories are walked recursively). */
  paths: string[];
  /** Extensions to collect (default: {@link SOURCE_EXTENSIONS}). */
  extensions?: string[];
  /** When true, find + report the files but do not upload. */
  dryRun?: boolean;
}

export interface SourceUploadResult {
  release: string;
  environment: string;
  files: string[];
  stored: number;
}

/** A single source file ready to upload, keyed by its path relative to cwd. */
interface SourceFileEntry {
  path: string;
  content: string;
}

// Recursively collect every source file (by extension) under the given paths,
// skipping dependency / build / VCS directories.
async function findSourceFiles(paths: string[], extensions: string[]): Promise<string[]> {
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  const found = new Set<string>();

  const walk = async (path: string): Promise<void> => {
    const abs = resolve(path);
    const stats = await stat(abs).catch(() => null);
    if (stats === null) return;
    if (stats.isFile()) {
      if (exts.has(extname(abs).toLowerCase())) found.add(abs);
      return;
    }
    if (!stats.isDirectory()) return;
    const entries = await readdir(abs, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) => {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) return Promise.resolve();
        return walk(join(abs, entry.name));
      }),
    );
  };

  await Promise.all(paths.map(walk));
  return [...found].sort();
}

/**
 * Finds source files under `paths` and uploads them to the monitoring service,
 * keyed by `(environment, release, path)` — the path kept relative to cwd so it
 * can suffix-match a frame's absolute build path. Returns the uploaded files and
 * the count the service stored.
 */
export async function uploadSourceFiles(options: SourceUploadOptions): Promise<SourceUploadResult> {
  const { url, token, environment, release, paths, extensions = SOURCE_EXTENSIONS, dryRun = false } = options;

  const filePaths = await findSourceFiles(paths.length > 0 ? paths : ["."], extensions);
  const cwd = process.cwd();
  const files: SourceFileEntry[] = await Promise.all(
    filePaths.map(async (abs) => ({
      path: relative(cwd, abs).replace(/\\/g, "/"),
      content: await readFile(abs, "utf8"),
    })),
  );

  const result: SourceUploadResult = { release, environment, files: files.map((f) => f.path), stored: 0 };
  if (dryRun || files.length === 0) return result;

  const endpoint = `${url.replace(/\/$/, "")}/source-files`;
  for (const group of batch(files)) {
    const idempotencyKey = artifactIdempotencyKey("source-files", environment, release, group);
    const res = await postJsonWithRetry(
      endpoint,
      {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      JSON.stringify({ environment, release, files: group }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upload failed (${res.status} ${res.statusText}): ${text.slice(0, 300)}`);
    }
    const body: unknown = await res.json().catch(() => null);
    const stored =
      typeof body === "object" && body !== null && typeof (body as { stored?: unknown }).stored === "number"
        ? (body as { stored: number }).stored
        : group.length;
    result.stored += stored;
  }

  return result;
}
