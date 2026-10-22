/**
 * `octri mcp serve`: exposes the CLI's whole surface to an AI agent over MCP.
 *
 * Purpose: an agent working on the SDK generator can drive the dashboard through
 * typed tool calls: trigger a build, wait for it, read the emitted files, diff
 * two runs, instead of clicking through the web UI, which costs an order of
 * magnitude more tokens per step and cannot be replayed.
 *
 * Safety posture: reads are unrestricted, mutations are grouped, and the
 * genuinely destructive things (publishing SDKs or the project's MCP package to
 * public registries, or a drafted docs IA to readers; deleting specs, components
 * or webhooks) are refused unless
 * the operator started the server with `--allow-publish` / `--allow-delete`.
 * Credentials come from the stored profile; the agent never sees them.
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
import { join, relative, resolve as resolvePath, sep } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import * as api from "../api.js";
import { extract, safeArtifactFilename } from "../archive.js";
import { OctriClient } from "../client.js";
import { cacheDir, resolve, type Resolved } from "../config.js";
import { CLI_VERSION } from "../version.js";

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
      "Project id. Optional, falls back to the CLI's selected project.",
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
        "Every operation the parser found in the current spec, with method, path, operationId and deprecation, the list the SDK Studio renders.",
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
            description:
              "Complete sdkSettings object. Replaces the stored one.",
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
              "Include file contents. Defaults to false (paths only) to keep the response small.",
          },
          path_filter: {
            type: "string",
            description:
              "Only return files whose path contains this substring.",
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
            description: 'Language ids, e.g. ["go","rust"].',
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
      description:
        "Per-language GitHub repositories linked to the project's SDKs.",
      inputSchema: schema({}),
    },
    {
      name: "octri_monitoring_summary",
      description:
        "Production health for the project: event count, error count, error rate and distinct issues over a window. Call this before reading issues. It tells you whether there is anything to look at.",
      inputSchema: schema({
        range: {
          type: "string",
          enum: ["1h", "6h", "24h", "7d", "30d", "90d"],
          description: "Time window. Defaults to 24h.",
        },
      }),
    },
    {
      name: "octri_list_issues",
      description:
        "Grouped production errors, newest first. Each issue has an id usable with octri_get_issue.",
      inputSchema: schema({
        range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d", "90d"] },
        status: { type: "string", enum: ["unresolved", "resolved", "ignored"] },
        level: { type: "string", enum: ["debug", "info", "warning", "error", "fatal"] },
        limit: { type: "number" },
      }),
    },
    {
      name: "octri_get_issue",
      description:
        "One issue with its stack frames and recent events. A frame with resolved=true was de-minified against an uploaded source map; if none are, the symbols for that release were never uploaded.",
      inputSchema: schema({ issue_id: { type: "string" } }, ["issue_id"]),
    },
    {
      name: "octri_set_issue_status",
      description:
        "Triage an issue: resolve it, ignore it, or reopen it (status `unresolved`).",
      inputSchema: schema(
        {
          issue_id: { type: "string" },
          status: {
            type: "string",
            enum: ["unresolved", "resolved", "ignored"],
          },
        },
        ["issue_id", "status"],
      ),
    },
    {
      name: "octri_query_logs",
      description:
        "Raw production events, unaggregated. Use when an issue's grouped view is not enough, e.g. to see every occurrence across releases.",
      inputSchema: schema({
        range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d", "90d"] },
        level: { type: "string" },
        query: { type: "string", description: "Free-text match on the message." },
        limit: { type: "number" },
      }),
    },
    {
      name: "octri_monitoring_releases",
      description:
        "Error rate, new issues and regressions per release. This is how you tell whether a deploy made things worse.",
      inputSchema: schema({
        range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d", "90d"] },
      }),
    },
    {
      name: "octri_monitoring_performance",
      description:
        "Slowest transactions (p50/p95) and suspected N+1 query patterns for the project.",
      inputSchema: schema({
        range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d", "90d"] },
      }),
    },

    // ── The project's own MCP server ─────────────────────────────────────────
    {
      name: "octri_get_mcp_permissions",
      description:
        "Every operation tool of the project's own MCP server, `off` ones included, with its policy (auto runs unasked, confirm asks the person first, off is not offered) and whether it is destructive. Absent policy means the method's default: auto for GET, confirm otherwise.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_mcp_permission",
      description:
        "Change one tool's permission and publish it to agents immediately. Takes the tool name or endpoint slug from octri_get_mcp_permissions. Fails with a conflict if a teammate published in between: read again and retry.",
      inputSchema: schema(
        {
          tool: { type: "string", description: "Tool name or endpoint slug." },
          policy: { type: "string", enum: ["auto", "confirm", "off"] },
          destructive: {
            type: "boolean",
            description: "Whether a call can destroy or overwrite data.",
          },
        },
        ["tool"],
      ),
    },
    {
      name: "octri_mcp_usage",
      description:
        "How agents used the project's MCP tools: calls per tool split into ok, errors, declined and blocked, with the clients seen.",
      inputSchema: schema({
        days: { type: "number", description: "Window in days. Defaults to 30." },
      }),
    },
    {
      name: "octri_list_mcp_calls",
      description: "The latest individual tool calls agents made, newest first.",
      inputSchema: schema({}),
    },
    {
      name: "octri_get_mcp_package",
      description:
        "The npm package that ships the project's MCP server under the customer's name: package and command names, the version a publish would use, whether an npm account is linked, and past releases.",
      inputSchema: schema({}),
    },

    // ── Docs IA: redirects, home page, nav buttons ───────────────────────────
    {
      name: "octri_list_redirects",
      description:
        "Docs redirect rules. `redirects` is the working copy (the draft when `pending`), `published` is what readers get. Drafts go live with the docs nav publish.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_redirects",
      description:
        "Replace the drafted redirect list, in order. Read it with octri_list_redirects first and send the whole edited list. A `from` may end in /*, and then its `to` must too. Readers see it after the docs nav is published.",
      inputSchema: schema(
        {
          redirects: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                force: { type: "boolean" },
              },
              required: ["from", "to"],
            },
          },
        },
        ["redirects"],
      ),
    },
    {
      name: "octri_get_docs_home",
      description:
        "Which guide the docs site serves at /, and whether its sidebar is hidden. Drafted like redirects.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_docs_home",
      description:
        "Draft the docs home page: a guide id, or null for no home page. Readers see it after the docs nav is published.",
      inputSchema: schema(
        {
          guide_id: { type: ["string", "null"] },
          hide_sidebar: { type: "boolean" },
        },
        ["guide_id"],
      ),
    },
    {
      name: "octri_set_nav_buttons",
      description:
        "Replace the docs top nav's call-to-action buttons (at most 3). Unlike the rest of the IA they have no draft: they go live on save. A url is http(s), mailto:, or a path starting with /.",
      inputSchema: schema(
        {
          buttons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                url: { type: "string" },
                style: { type: "string", enum: ["plain", "outline", "primary"] },
              },
              required: ["label", "url"],
            },
          },
        },
        ["buttons"],
      ),
    },
    {
      name: "octri_get_docs_nav",
      description:
        "The docs sidebar: tabs, each with its folders (`sections`) and their rows (`items`). The draft when `hasDraft`, otherwise what readers get. Edit this and send it back with octri_set_docs_nav.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_docs_nav",
      description:
        "Draft the whole docs sidebar: every tab, in order, as octri_get_docs_nav returns them. A tab is { label, slug, kind, url, hidden, icon, sections }; a folder is { title, items, subsections, ... }; a row is { type: endpoint|guide|page|link, ref, label, hidden, path }. Nav buttons are not touched. Readers see it after the docs nav is published.",
      inputSchema: schema(
        {
          tabs: { type: "array", items: { type: "object" } },
        },
        ["tabs"],
      ),
    },
    {
      name: "octri_get_docs_settings",
      description:
        "The docs site's appearance (`theme`), `seo`, `socials` links and whether the page feedback widget is on (`feedbackEnabled`).",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_docs_settings",
      description:
        "Change docs settings. No draft: live on the docs site on save. Each of theme, seo and socials is a partial object with the keys octri_get_docs_settings shows (e.g. theme { primaryColor: \"#ff6a00\", colorScheme: \"dark\", codeTheme: \"nord\" }); keys left out are unchanged. A socials platform set to \"\" is removed, and socials.custom replaces the whole list of { label, url, icon }. Returns the saved settings and any theme or seo keys the API ignored as unknown.",
      inputSchema: schema({
        theme: { type: "object" },
        seo: { type: "object" },
        socials: { type: "object" },
        feedback_enabled: { type: "boolean" },
      }),
    },
    {
      name: "octri_get_playground",
      description:
        "The docs API playground: on/off, base URL and default auth overrides (\"\" and type \"inherit\" defer to the project's API config), CORS origins, timeout. `effective` is what a request will use.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_playground",
      description:
        "Change the docs API playground. No draft: live on save. Only the fields sent change; default_auth may be partial and is merged onto the saved one.",
      inputSchema: schema({
        enabled: { type: "boolean" },
        base_url: { type: "string", description: "\"\" inherits the project's API base URL." },
        default_auth: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["inherit", "none", "apiKey", "basic", "bearer", "oauth2"],
            },
            header_name: { type: "string" },
          },
        },
        allowed_origins: { type: "array", items: { type: "string" } },
        request_timeout_ms: { type: "number", description: "1000 to 60000." },
      }),
    },
    {
      name: "octri_get_custom_code",
      description:
        "The docs site's custom CSS, <head> HTML and end-of-<body> HTML, and whether they are injected (`enabled`).",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_custom_code",
      description:
        "Change the docs site's custom code. Growth plan and above. No draft: live on save once enabled. Only the fields sent change.",
      inputSchema: schema({
        enabled: { type: "boolean" },
        css: { type: "string" },
        head_html: { type: "string" },
        body_end_html: { type: "string" },
      }),
    },

    // ── Docs: custom components ──────────────────────────────────────────────
    {
      name: "octri_list_components",
      description: "The project's custom docs components, with ids, props and source type.",
      inputSchema: schema({}),
    },
    {
      name: "octri_get_component",
      description: "One custom component with its source (MDX, or the stored tree of a visual one).",
      inputSchema: schema({ component: { type: "string", description: "Name or id." } }, ["component"]),
    },
    {
      name: "octri_save_component",
      description:
        "Create or update a custom component by name. A visual component's `source` is its markup alone: one root element, HTML attribute names (class, not className), props as {name}, no imports, exports or function. Set source_type `mdx` for an MDX one. Returns compiler warnings.",
      inputSchema: schema(
        {
          name: { type: "string", description: "PascalCase, e.g. Banner." },
          source: { type: "string" },
          source_type: { type: "string", enum: ["visual", "mdx"] },
          description: { type: "string" },
          custom_css: { type: "string" },
          props: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: {
                  type: "string",
                  enum: ["string", "number", "boolean", "color", "node", "select"],
                },
                defaultValue: { type: "string" },
                description: { type: "string" },
                options: { type: "array", items: { type: "string" } },
              },
              required: ["name", "type"],
            },
          },
        },
        ["name", "source"],
      ),
    },

    // ── Draft endpoints ──────────────────────────────────────────────────────
    {
      name: "octri_list_draft_endpoints",
      description:
        "Endpoints added, or marked for removal, that the next publish will write into the spec.",
      inputSchema: schema({}),
    },
    {
      name: "octri_add_draft_endpoint",
      description:
        "Draft a new endpoint. Nothing reaches the spec, docs, SDKs or MCP until octri_publish_draft_endpoints.",
      inputSchema: schema(
        {
          method: { type: "string", description: "HTTP method, e.g. GET." },
          path: { type: "string", description: "OpenAPI path, e.g. /users/{id}." },
          summary: { type: "string" },
          description: { type: "string" },
        },
        ["method", "path", "summary"],
      ),
    },
    {
      name: "octri_mark_endpoint_deletion",
      description: "Mark an endpoint the spec has for removal on the next publish.",
      inputSchema: schema(
        { method: { type: "string" }, path: { type: "string" } },
        ["method", "path"],
      ),
    },
    {
      name: "octri_update_draft_endpoint",
      description: "Change a draft's summary or description. The method and path are fixed.",
      inputSchema: schema(
        {
          draft_id: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
        },
        ["draft_id"],
      ),
    },
    {
      name: "octri_discard_draft_endpoint",
      description: "Drop a draft without publishing it.",
      inputSchema: schema({ draft_id: { type: "string" } }, ["draft_id"]),
    },
    {
      name: "octri_publish_draft_endpoints",
      description:
        "Write every draft into the spec as a new version, which then regenerates docs, SDKs and MCP. `commit_to_github` overrides the docs setting for this publish.",
      inputSchema: schema({ commit_to_github: { type: "boolean" } }),
    },

    // ── Webhooks ─────────────────────────────────────────────────────────────
    {
      name: "octri_list_webhooks",
      description:
        "Project webhooks with their events, state and a redacted URL. octri_list_webhook_events lists the events.",
      inputSchema: schema({}),
    },
    {
      name: "octri_list_webhook_events",
      description: "Every event a webhook can subscribe to.",
      inputSchema: schema({}),
    },
    {
      name: "octri_create_webhook",
      description:
        "Create a webhook. The URL must be HTTPS. The response carries the signing secret, which is never returned again: hand it to the person.",
      inputSchema: schema(
        {
          url: { type: "string" },
          events: { type: "array", items: { type: "string" } },
          type: { type: "string", enum: ["slack", "discord", "generic"] },
          label: { type: "string" },
        },
        ["url", "events", "label"],
      ),
    },
    {
      name: "octri_update_webhook",
      description: "Change a webhook's URL, events, label, or enable/disable it.",
      inputSchema: schema(
        {
          webhook_id: { type: "string" },
          url: { type: "string" },
          events: { type: "array", items: { type: "string" } },
          label: { type: "string" },
          enabled: { type: "boolean" },
        },
        ["webhook_id"],
      ),
    },
    {
      name: "octri_test_webhook",
      description: "Queue a test.ping delivery. Its result appears in octri_list_webhook_deliveries.",
      inputSchema: schema({ webhook_id: { type: "string" } }, ["webhook_id"]),
    },
    {
      name: "octri_list_webhook_deliveries",
      description: "A webhook's delivery history, newest first, with HTTP codes and errors.",
      inputSchema: schema(
        {
          webhook_id: { type: "string" },
          status: { type: "string", enum: ["success", "failure"] },
          limit: { type: "number" },
        },
        ["webhook_id"],
      ),
    },

    // ── Spec source, converter, quickstart ───────────────────────────────────
    {
      name: "octri_get_spec_source",
      description:
        "The current spec's raw text, as the auditor scores it, with the audit findings the project ignores.",
      inputSchema: schema({
        max_bytes: { type: "number", description: "Truncate the spec text. Defaults to 200000." },
      }),
    },
    {
      name: "octri_get_converter_status",
      description:
        "Whether the current spec came from the spec converter, the formats it imports, and the report size limit.",
      inputSchema: schema({}),
    },
    {
      name: "octri_import_conversion",
      description:
        "Import a conversion report exported from the spec converter. The API re-runs the conversion and ingests the result as the new current spec, only while `expected_spec_id` is still current (defaults to the spec current now).",
      inputSchema: schema(
        {
          report_json: { type: "string", description: "The report file's text." },
          expected_spec_id: { type: "string" },
        },
        ["report_json"],
      ),
    },
    {
      name: "octri_get_quickstart",
      description:
        "Endpoints marked as the README quickstart, the headline example in every SDK's README. None means the generator picks one.",
      inputSchema: schema({}),
    },
    {
      name: "octri_set_quickstart",
      description:
        "Mark or unmark an endpoint as the README quickstart. Takes a slug, operationId, or `METHOD /path`. Publishes the SDK settings at the next revision.",
      inputSchema: schema(
        {
          endpoint: { type: "string" },
          on: { type: "boolean", description: "false unmarks. Defaults to true." },
        },
        ["endpoint"],
      ),
    },

    // ── GitHub docs ──────────────────────────────────────────────────────────
    {
      name: "octri_list_github_docs_files",
      description:
        "The connected repo's .mdx and .md files, and the docs sync setting (which folder, whether pushes rewrite page drafts).",
      inputSchema: schema({}),
    },
    {
      name: "octri_read_github_docs_files",
      description: "Read up to 50 docs files from the connected repo by path.",
      inputSchema: schema(
        { paths: { type: "array", items: { type: "string" } } },
        ["paths"],
      ),
    },
    {
      name: "octri_set_github_docs_sync",
      description:
        "Turn docs sync on push on or off. On, every push touching an .mdx/.md file under `folder` rewrites that page's draft; readers still see it only after Publish.",
      inputSchema: schema(
        {
          enabled: { type: "boolean" },
          folder: { type: "string", description: "e.g. docs/. Empty is the whole repo." },
        },
        ["enabled"],
      ),
    },
  ];

  if (options.allowPublish) {
    list.push({
      name: "octri_publish_build",
      description:
        "Publish a ready build's artifacts to package registries. Irreversible for public registries. Prefer mode `pack` unless a release was explicitly requested.",
      inputSchema: schema(
        {
          build_id: { type: "string" },
          languages: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["pack", "release"] },
        },
        ["build_id"],
      ),
    });
    list.push({
      name: "octri_publish_mcp_package",
      description:
        "Publish the project's MCP server to npm under the customer's package name, using the linked npm account. Irreversible. Omit `version` for the next patch.",
      inputSchema: schema({ version: { type: "string" } }),
    });
    list.push({
      name: "octri_publish_docs_nav",
      description:
        "Publish the drafted docs IA: the sidebar, home page and redirects go live for readers together.",
      inputSchema: schema({}),
    });
  }

  if (options.allowDelete) {
    list.push({
      name: "octri_delete_spec",
      description: "Permanently delete a spec from a project.",
      inputSchema: schema({ spec_id: { type: "string" } }, ["spec_id"]),
    });
    list.push({
      name: "octri_delete_component",
      description:
        "Permanently delete a custom docs component. Pages that use it stop rendering it.",
      inputSchema: schema({ component: { type: "string", description: "Name or id." } }, ["component"]),
    });
    list.push({
      name: "octri_delete_webhook",
      description: "Permanently delete a webhook and its delivery history.",
      inputSchema: schema({ webhook_id: { type: "string" } }, ["webhook_id"]),
    });
  }

  return list;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

function projectOf(ctx: ToolContext, args: Args): string {
  const explicit = args.project_id;
  return ctx.client.requireProject(
    typeof explicit === "string" ? explicit : undefined,
  );
}

function stringArg(args: Args, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`\`${key}\` is required.`);
  }
  return value;
}

function numberArg(args: Args, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Copies an optional string argument through only when the agent supplied one. */
function optionalString(args: Args, key: string): Record<string, string> {
  const value = args[key];
  return typeof value === "string" && value !== "" ? { [key]: value } : {};
}

function stringList(args: Args, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Copies an optional boolean argument through only when the agent supplied one. */
function optionalBoolean(args: Args, key: string): Record<string, boolean> {
  const value = args[key];
  return typeof value === "boolean" ? { [key]: value } : {};
}

/** An optional object argument, passed through for the API to validate. */
function objectArg(args: Args, key: string): Args | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`\`${key}\` must be an object.`);
  }
  return value as Args;
}

/** An array of objects; anything else in it is dropped. The API validates the fields. */
function objectList(args: Args, key: string): Args[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be an array.`);
  return value.filter(
    (item): item is Args => typeof item === "object" && item !== null && !Array.isArray(item),
  );
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

    case "octri_monitoring_summary":
      return api.monitoringSummary(
        client,
        projectOf(ctx, args),
        stringArg(args, "range", "24h"),
      );

    case "octri_list_issues":
      return api.monitoringIssues(client, projectOf(ctx, args), {
        range: stringArg(args, "range", "24h"),
        limit: numberArg(args, "limit", 25),
        ...optionalString(args, "status"),
        ...optionalString(args, "level"),
      });

    case "octri_get_issue":
      return api.monitoringIssue(
        client,
        projectOf(ctx, args),
        stringArg(args, "issue_id"),
      );

    case "octri_set_issue_status":
      return api.setIssueStatus(
        client,
        projectOf(ctx, args),
        stringArg(args, "issue_id"),
        stringArg(args, "status") as "unresolved" | "resolved" | "ignored",
      );

    case "octri_query_logs":
      return api.monitoringLogs(client, projectOf(ctx, args), {
        range: stringArg(args, "range", "24h"),
        limit: numberArg(args, "limit", 50),
        ...optionalString(args, "level"),
        ...optionalString(args, "query"),
      });

    case "octri_monitoring_releases":
      return {
        releases: await api.monitoringReleases(
          client,
          projectOf(ctx, args),
          stringArg(args, "range", "24h"),
        ),
      };

    case "octri_monitoring_performance":
      return api.monitoringPerformance(
        client,
        projectOf(ctx, args),
        stringArg(args, "range", "24h"),
      );

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
      const settings = args.settings;
      const revision = args.revision;
      if (typeof settings !== "object" || settings === null) {
        throw new Error("`settings` must be an object.");
      }
      if (typeof revision !== "number") {
        throw new Error(
          "`revision` must be the number read from octri_get_sdk_settings.",
        );
      }
      const projectId = projectOf(ctx, args);
      const current = await api.getSdkSettings(client, projectId);
      await api.putSdkSettings(client, projectId, {
        settings: settings as Record<string, unknown>,
        endpoints: current.sdkEndpoints,
        revision,
        ...(typeof args.version === "string" ? { version: args.version } : {}),
        ...(typeof args.changelog === "string"
          ? { changelog: args.changelog }
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
      const filter = args.path_filter;
      const selected =
        typeof filter === "string"
          ? files.filter((f) => f.path.includes(filter))
          : files;
      const includeContent = args.include_content === true;
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
      if (languages.length === 0)
        throw new Error("`languages` must be a non-empty array.");
      return api.triggerBuild(client, projectOf(ctx, args), {
        languages,
        ...(typeof args.version === "string" ? { version: args.version } : {}),
      });
    }

    case "octri_list_builds": {
      const page = typeof args.page === "number" ? args.page : 1;
      return api.listBuilds(client, projectOf(ctx, args), page);
    }

    case "octri_get_build": {
      const build = await api.findBuild(
        client,
        projectOf(ctx, args),
        stringArg(args, "build_id"),
      );
      if (build === undefined)
        throw new Error("Build not found on this project.");
      return build;
    }

    case "octri_wait_for_build": {
      const timeout =
        typeof args.timeout_seconds === "number"
          ? args.timeout_seconds * 1_000
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
          throw new Error(
            "Nothing failed on that build; pass `languages` explicitly.",
          );
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
          "Not fetched yet. Call octri_fetch_artifacts for this build first.",
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
      if (match === undefined)
        throw new Error(`No generated file at "${wanted}".`);

      const limit =
        typeof args.max_bytes === "number" ? args.max_bytes : 200_000;
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
        typeof args.language === "string" ? args.language : undefined,
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

    // ── The project's own MCP server ─────────────────────────────────────────

    case "octri_get_mcp_permissions":
      return api.getMcpOwnerTools(client, projectOf(ctx, args));

    case "octri_set_mcp_permission": {
      const policy = args.policy;
      if (policy !== undefined && policy !== "auto" && policy !== "confirm" && policy !== "off") {
        throw new Error("`policy` must be auto, confirm or off.");
      }
      if (policy === undefined && typeof args.destructive !== "boolean") {
        throw new Error("Pass `policy`, `destructive`, or both.");
      }
      const { tool, entry, policiesRevision } = await api.setMcpToolPolicy(
        client,
        projectOf(ctx, args),
        stringArg(args, "tool"),
        {
          ...(policy === undefined ? {} : { policy }),
          ...optionalBoolean(args, "destructive"),
        },
      );
      return { tool: tool.name, slug: tool.slug, ...entry, policiesRevision };
    }

    case "octri_mcp_usage":
      return api.getMcpUsage(client, projectOf(ctx, args), numberArg(args, "days", 30));

    case "octri_list_mcp_calls":
      return { calls: await api.listMcpCalls(client, projectOf(ctx, args)) };

    case "octri_get_mcp_package":
      return api.getMcpPackage(client, projectOf(ctx, args));

    // ── Docs IA ──────────────────────────────────────────────────────────────

    case "octri_list_redirects":
      return api.getRedirects(client, projectOf(ctx, args));

    case "octri_set_redirects":
      return api.putRedirects(
        client,
        projectOf(ctx, args),
        objectList(args, "redirects") as unknown as api.DocsRedirect[],
      );

    case "octri_get_docs_home":
      return api.getDocsHome(client, projectOf(ctx, args));

    case "octri_set_docs_home": {
      const guideId = args.guide_id;
      if (guideId !== null && (typeof guideId !== "string" || guideId === "")) {
        throw new Error("`guide_id` is a guide id, or null for no home page.");
      }
      return api.putDocsHome(
        client,
        projectOf(ctx, args),
        guideId,
        typeof args.hide_sidebar === "boolean" ? args.hide_sidebar : undefined,
      );
    }

    case "octri_set_nav_buttons":
      return {
        buttons: await api.putNavButtons(
          client,
          projectOf(ctx, args),
          objectList(args, "buttons").map((b) => ({
            label: String(b.label ?? ""),
            url: String(b.url ?? ""),
            style: (b.style ?? "plain") as api.NavButtonStyle,
          })),
        ),
      };

    case "octri_get_docs_nav":
      return api.getNav(client, projectOf(ctx, args));

    case "octri_set_docs_nav":
      return api.putNavTabs(client, projectOf(ctx, args), objectList(args, "tabs"));

    case "octri_get_docs_settings":
      return api.getDocsSettings(client, projectOf(ctx, args));

    case "octri_set_docs_settings": {
      const patch: api.DocsSettingsPatch = {};
      for (const section of ["theme", "seo", "socials"] as const) {
        const value = objectArg(args, section);
        if (value !== undefined) patch[section] = value;
      }
      if (typeof args.feedback_enabled === "boolean") patch.feedbackEnabled = args.feedback_enabled;
      if (Object.keys(patch).length === 0) {
        throw new Error("Send at least one of theme, seo, socials or feedback_enabled.");
      }
      const saved = await api.updateDocsSettings(client, projectOf(ctx, args), patch);
      // Theme and SEO keys the API does not know are dropped without an error.
      const ignored = (["theme", "seo"] as const).flatMap((section) =>
        Object.keys(patch[section] ?? {})
          .filter((key) => !(key in saved[section]))
          .map((key) => `${section}.${key}`),
      );
      return { ...saved, ...(ignored.length > 0 ? { ignored } : {}) };
    }

    case "octri_get_playground":
      return api.getPlayground(client, projectOf(ctx, args));

    case "octri_set_playground": {
      const projectId = projectOf(ctx, args);
      const auth = objectArg(args, "default_auth");
      const patch: Partial<api.PlaygroundSettings> = {
        ...optionalBoolean(args, "enabled"),
        ...(typeof args.base_url === "string" ? { baseUrl: args.base_url } : {}),
        ...(Array.isArray(args.allowed_origins)
          ? { allowedOrigins: stringList(args, "allowed_origins") }
          : {}),
        ...(typeof args.request_timeout_ms === "number"
          ? { requestTimeoutMs: args.request_timeout_ms }
          : {}),
      };
      if (auth !== undefined) {
        const current = await api.getPlayground(client, projectId);
        patch.defaultAuth = {
          type: typeof auth.type === "string" ? auth.type : current.playground.defaultAuth.type,
          headerName:
            typeof auth.header_name === "string"
              ? auth.header_name
              : current.playground.defaultAuth.headerName,
        };
      }
      return api.updatePlayground(client, projectId, patch);
    }

    case "octri_get_custom_code":
      return { customCode: await api.getCustomCode(client, projectOf(ctx, args)) };

    case "octri_set_custom_code":
      return {
        customCode: await api.updateCustomCode(client, projectOf(ctx, args), {
          ...optionalBoolean(args, "enabled"),
          ...(typeof args.css === "string" ? { css: args.css } : {}),
          ...(typeof args.head_html === "string" ? { headHtml: args.head_html } : {}),
          ...(typeof args.body_end_html === "string" ? { bodyEndHtml: args.body_end_html } : {}),
        }),
      };

    // ── Docs: custom components ──────────────────────────────────────────────

    case "octri_list_components":
      return { components: await api.listComponents(client, projectOf(ctx, args)) };

    case "octri_get_component": {
      const projectId = projectOf(ctx, args);
      const ref = stringArg(args, "component");
      const found = await api.findComponent(client, projectId, ref);
      if (found === undefined) throw new Error(`No component named "${ref}".`);
      return api.getComponent(client, projectId, found.id);
    }

    case "octri_save_component": {
      const mdx = args.source_type === "mdx";
      const source = stringArg(args, "source");
      const props = objectList(args, "props");
      return api.saveComponent(client, projectOf(ctx, args), stringArg(args, "name"), {
        sourceType: mdx ? "mdx" : "visual",
        ...(mdx ? { sourceMdx: source } : { sourceJsx: source }),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.custom_css === "string" ? { customCss: args.custom_css } : {}),
        ...(props.length > 0 ? { props: props as unknown as api.ComponentProp[] } : {}),
      });
    }

    // ── Draft endpoints ──────────────────────────────────────────────────────

    case "octri_list_draft_endpoints":
      return { drafts: await api.listDraftEndpoints(client, projectOf(ctx, args)) };

    case "octri_add_draft_endpoint":
      return api.createDraftEndpoint(client, projectOf(ctx, args), {
        method: stringArg(args, "method").toUpperCase(),
        path: stringArg(args, "path"),
        summary: stringArg(args, "summary"),
        ...optionalString(args, "description"),
      });

    case "octri_mark_endpoint_deletion":
      return api.markEndpointDeletion(client, projectOf(ctx, args), {
        method: stringArg(args, "method").toUpperCase(),
        path: stringArg(args, "path"),
      });

    case "octri_update_draft_endpoint":
      return api.updateDraftEndpoint(
        client,
        projectOf(ctx, args),
        stringArg(args, "draft_id"),
        { ...optionalString(args, "summary"), ...optionalString(args, "description") },
      );

    case "octri_discard_draft_endpoint":
      await api.discardDraftEndpoint(
        client,
        projectOf(ctx, args),
        stringArg(args, "draft_id"),
      );
      return { ok: true };

    case "octri_publish_draft_endpoints":
      return api.publishDraftEndpoints(
        client,
        projectOf(ctx, args),
        typeof args.commit_to_github === "boolean" ? args.commit_to_github : undefined,
      );

    // ── Webhooks ─────────────────────────────────────────────────────────────

    case "octri_list_webhooks":
      return { webhooks: await api.listWebhooks(client, projectOf(ctx, args)) };

    case "octri_list_webhook_events":
      return { events: await api.listWebhookEvents(client, projectOf(ctx, args)) };

    case "octri_create_webhook": {
      const type = stringArg(args, "type", "generic");
      if (type !== "slack" && type !== "discord" && type !== "generic") {
        throw new Error("`type` must be slack, discord or generic.");
      }
      return api.createWebhook(client, projectOf(ctx, args), {
        type,
        url: stringArg(args, "url"),
        events: stringList(args, "events"),
        label: stringArg(args, "label"),
      });
    }

    case "octri_update_webhook": {
      const events = stringList(args, "events");
      return api.updateWebhook(client, projectOf(ctx, args), stringArg(args, "webhook_id"), {
        ...optionalString(args, "url"),
        ...optionalString(args, "label"),
        ...(events.length > 0 ? { events } : {}),
        ...optionalBoolean(args, "enabled"),
      });
    }

    case "octri_test_webhook":
      return api.testWebhook(client, projectOf(ctx, args), stringArg(args, "webhook_id"));

    case "octri_list_webhook_deliveries": {
      const status = args.status;
      return api.listWebhookDeliveries(
        client,
        projectOf(ctx, args),
        stringArg(args, "webhook_id"),
        {
          limit: numberArg(args, "limit", 25),
          ...(status === "success" || status === "failure" ? { status } : {}),
        },
      );
    }

    // ── Spec source, converter, quickstart ───────────────────────────────────

    case "octri_get_spec_source": {
      const source = await api.getAuditSource(client, projectOf(ctx, args));
      const limit = numberArg(args, "max_bytes", 200_000);
      return {
        specId: source.specId,
        ignored: source.ignored,
        bytes: source.content.length,
        truncated: source.content.length > limit,
        content: source.content.slice(0, limit),
      };
    }

    case "octri_get_converter_status": {
      // The spec text belongs to octri_get_spec_source; this answers "was it converted".
      const { content, ...status } = await api.getConverterSource(client, projectOf(ctx, args));
      return { ...status, specBytes: content?.length ?? 0 };
    }

    case "octri_import_conversion": {
      const projectId = projectOf(ctx, args);
      const expected =
        typeof args.expected_spec_id === "string" && args.expected_spec_id !== ""
          ? args.expected_spec_id
          : (await api.getConverterSource(client, projectId)).specId;
      return api.importConversion(client, projectId, stringArg(args, "report_json"), expected);
    }

    case "octri_get_quickstart": {
      const bundle = await api.getSdkSettings(client, projectOf(ctx, args));
      return { quickstart: api.quickstartSlugs(bundle.sdkEndpoints) };
    }

    case "octri_set_quickstart":
      return api.setQuickstart(
        client,
        projectOf(ctx, args),
        stringArg(args, "endpoint"),
        args.on !== false,
      );

    // ── GitHub docs ──────────────────────────────────────────────────────────

    case "octri_list_github_docs_files": {
      const projectId = projectOf(ctx, args);
      const [status, listing] = await Promise.all([
        api.githubStatus(client, projectId),
        api.listGithubDocsFiles(client, projectId),
      ]);
      return { docsSync: status.docsSync ?? null, ...listing };
    }

    case "octri_read_github_docs_files":
      return api.readGithubDocsFiles(client, projectOf(ctx, args), stringList(args, "paths"));

    case "octri_set_github_docs_sync": {
      const projectId = projectOf(ctx, args);
      if (typeof args.enabled !== "boolean") throw new Error("`enabled` is required.");
      const folder =
        typeof args.folder === "string"
          ? args.folder
          : ((await api.githubStatus(client, projectId)).docsSync?.folder ?? "");
      const status = await api.setGithubDocsSync(client, projectId, args.enabled, folder);
      return { docsSync: status.docsSync ?? null };
    }

    case "octri_publish_docs_nav": {
      if (!ctx.options.allowPublish) {
        throw new Error("Publishing is disabled. Restart with --allow-publish.");
      }
      return api.publishNav(client, projectOf(ctx, args));
    }

    case "octri_publish_mcp_package": {
      if (!ctx.options.allowPublish) {
        throw new Error("Publishing is disabled. Restart with --allow-publish.");
      }
      const version = args.version;
      return api.publishMcpPackage(
        client,
        projectOf(ctx, args),
        typeof version === "string" && version !== "" ? version : undefined,
      );
    }

    case "octri_delete_component": {
      if (!ctx.options.allowDelete) {
        throw new Error("Deletion is disabled. Restart with --allow-delete.");
      }
      const projectId = projectOf(ctx, args);
      const ref = stringArg(args, "component");
      const found = await api.findComponent(client, projectId, ref);
      if (found === undefined) throw new Error(`No component named "${ref}".`);
      await api.deleteComponent(client, projectId, found.id);
      return { ok: true, id: found.id, name: found.name };
    }

    case "octri_delete_webhook": {
      if (!ctx.options.allowDelete) {
        throw new Error("Deletion is disabled. Restart with --allow-delete.");
      }
      await api.deleteWebhook(client, projectOf(ctx, args), stringArg(args, "webhook_id"));
      return { ok: true };
    }

    case "octri_publish_build": {
      if (!ctx.options.allowPublish) {
        throw new Error(
          "Publishing is disabled. Restart with --allow-publish.",
        );
      }
      const mode = args.mode === "release" ? "release" : "pack";
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

// The ids below come from an agent, and an agent can be steered by text it has
// read (a spec description, a monitoring issue a user wrote). Joined into a path
// unchecked, `build_id: "../../.."` listed and read any file this user can,
// ~/.octri/config.json with the session and API key included.

/** Ids the API issues. Anything else is refused before it reaches a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** SDK language ids: `typescript`, `python`, `go`… */
const SAFE_LANGUAGE = /^[a-z][a-z0-9-]{0,31}$/;

function pathSegment(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${what}: ${JSON.stringify(value)}.`);
  return value;
}

/** Refuses any path that resolves outside the local artifact cache. */
function insideLabCache(path: string): string {
  const root = resolvePath(cacheDir(), "lab");
  const full = resolvePath(path);
  if (!full.startsWith(root + sep)) {
    throw new Error("That path is outside the local artifact cache.");
  }
  return full;
}

function runDir(projectId: string, buildId: string): string {
  return insideLabCache(
    join(
      cacheDir(),
      "lab",
      pathSegment(projectId, SAFE_ID, "project_id"),
      pathSegment(buildId, SAFE_ID, "build_id"),
    ),
  );
}

function languageDir(
  projectId: string,
  buildId: string,
  language: string,
): string {
  return insideLabCache(
    join(runDir(projectId, buildId), pathSegment(language, SAFE_LANGUAGE, "language")),
  );
}

async function fetchArtifacts(
  ctx: ToolContext,
  projectId: string,
  buildId: string,
  languages: readonly string[],
): Promise<unknown> {
  const artifacts = await api.listArtifacts(
    ctx.client,
    projectId,
    buildId,
    true,
  );
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
    // The language comes from the API's response; it names a directory too.
    let target: string;
    try {
      target = languageDir(projectId, buildId, artifact.language);
    } catch (err) {
      results.push({ language: artifact.language, ok: false, reason: (err as Error).message });
      continue;
    }
    const response = await ctx.client.fetchRaw(artifact.url);
    const buffer = Buffer.from(await response.arrayBuffer());

    try {
      const files = extract(buffer, target, safeArtifactFilename(artifact.url));
      const hash = createHash("sha256");
      for (const file of [...files].sort((a, b) =>
        a.path.localeCompare(b.path),
      )) {
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

/** The server with every tool registered, not yet bound to a transport. */
export function createServer(settings: Resolved, options: ServeOptions): Server {
  const ctx: ToolContext = {
    settings,
    client: new OctriClient(settings),
    options,
  };

  const server = new Server(
    { name: "octri-cli", version: CLI_VERSION },
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

  return server;
}

export async function serve(options: ServeOptions): Promise<void> {
  const settings = resolve({
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const server = createServer(settings, options);

  // stdio only: stdout is the protocol channel, so nothing else may write there.
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `octri mcp: serving ${tools(options).length} tools against ${settings.apiUrl}\n`,
  );
}
