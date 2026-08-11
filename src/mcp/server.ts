/**
 * `octri mcp serve` — exposes the CLI's whole surface to an AI agent over MCP.
 *
 * Purpose: an agent working on the SDK generator can drive the dashboard through
 * typed tool calls — trigger a build, wait for it, read the emitted files, diff
 * two runs — instead of clicking through the web UI, which costs an order of
 * magnitude more tokens per step and cannot be replayed.
 *
 * Safety posture: reads are unrestricted, mutations are grouped, and the two
 * genuinely destructive things (publishing to public registries, deleting specs)
 * are refused unless the operator started the server with `--allow-publish` /
 * `--allow-delete`. Credentials come from the stored profile; the agent never
 * sees them.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import * as api from "../api.js";
import { extract } from "../archive.js";
import { OctriClient } from "../client.js";
import { cacheDir, resolve, type Resolved } from "../config.js";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ServeOptions {
  profile?: string;
  apiUrl?: string;
  project?: string;
  allowPublish: boolean;
  allowDelete: boolean;
}

interface ToolContext {
  client: OctriClient;
  settings: Resolved;
  options: ServeOptions;
}

// ─── Schema helpers ───────────────────────────────────────────────────────────

const projectProperty = {
  project_id: {
    type: "string",
    description:
      "Project id. Optional — falls back to the CLI's selected project.",
  },
} as const;

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Tool["inputSchema"] {
  return {
    type: "object",
    properties: { ...projectProperty, ...properties },
    required,
  } as Tool["inputSchema"];
}

// ─── Tool catalogue ───────────────────────────────────────────────────────────

function tools(options: ServeOptions): Tool[] {
  const list: Tool[] = [
    {
      name: "octri_whoami",
      description:
        "The signed-in user, org, plan, API URL and currently selected project. Call this first to confirm which environment the session is pointed at.",
      inputSchema: schema({}),
    },
    {
      name: "octri_list_projects",
      description: "All projects in the organisation, with ids.",
      inputSchema: schema({}),
    },
    {
      name: "octri_list_specs",
      description: "OpenAPI specs uploaded to a project, newest first.",
      inputSchema: schema({}),
    },
    {
      name: "octri_push_spec",
      description:
        "Upload OpenAPI spec text (JSON or YAML) as the project's new current spec. Returns the created spec id.",
      inputSchema: schema(
        {
          content: { type: "string", description: "Raw spec text." },
        },
        ["content"],
      ),
    },
    {
      name: "octri_import_spec_url",
      description: "Import an OpenAPI spec from a public URL.",
      inputSchema: schema({ url: { type: "string" } }, ["url"]),
    },
    {
      name: "octri_list_languages",
      description:
        "The SDK generator's language catalogue and the preference keys each language accepts.",
      inputSchema: schema({}),
    },
    {
      name: "octri_list_operations",
      description:
        "Every operation the parser found in the current spec, with method, path, operationId and deprecation — the list the SDK Studio renders.",
      inputSchema: schema({}),
    },
    {
      name: "octri_get_sdk_settings",
      description:
        "The project's persisted SDK Studio settings, per-endpoint overrides, revision, and last published release. The revision is required to write settings back.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_sdk_settings",
      description:
        "Write SDK Studio settings. Pass a full settings object (read it first with octri_get_sdk_settings and modify), plus the revision you read. A stale revision is rejected.",
      inputSchema: schema(
        {
          settings: {
            type: "object",
            description: "Complete sdkSettings object — replaces the stored one.",
          },
          revision: {
            type: "number",
            description: "Revision from octri_get_sdk_settings.",
          },
          version: { type: "string", description: "Optional release version." },
          changelog: { type: "string" },
        },
        ["settings", "revision"],
      ),
    },
    {
      name: "octri_validate_spec",
      description:
        "Run the generator's validator against the project's current spec. Cheap; do this before spending a build.",
      inputSchema: schema({}),
    },
    {
      name: "octri_preview_sdk",
      description:
        "Generate one language WITHOUT spending a build, and return the emitted file paths (and optionally contents). This is the fast loop for generator changes.",
      inputSchema: schema(
        {
          language: { type: "string", description: "Language id, e.g. `go`." },
          include_content: {
            type: "boolean",
            description:
              "Include file contents. Defaults to false — paths only, to keep the response small.",
          },
          path_filter: {
            type: "string",
            description: "Only return files whose path contains this substring.",
          },
        },
        ["language"],
      ),
    },
    {
      name: "octri_trigger_build",
      description:
        "Queue an SDK build for one or more languages. Returns a build id immediately; poll with octri_get_build or block with octri_wait_for_build.",
      inputSchema: schema(
        {
          languages: {
            type: "array",
            items: { type: "string" },
            description: "Language ids, e.g. [\"go\",\"rust\"].",
          },
          version: { type: "string" },
        },
        ["languages"],
      ),
    },
    {
      name: "octri_list_builds",
      description: "Recent SDK builds with per-language status.",
      inputSchema: schema({ page: { type: "number" } }),
    },
    {
      name: "octri_get_build",
      description:
        "One build's current state, including each language's lifecycle phase and any failure message.",
      inputSchema: schema({ build_id: { type: "string" } }, ["build_id"]),
    },
    {
      name: "octri_wait_for_build",
      description:
        "Block until every language of a build reaches a terminal state, then return the final per-language result. Use after octri_trigger_build.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          timeout_seconds: {
            type: "number",
            description: "Defaults to 1800 (30 minutes).",
          },
        },
        ["build_id"],
      ),
    },
    {
      name: "octri_retry_build",
      description:
        "Re-run only the named languages of an existing build, in place. Omit `languages` to retry exactly the ones that failed.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          languages: { type: "array", items: { type: "string" } },
        },
        ["build_id"],
      ),
    },
    {
      name: "octri_fetch_artifacts",
      description:
        "Download and extract a build's artifacts into the local cache so their files can be listed and read. Returns per-language file counts and a content fingerprint.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          languages: { type: "array", items: { type: "string" } },
        },
        ["build_id"],
      ),
    },
    {
      name: "octri_list_generated_files",
      description:
        "List the files of a previously fetched build+language, with sizes. Call octri_fetch_artifacts first.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          language: { type: "string" },
        },
        ["build_id", "language"],
      ),
    },
    {
      name: "octri_read_generated_file",
      description:
        "Read one generated file from a fetched build. This is how to inspect what the generator actually emitted.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          language: { type: "string" },
          path: {
            type: "string",
            description: "Path within the language's output tree.",
          },
          max_bytes: { type: "number", description: "Defaults to 200000." },
        },
        ["build_id", "language", "path"],
      ),
    },
    {
      name: "octri_diff_builds",
      description:
        "Compare two fetched builds file-by-file per language: which emitted files were added, removed or changed. The primary way to judge a generator change.",
      inputSchema: schema(
        {
          from_build_id: { type: "string" },
          to_build_id: { type: "string" },
          language: { type: "string" },
        },
        ["from_build_id", "to_build_id"],
      ),
    },
    {
      name: "octri_list_doc_pages",
      description: "Documentation pages generated for the project.",
      inputSchema: schema({}),
    },
    {
      name: "octri_get_doc_page",
      description: "One documentation page by slug.",
      inputSchema: schema({ slug: { type: "string" } }, ["slug"]),
    },
    {
      name: "octri_list_mcp_tools",
      description:
        "The MCP tool catalogue this project publishes to its own customers, derived from its SDK config.",
      inputSchema: schema({}),
    },
    {
      name: "octri_list_sdk_repos",
      description: "Per-language GitHub repositories linked to the project's SDKs.",
      inputSchema: schema({}),
    },
  ];

  if (options.allowPublish) {
    list.push({
      name: "octri_publish_build",
      description:
        "Publish a ready build's artifacts to package registries. Irreversible for public registries — prefer mode `pack` unless a release was explicitly requested.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          languages: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["pack", "release"] },
        },
        ["build_id"],
      ),
    });
  }

  if (options.allowDelete) {
    list.push({
      name: "octri_delete_spec",
      description: "Permanently delete a spec from a project.",
      inputSchema: schema({ spec_id: { type: "string" } }, ["spec_id"]),
    });
  }

  return list;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

function projectOf(ctx: ToolContext, args: Args): string {
  const explicit = args["project_id"];
  return ctx.client.requireProject(
    typeof explicit === "string" ? explicit : undefined,
  );
}

function stringArg(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`\`${key}\` is required.`);
  }
  return value;
}

function stringList(args: Args, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

async function dispatch(
  ctx: ToolContext,
  name: string,
  args: Args,
): Promise<unknown> {
  const { client } = ctx;

  switch (name) {
    case "octri_whoami": {
      const identity = await api.me(client);
      return {
        ...identity,
        apiUrl: ctx.settings.apiUrl,
        profile: ctx.settings.profile,
        selectedProject: ctx.settings.defaultProject ?? null,
        capabilities: {
          publish: ctx.options.allowPublish,
          delete: ctx.options.allowDelete,
        },
      };
    }

    case "octri_list_projects":
      return { projects: await api.listProjects(client) };

    case "octri_list_specs":
      return { specs: await api.listSpecs(client, projectOf(ctx, args)) };

    case "octri_push_spec":
      return api.uploadSpecContent(
        client,
        projectOf(ctx, args),
        stringArg(args, "content"),
      );

    case "octri_import_spec_url":
      return api.importSpecUrl(
        client,
        projectOf(ctx, args),
        stringArg(args, "url"),
      );

    case "octri_list_languages":
      return { languages: await api.listLanguages(client) };

    case "octri_list_operations": {
      const operations = await api.listOperations(client, projectOf(ctx, args));
      // Trimmed to the fields an agent reasons about; the full objects are large.
      return {
        count: operations.length,
        operations: operations.map((op) => ({
          method: op.method,
          path: op.path,
          operationId: op.operationId,
          summary: op.summary,
          deprecated: op.deprecated,
        })),
      };
    }

    case "octri_get_sdk_settings":
      return api.getSdkSettings(client, projectOf(ctx, args));

    case "octri_set_sdk_settings": {
      const settings = args["settings"];
      const revision = args["revision"];
      if (typeof settings !== "object" || settings === null) {
        throw new Error("`settings` must be an object.");
      }
      if (typeof revision !== "number") {
        throw new Error("`revision` must be the number read from octri_get_sdk_settings.");
      }
      const projectId = projectOf(ctx, args);
      const current = await api.getSdkSettings(client, projectId);
      await api.putSdkSettings(client, projectId, {
        settings: settings as Record<string, unknown>,
        endpoints: current.sdkEndpoints,
        revision,
        ...(typeof args["version"] === "string" ? { version: args["version"] } : {}),
        ...(typeof args["changelog"] === "string"
          ? { changelog: args["changelog"] }
          : {}),
      });
      return { ok: true, revision: revision + 1 };
    }

    case "octri_validate_spec":
      return api.validateSpec(client, projectOf(ctx, args));

    case "octri_preview_sdk": {
      const files = await api.previewSdk(
        client,
        projectOf(ctx, args),
        stringArg(args, "language"),
      );
      const filter = args["path_filter"];
      const selected =
        typeof filter === "string"
          ? files.filter((f) => f.path.includes(filter))
          : files;
      const includeContent = args["include_content"] === true;
      return {
        count: selected.length,
        files: selected.map((f) => ({
          path: f.path,
          bytes: f.content.length,
          ...(includeContent ? { content: f.content } : {}),
        })),
      };
    }

    case "octri_trigger_build": {
      const languages = stringList(args, "languages");
      if (languages.length === 0) throw new Error("`languages` must be a non-empty array.");
      return api.triggerBuild(client, projectOf(ctx, args), {
        languages,
        ...(typeof args["version"] === "string" ? { version: args["version"] } : {}),
      });
    }

    case "octri_list_builds": {
      const page = typeof args["page"] === "number" ? args["page"] : 1;
      return api.listBuilds(client, projectOf(ctx, args), page);
    }

    case "octri_get_build": {
      const build = await api.findBuild(
        client,
        projectOf(ctx, args),
        stringArg(args, "build_id"),
      );
      if (build === undefined) throw new Error("Build not found on this project.");
      return build;
    }

    case "octri_wait_for_build": {
      const timeout =
        typeof args["timeout_seconds"] === "number"
          ? args["timeout_seconds"] * 1_000
          : 30 * 60_000;
      return api.watchBuild(
        client,
        projectOf(ctx, args),
        stringArg(args, "build_id"),
        { timeoutMs: timeout, intervalMs: 3_000 },
      );
    }

    case "octri_retry_build": {
      const projectId = projectOf(ctx, args);
      const buildId = stringArg(args, "build_id");
      let languages = stringList(args, "languages");
      if (languages.length === 0) {
        const build = await api.findBuild(client, projectId, buildId);
        languages =
          build?.artifacts
            .filter((a) => a.status === "failed")
            .map((a) => a.languageId) ?? [];
        if (languages.length === 0) {
          throw new Error("Nothing failed on that build; pass `languages` explicitly.");
        }
      }
      await api.retryBuild(client, projectId, buildId, languages);
      return { ok: true, buildId, languages };
    }

    case "octri_fetch_artifacts":
      return fetchArtifacts(
        ctx,
        projectOf(ctx, args),
        stringArg(args, "build_id"),
        stringList(args, "languages"),
      );

    case "octri_list_generated_files": {
      const root = languageDir(
        projectOf(ctx, args),
        stringArg(args, "build_id"),
        stringArg(args, "language"),
      );
      if (!existsSync(root)) {
        throw new Error(
          "Not fetched yet — call octri_fetch_artifacts for this build first.",
        );
      }
      const files = walk(root).map((path) => ({
        path: relative(root, path).split(sep).join("/"),
        bytes: statSync(path).size,
      }));
      return { count: files.length, files };
    }

    case "octri_read_generated_file": {
      const root = languageDir(
        projectOf(ctx, args),
        stringArg(args, "build_id"),
        stringArg(args, "language"),
      );
      const wanted = stringArg(args, "path");
      const match = walk(root).find((path) => {
        const rel = relative(root, path).split(sep).join("/");
        return rel === wanted || rel.endsWith(`/${wanted}`);
      });
      if (match === undefined) throw new Error(`No generated file at "${wanted}".`);

      const limit =
        typeof args["max_bytes"] === "number" ? args["max_bytes"] : 200_000;
      const content = readFileSync(match, "utf8");
      return {
        path: relative(root, match).split(sep).join("/"),
        bytes: content.length,
        truncated: content.length > limit,
        content: content.slice(0, limit),
      };
    }

    case "octri_diff_builds":
      return diffBuilds(
        projectOf(ctx, args),
        stringArg(args, "from_build_id"),
        stringArg(args, "to_build_id"),
        typeof args["language"] === "string" ? args["language"] : undefined,
      );

    case "octri_list_doc_pages":
      return { pages: await api.listDocPages(client, projectOf(ctx, args)) };

    case "octri_get_doc_page":
      return api.getDocPage(
        client,
        projectOf(ctx, args),
        stringArg(args, "slug"),
      );

    case "octri_list_mcp_tools":
      return { tools: await api.listMcpTools(client, projectOf(ctx, args)) };

    case "octri_list_sdk_repos":
      return { repos: await api.listRepos(client, projectOf(ctx, args)) };

    case "octri_publish_build": {
      if (!ctx.options.allowPublish) {
        throw new Error("Publishing is disabled. Restart with --allow-publish.");
      }
      const mode = args["mode"] === "release" ? "release" : "pack";
      const languages = stringList(args, "languages");
      return api.publishBuild(
        client,
        projectOf(ctx, args),
        stringArg(args, "build_id"),
        { mode, ...(languages.length > 0 ? { languages } : {}) },
      );
    }

    case "octri_delete_spec": {
      if (!ctx.options.allowDelete) {
        throw new Error("Deletion is disabled. Restart with --allow-delete.");
      }
      await api.deleteSpec(
        client,
        projectOf(ctx, args),
        stringArg(args, "spec_id"),
      );
      return { ok: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Local artifact cache (shared with `octri lab`) ───────────────────────────

function runDir(projectId: string, buildId: string): string {
  return join(cacheDir(), "lab", projectId, buildId);
}

function languageDir(
  projectId: string,
  buildId: string,
  language: string,
): string {
  return join(runDir(projectId, buildId), language);
}

async function fetchArtifacts(
  ctx: ToolContext,
  projectId: string,
  buildId: string,
  languages: readonly string[],
): Promise<unknown> {
  const artifacts = await api.listArtifacts(ctx.client, projectId, buildId);
  const wanted =
    languages.length === 0
      ? artifacts
      : artifacts.filter((a) => languages.includes(a.language));

  const destination = runDir(projectId, buildId);
  mkdirSync(destination, { recursive: true });
  const results: unknown[] = [];

  for (const artifact of wanted) {
    if (artifact.url === undefined) {
      results.push({
        language: artifact.language,
        ok: false,
        reason: "no download URL (build may still be running)",
      });
      continue;
    }
    const response = await ctx.client.fetchRaw(artifact.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const target = join(destination, artifact.language);

    try {
      const files = extract(buffer, target, artifact.url);
      const hash = createHash("sha256");
      for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
        hash.update(file.path).update("\0");
        hash.update(readFileSync(join(target, file.path)));
      }
      results.push({
        language: artifact.language,
        ok: true,
        files: files.length,
        bytes: files.reduce((sum, f) => sum + f.size, 0),
        fingerprint: hash.digest("hex").slice(0, 16),
        path: target,
      });
    } catch (err) {
      const archivePath = join(destination, `${artifact.language}.archive`);
      writeFileSync(archivePath, buffer);
      results.push({
        language: artifact.language,
        ok: false,
        reason: (err as Error).message,
        archive: archivePath,
      });
    }
  }

  return { buildId, root: destination, artifacts: results };
}

function diffBuilds(
  projectId: string,
  fromBuildId: string,
  toBuildId: string,
  language?: string,
): unknown {
  const languagesOf = (buildId: string): string[] => {
    const root = runDir(projectId, buildId);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  };

  const languages = [
    ...new Set([...languagesOf(fromBuildId), ...languagesOf(toBuildId)]),
  ].filter((lang) => language === undefined || lang === language);

  if (languages.length === 0) {
    throw new Error(
      "Neither build is fetched locally. Call octri_fetch_artifacts on both first.",
    );
  }

  return {
    from: fromBuildId,
    to: toBuildId,
    languages: languages.map((lang) => {
      const a = hashMap(languageDir(projectId, fromBuildId, lang));
      const b = hashMap(languageDir(projectId, toBuildId, lang));
      const added = [...b.keys()].filter((p) => !a.has(p)).sort();
      const removed = [...a.keys()].filter((p) => !b.has(p)).sort();
      const changed = [...b.keys()]
        .filter((p) => a.has(p) && a.get(p) !== b.get(p))
        .sort();
      return {
        language: lang,
        identical: added.length + removed.length + changed.length === 0,
        added,
        removed,
        changed,
        unchanged: b.size - added.length - changed.length,
      };
    }),
  };
}

function hashMap(root: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(root)) return map;
  for (const path of walk(root)) {
    map.set(
      relative(root, path).split(sep).join("/"),
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    );
  }
  return map;
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function serve(options: ServeOptions): Promise<void> {
  const settings = resolve({
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.project === undefined ? {} : { project: options.project }),
  });

  const ctx: ToolContext = {
    settings,
    client: new OctriClient(settings),
    options,
  };

  const server = new Server(
    { name: "octri-cli", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools(options),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Args;
    try {
      const result = await dispatch(ctx, request.params.name, args);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      // Errors come back as tool results, not protocol errors, so the agent can
      // read the message and correct itself instead of losing the turn.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `${(err as Error).name}: ${(err as Error).message}`,
          },
        ],
      };
    }
  });

  // stdio only: stdout is the protocol channel, so nothing else may write there.
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `octri mcp: serving ${tools(options).length} tools against ${settings.apiUrl}\n`,
  );
}
