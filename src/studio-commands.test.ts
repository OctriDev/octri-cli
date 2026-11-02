import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "./args.js";
import { OctriClient } from "./client.js";
import { componentNameFromFile } from "./commands/components.js";
import { docsButtonAdd, docsNavSet, docsRedirectAdd, navFromFile } from "./commands/docs.js";
import {
  docsCustomCodeSet,
  docsPlaygroundSet,
  docsThemeSet,
  parseAssignments,
} from "./commands/docs-settings.js";
import { endpointsAdd } from "./commands/endpoints.js";
import { githubDocsPull } from "./commands/github.js";
import { mcpPermissionSet, mcpPlugin, mcpScore, mcpTest, mcpWorkflows } from "./commands/mcp.js";
import { sdkQuickstartSet } from "./commands/sdk.js";
import { webhooksCreate, webhooksUpdate } from "./commands/webhooks.js";
import { PROXY_VARIABLES } from "./proxy.js";
import { configureOutput } from "./ui/output.js";

import type { Context } from "./context.js";

// These tests stub the built-in fetch. A proxy variable in the shell running
// them would send requests through undici instead and past the stub.
for (const name of PROXY_VARIABLES) delete process.env[name];

configureOutput({ json: false, quiet: true, plain: true });

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Responder = (call: Call) => unknown;

/** Stubs fetch for one test: `routes` maps "METHOD /path" to a JSON body. */
async function withApi(
  routes: Record<string, Responder | unknown>,
  run: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${path}`];
    if (route === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: `unstubbed ${call.method} ${path}` } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    const body = typeof route === "function" ? (route as Responder)(call) : route;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** `subroute`: a three-word command (`docs redirects add`) whose action word is shifted off. */
function context(argv: string[], subroute = true): Context {
  const settings = {
    profile: "test",
    apiUrl: "https://api.example.test/api/v1",
    accessToken: "token",
    refreshToken: undefined,
    apiKey: undefined,
    defaultProject: "p1",
    defaultLanguages: [],
  };
  const args = parse(argv);
  // `routeSub` shifts the action word off before calling the handler.
  if (subroute) args.positionals.shift();
  return {
    args,
    settings,
    client: new OctriClient(settings, false),
    projectId: () => "p1",
  };
}

const writes = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

// ─── Argument parsing ─────────────────────────────────────────────────────────

test("the new boolean flags do not swallow the next word", () => {
  const args = parse(["docs", "home", "set", "--hide-sidebar", "guide1"]);
  assert.equal(args.flags["hide-sidebar"], true);
  assert.deepEqual(args.positionals, ["set", "guide1"]);

  const off = parse(["mcp", "permissions", "set", "deleteUser", "--no-destructive"]);
  assert.equal(off.flags["destructive"], false);
});

// ─── MCP tool quality ─────────────────────────────────────────────────────────

const QUALITY = {
  report: {
    score: 5.4,
    grade: "C",
    maxScore: 10,
    definitions: 4.6,
    coherence: 7.2,
    mode: "all",
    tokens: { definitions: 900, listed: 900 },
    tools: [{
      key: "get-pets",
      kind: "operation",
      slug: "get-pets",
      name: "list_pets",
      score: 4.2,
      grade: "C",
      tokens: 300,
      findings: [{ key: "get-pets|description-usage", ruleId: "description-usage", severity: "medium", message: "Nothing says when to use this tool." }],
    }],
    findings: [],
    byRule: [{ ruleId: "description-usage", title: "Description says when to use it", findings: 1 }],
  },
  history: [{ revision: 2, score: 5.4, createdAt: "2026-10-29T00:00:00Z" }],
  ignored: [],
};

test("mcp score only reads, and fails CI under --fail-under", async () => {
  await withApi({ "GET /projects/p1/mcp/quality": QUALITY }, async (calls) => {
    process.exitCode = undefined;
    await mcpScore(context(["mcp", "score", "--fail-under", "7"], false));
    assert.equal(process.exitCode, 1);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    process.exitCode = undefined;
    await mcpScore(context(["mcp", "score", "--fail-under", "5"], false));
    assert.equal(process.exitCode, undefined);
  });
});

test("mcp score refuses a threshold off the 10-point scale, and an unknown --tool", async () => {
  await withApi({ "GET /projects/p1/mcp/quality": QUALITY }, async () => {
    await assert.rejects(mcpScore(context(["mcp", "score", "--fail-under", "70"], false)), /0 to 10/);
    await assert.rejects(mcpScore(context(["mcp", "score", "--tool", "nope"], false)), /No served tool/);
    await mcpScore(context(["mcp", "score", "--tool", "list_pets"], false));
  });
});

// ─── MCP guide workflows ──────────────────────────────────────────────────────

const WORKFLOWS = {
  mode: "selected",
  guides: [
    { id: "g1", slug: "accept-a-payment", title: "Accept a payment", published: true, fingerprint: "0123456789abcdef", calls: 3, workflow: { status: "current", tool: "accept_a_payment", prompt: "accept_a_payment", served: true } },
    { id: "g2", slug: "refunds", title: "Refunds", published: true, fingerprint: "fedcba9876543210", calls: 1, workflow: { status: "stale", tool: "refunds", served: true } },
    { id: "g3", slug: "concepts", title: "Concepts", published: true, fingerprint: "0000000000000000", calls: 0 },
  ],
  orphans: [],
};

test("mcp workflows only reads, and --stale fails CI when a guide moved on", async () => {
  await withApi({ "GET /projects/p1/mcp/guide-workflows": WORKFLOWS }, async (calls) => {
    process.exitCode = undefined;
    await mcpWorkflows(context(["mcp", "workflows", "--stale"], false));
    assert.equal(process.exitCode, 1);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    process.exitCode = undefined;
    await mcpWorkflows(context(["mcp", "workflows", "--stale", "--guide", "accept-a-payment"], false));
    assert.equal(process.exitCode, undefined);
    await assert.rejects(mcpWorkflows(context(["mcp", "workflows", "--guide", "nope"], false)), /No guide/);
  });
});

// ─── MCP Claude Code plugin ───────────────────────────────────────────────────

const PLUGIN = {
  settings: { enabled: true, server: "hosted", practice: true, commands: "all", excludedPrompts: [], github: null },
  planAllows: true,
  name: "acme",
  marketplaceName: "acme",
  version: "1.2.0",
  marketplaceUrl: "https://mcp.acme.com/claude/marketplace.json",
  practice: false,
  localPackage: "@octri/mcp",
  commands: [{ name: "refund-order", prompt: "refund-order", description: "Refund an order.", fromGuide: true }],
  guides: [{ slug: "quickstart", title: "Quickstart", included: true, trimmed: false }],
  skillBytes: 2048,
  skillLines: 40,
  github: { connected: false, account: null, repoUrl: null },
};

test("mcp plugin only reads, and refuses a download the plan does not include", async () => {
  await withApi({ "GET /projects/p1/mcp/plugin": PLUGIN }, async (calls) => {
    await mcpPlugin(context(["mcp", "plugin"], false));
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /projects/p1/mcp/plugin"]);
  });
  await withApi({ "GET /projects/p1/mcp/plugin": { ...PLUGIN, planAllows: false } }, async (calls) => {
    await assert.rejects(mcpPlugin(context(["mcp", "plugin", "--download", "out"], false)), /Starter plan/);
    assert.equal(calls.length, 1);
  });
});

// ─── MCP agent test runs ──────────────────────────────────────────────────────

const LISTING = {
  tools: [{ slug: "get-pets", name: "list_pets" }],
  policies: { "get-pets": { policy: "auto" } },
  policiesRevision: 3,
  overrides: {},
  groups: [],
  customTools: [],
  prompts: [],
  resources: [],
  toolMode: "auto",
  outageWarnings: true,
  errorGuides: {},
};

function testRun(state: string, verdicts: Record<string, "pass" | "flaky" | "fail">) {
  const models = Object.entries(verdicts).map(([model, verdict]) => ({
    model, attempts: 1, passed: verdict === "fail" ? 0 : 1, passRate: verdict === "fail" ? 0 : verdict === "flaky" ? 0.5 : 1,
    tasksPassed: verdict === "pass" ? 1 : 0, tasksFlaky: verdict === "flaky" ? 1 : 0, tasksFailed: verdict === "fail" ? 1 : 0,
    verdict, tokensPerTask: 1200, p95ModelMs: 800,
  }));
  return {
    id: "run1", state, fingerprint: "f", mode: "dry", models: Object.keys(verdicts), repeat: 1,
    tasks: [{ id: "gen-get-pets", prompt: "List pets." }],
    attempts: Object.entries(verdicts).map(([model, verdict]) => ({ taskId: "gen-get-pets", model, repeat: 0, outcome: verdict === "fail" ? "wrongTool" : "pass" })),
    total: models.length,
    ...(state === "done"
      ? { summary: { verdict: models.some((m) => m.verdict === "fail") ? "fail" : "pass", models, tasks: models.map((m) => ({ taskId: "gen-get-pets", model: m.model, passed: m.passed, attempts: 1, verdict: m.verdict })) }, credits: 4 }
      : {}),
    createdAt: "2026-10-29T00:00:00Z",
  };
}

test("mcp test runs the published draft, waits for the run, and fails CI when a model fails a task", async () => {
  await withApi(
    {
      "GET /projects/p1/mcp/tools": LISTING,
      "POST /projects/p1/mcp/test-runs": testRun("queued", {}),
      "GET /projects/p1/mcp/test-runs/run1": testRun("done", { "claude-sonnet-5-5": "pass", "gpt-6-sol": "fail" }),
    },
    async (calls) => {
      process.exitCode = undefined;
      await mcpTest(context(["mcp", "test", "--models", "claude-sonnet-5-5,gpt-6-sol", "--repeat", "2"], false));
      const post = calls.find((c) => c.method === "POST");
      // The publish body's keys only: the listing's tools and revision stay behind.
      assert.deepEqual(post?.body, {
        draft: { policies: LISTING.policies, overrides: {}, groups: [], customTools: [], prompts: [], resources: [], toolMode: "auto", outageWarnings: true, errorGuides: {} },
        models: ["claude-sonnet-5-5", "gpt-6-sol"],
        repeat: 2,
      });
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;
    },
  );
});

test("mcp test passes CI on a pass rate over --fail-under, and sends a draft file and a task subset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "octri-mcp-test-"));
  const draftPath = join(dir, "draft.json");
  writeFileSync(draftPath, JSON.stringify({ policies: {}, toolMode: "search" }));
  try {
    await withApi(
      { "POST /projects/p1/mcp/test-runs": testRun("done", { "claude-sonnet-5-5": "pass", "gpt-6-sol": "flaky" }) },
      async (calls) => {
        process.exitCode = undefined;
        await mcpTest(context(["mcp", "test", "--draft", draftPath, "--task", "gen-get-pets", "--fail-under", "0.5"], false));
        assert.deepEqual(calls[0]?.body, { draft: { policies: {}, toolMode: "search" }, taskIds: ["gen-get-pets"] });
        assert.equal(process.exitCode, undefined);
        await mcpTest(context(["mcp", "test", "--draft", draftPath, "--fail-under", "0.9"], false));
        assert.equal(process.exitCode, 1);
        process.exitCode = undefined;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp test saves a tasks file first, and refuses bad flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "octri-mcp-tasks-"));
  const tasksPath = join(dir, "tasks.json");
  writeFileSync(tasksPath, JSON.stringify([{ id: "own-1", prompt: "List pets.", steps: [{ tools: ["list_pets"] }] }]));
  try {
    await withApi(
      {
        "PUT /projects/p1/mcp/test-tasks": (call: Call) => ({ tasks: (call.body as { tasks: unknown[] }).tasks }),
        "GET /projects/p1/mcp/tools": LISTING,
        "POST /projects/p1/mcp/test-runs": testRun("done", { "claude-sonnet-5-5": "pass" }),
      },
      async (calls) => {
        await mcpTest(context(["mcp", "test", "--tasks", tasksPath], false));
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
          "PUT /projects/p1/mcp/test-tasks",
          "GET /projects/p1/mcp/tools",
          "POST /projects/p1/mcp/test-runs",
        ]);
        process.exitCode = undefined;
      },
    );
    await assert.rejects(mcpTest(context(["mcp", "test", "--fail-under", "90"], false)), /0 to 1/);
    await assert.rejects(mcpTest(context(["mcp", "test", "--repeat", "9"], false)), /1 to 5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── MCP permissions ──────────────────────────────────────────────────────────

test("mcp permissions set merges into the map and publishes at the read revision", async () => {
  await withApi(
    {
      "GET /projects/p1/mcp/tools": {
        tools: [
          { slug: "delete-users-id", name: "deleteUser", http: { method: "DELETE", path: "/users/{id}" } },
          { slug: "get-users", name: "listUsers", http: { method: "GET", path: "/users" } },
        ],
        policies: { "get-users": { policy: "off" }, "delete-users-id": { destructive: true } },
        policiesRevision: 4,
      },
      "PUT /projects/p1/mcp/policies": (call: Call) => ({
        policies: (call.body as { policies: unknown }).policies,
        policiesRevision: 5,
      }),
    },
    async (calls) => {
      await mcpPermissionSet(context(["mcp", "permissions", "set", "deleteUser", "off"]));
      const [put] = writes(calls, "PUT");
      assert.deepEqual(put?.body, {
        policies: {
          "get-users": { policy: "off" },
          "delete-users-id": { destructive: true, policy: "off" },
        },
        revision: 4,
      });
    },
  );
});

test("mcp permissions set refuses an unknown policy before calling the API", async () => {
  await withApi({}, async (calls) => {
    await assert.rejects(
      mcpPermissionSet(context(["mcp", "permissions", "set", "deleteUser", "never"])),
      /Policy must be one of auto, confirm, off/,
    );
    assert.equal(calls.length, 0);
  });
});

// ─── Docs IA ──────────────────────────────────────────────────────────────────

test("docs redirects add replaces a rule for the same old path instead of duplicating it", async () => {
  await withApi(
    {
      "GET /projects/p1/redirects": {
        redirects: [
          { from: "/old", to: "/stale" },
          { from: "/keep/*", to: "/kept/*" },
        ],
        published: [],
        pending: true,
      },
      "PUT /projects/p1/redirects": (call: Call) => ({
        ...(call.body as object),
        published: [],
        pending: true,
      }),
    },
    async (calls) => {
      await docsRedirectAdd(context(["docs", "redirects", "add", "/old", "/new"]));
      assert.deepEqual(writes(calls, "PUT")[0]?.body, {
        redirects: [
          { from: "/keep/*", to: "/kept/*" },
          { from: "/old", to: "/new" },
        ],
      });
    },
  );
});

test("docs buttons add updates a button with the same label in place", async () => {
  await withApi(
    {
      "GET /projects/p1/nav": {
        sections: [],
        tabs: [],
        hasDraft: false,
        buttons: [
          { label: "Sign up", url: "/signup", style: "plain" },
          { label: "Status", url: "https://status.example.com", style: "plain" },
        ],
      },
      "PUT /projects/p1/nav/buttons": (call: Call) => call.body,
    },
    async (calls) => {
      await docsButtonAdd(
        context(["docs", "buttons", "add", "Sign up", "https://app.example.com", "--style", "primary"]),
      );
      assert.deepEqual(writes(calls, "PUT")[0]?.body, {
        buttons: [
          { label: "Sign up", url: "https://app.example.com", style: "primary" },
          { label: "Status", url: "https://status.example.com", style: "plain" },
        ],
      });
    },
  );
});

test("component names come from the file name in PascalCase", () => {
  assert.equal(componentNameFromFile("components/Banner.jsx"), "Banner");
  assert.equal(componentNameFromFile("call-out.mdx"), "CallOut");
  assert.equal(componentNameFromFile("/tmp/price_table.tsx"), "PriceTable");
});

test("docs endpoints add sends the method upper-cased and the path as typed", async () => {
  await withApi(
    {
      "POST /projects/p1/draft-endpoints": (call: Call) => ({
        draft: { id: "d1", action: "add", ...(call.body as object) },
      }),
    },
    async (calls) => {
      await endpointsAdd(
        context(["docs", "endpoints", "add", "get", "/users/{id}", "--summary", "Get a user"]),
      );
      assert.deepEqual(calls[0]?.body, { method: "GET", path: "/users/{id}", summary: "Get a user" });
    },
  );
});

// ─── SDK quickstart ───────────────────────────────────────────────────────────

test("sdk quickstart set resolves METHOD /path and keeps the other endpoint config", async () => {
  await withApi(
    {
      "GET /projects/p1/sdk/operations": {
        operations: [{ slug: "get-users", method: "get", path: "/users" }],
      },
      "GET /projects/p1/sdk-settings": {
        sdkSettings: { packageName: "acme" },
        sdkEndpoints: { "get-users": { name: "list" }, "post-users": { quickstart: true } },
        revision: 7,
        deprecationBaselines: { sdk: null, docs: null },
        repoHookKeys: [],
      },
      "PUT /projects/p1/sdk-settings": {},
    },
    async (calls) => {
      await sdkQuickstartSet(context(["sdk", "quickstart", "set", "GET", "/users"]));
      const body = writes(calls, "PUT")[0]?.body as {
        settings: unknown;
        endpoints: Record<string, unknown>;
        revision: number;
      };
      assert.equal(body.revision, 7);
      assert.deepEqual(body.settings, { packageName: "acme" });
      assert.deepEqual(body.endpoints, {
        "get-users": { name: "list", quickstart: true },
        "post-users": { quickstart: true },
      });
    },
  );
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

test("webhooks create --events all subscribes to every event the API lists", async () => {
  await withApi(
    {
      "GET /projects/p1/webhooks/events": { events: ["spec.ingested", "sdk.published"] },
      "POST /projects/p1/webhooks": (call: Call) => ({
        webhook: { id: "w1", ...(call.body as object), urlPreview: "https://hooks.example.com/…" },
        signingSecret: "whsec_test",
      }),
    },
    async (calls) => {
      await webhooksCreate(
        context(["webhooks", "create", "https://hooks.example.com/in", "--events", "all"], false),
      );
      assert.deepEqual(writes(calls, "POST")[0]?.body, {
        type: "generic",
        url: "https://hooks.example.com/in",
        events: ["spec.ingested", "sdk.published"],
        label: "hooks.example.com",
      });
    },
  );
});

test("webhooks update --events all also expands, which the API would refuse as an event", async () => {
  await withApi(
    {
      "GET /projects/p1/webhooks/events": { events: ["spec.ingested", "sdk.published"] },
      "PATCH /projects/p1/webhooks/w1": (call: Call) => ({
        webhook: { id: "w1", label: "x", ...(call.body as object) },
      }),
    },
    async (calls) => {
      await webhooksUpdate(context(["webhooks", "update", "w1", "--events", "all"], false));
      assert.deepEqual(writes(calls, "PATCH")[0]?.body, {
        events: ["spec.ingested", "sdk.published"],
      });
    },
  );
});

// ─── GitHub docs pull ─────────────────────────────────────────────────────────

test("github docs pull writes repo paths under --out and never outside it", async () => {
  const out = mkdtempSync(join(tmpdir(), "octri-docs-pull-"));
  try {
    await withApi(
      {
        "POST /projects/p1/github/docs-files/read": {
          files: [
            { path: "docs/intro.mdx", content: "# Intro\n" },
            { path: "../escape.md", content: "nope" },
          ],
          skipped: [{ path: "docs/huge.md", reason: "too_large" }],
        },
      },
      async () => {
        await githubDocsPull(
          context(["github", "docs", "pull", "docs/intro.mdx", "../escape.md", "--out", out]),
        );
      },
    );
    assert.equal(readFileSync(join(out, "docs", "intro.mdx"), "utf8"), "# Intro\n");
    assert.equal(existsSync(join(out, "..", "escape.md")), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ─── octri.json sections: nav tabs and docs settings ──────────────────────────

test("key=value words parse booleans, numbers, lists, JSON, files and dotted keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "octri-assign-"));
  try {
    writeFileSync(join(dir, "docs.css"), ".a { color: red }\n");
    assert.deepEqual(
      parseAssignments(
        [
          "showToc=false",
          "metaTitle=Acme = Payments",
          "requestTimeoutMs=30000",
          "allowedOrigins=https://a.dev, https://b.dev",
          "custom=[]",
          "defaultAuth.type=bearer",
          `css=@${join(dir, "docs.css")}`,
          "x=",
        ],
        { numbers: ["requestTimeoutMs"], lists: ["allowedOrigins"], json: ["custom"] },
      ),
      {
        showToc: false,
        metaTitle: "Acme = Payments",
        requestTimeoutMs: 30000,
        allowedOrigins: ["https://a.dev", "https://b.dev"],
        custom: [],
        defaultAuth: { type: "bearer" },
        css: ".a { color: red }\n",
        x: "",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => parseAssignments(["primaryColor"]), /key=value/);
  assert.throws(() => parseAssignments(["t=soon"], { numbers: ["t"] }), /number/);
});

test("docs theme set patches only the theme with the keys as typed", async () => {
  await withApi(
    {
      "PATCH /projects/p1": (call: Call) => ({
        project: { theme: (call.body as { theme: object }).theme, seo: {}, socials: {} },
      }),
    },
    async (calls) => {
      await docsThemeSet(
        context(["docs", "theme", "set", "primaryColor=#ff6a00", "showLogo=true"]),
      );
      assert.deepEqual(writes(calls, "PATCH")[0]?.body, {
        theme: { primaryColor: "#ff6a00", showLogo: true },
      });
    },
  );
});

test("docs playground set sends defaultAuth whole, merged onto the saved half", async () => {
  const playground = {
    enabled: false,
    baseUrl: "",
    defaultAuth: { type: "inherit", headerName: "Authorization" },
    allowedOrigins: [],
    requestTimeoutMs: 15000,
  };
  await withApi(
    {
      "GET /projects/p1/playground": { playground },
      "PATCH /projects/p1/playground": (call: Call) => ({
        playground: { ...playground, ...(call.body as object) },
      }),
    },
    async (calls) => {
      await docsPlaygroundSet(
        context(["docs", "playground", "set", "defaultAuth.type=bearer", "requestTimeoutMs=30000"]),
      );
      assert.deepEqual(writes(calls, "PATCH")[0]?.body, {
        defaultAuth: { type: "bearer", headerName: "Authorization" },
        requestTimeoutMs: 30000,
      });
    },
  );
});

test("docs custom-code set reads @file values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "octri-code-"));
  try {
    const file = join(dir, "head.html");
    writeFileSync(file, '<meta name="x" content="y">');
    await withApi(
      {
        "PATCH /projects/p1/custom-code": (call: Call) => ({
          customCode: { enabled: true, css: "", headHtml: "", bodyEndHtml: "", ...(call.body as object) },
        }),
      },
      async (calls) => {
        await docsCustomCodeSet(
          context(["docs", "custom-code", "set", `headHtml=@${file}`, "enabled=true"]),
        );
        assert.deepEqual(writes(calls, "PATCH")[0]?.body, {
          headHtml: '<meta name="x" content="y">',
          enabled: true,
        });
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs nav set drafts the tabs from `docs nav --json` output and leaves buttons out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "octri-nav-"));
  try {
    const file = join(dir, "nav.json");
    const tabs = [{ label: "Guides", slug: "guides", kind: "content", sections: [] }];
    writeFileSync(
      file,
      JSON.stringify({
        sections: null,
        tabs,
        buttons: [{ label: "Sign up", url: "/signup", style: "plain" }],
        hasDraft: false,
      }),
    );
    await withApi(
      { "PUT /projects/p1/nav": (call: Call) => ({ ...(call.body as object), hasDraft: true }) },
      async (calls) => {
        await docsNavSet(context(["docs", "nav", "set", file]));
        assert.deepEqual(writes(calls, "PUT")[0]?.body, { sections: [], tabs });
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(navFromFile([{ label: "A" }]), { tabs: [{ label: "A" }], sections: [] });
  assert.throws(() => navFromFile({ nav: [] }), /tabs/);
});
