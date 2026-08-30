/**
 * Help text. Grouped by workflow rather than alphabetically — the generator
 * loop is what most sessions are actually doing.
 */

import { accent, bold, dim, gray, gradient } from "./ui/ansi.js";
import { banner } from "./ui/box.js";
import { line } from "./ui/output.js";

interface Entry {
  usage: string;
  description: string;
}

interface Group {
  title: string;
  entries: Entry[];
}

const GROUPS: Group[] = [
  {
    title: "Getting started",
    entries: [
      {
        usage: "auth login",
        description: "Sign in (prompts, or --email/--password)",
      },
      { usage: "auth whoami", description: "Current user, org, plan, project" },
      { usage: "auth token", description: "Print the bearer token for curl" },
      {
        usage: "auth profiles",
        description: "Environments configured on this machine",
      },
      {
        usage: "config use <name>",
        description: "Switch profile (--api-url local)",
      },
      {
        usage: "config set <k> <v>",
        description: "apiUrl · defaultProject · defaultLanguages",
      },
    ],
  },
  {
    title: "Projects & specs",
    entries: [
      { usage: "projects list", description: "All projects" },
      {
        usage: "projects use [id]",
        description: "Pick the working project (interactive)",
      },
      { usage: "projects create <name>", description: "New project" },
      { usage: "specs list", description: "Specs on the project" },
      {
        usage: "specs push <file|->",
        description: "Upload a spec and follow ingestion",
      },
      { usage: "specs import <url>", description: "Import a spec from a URL" },
    ],
  },
  {
    title: "SDK generator",
    entries: [
      { usage: "sdk languages", description: "Generator language catalogue" },
      {
        usage: "sdk operations",
        description: "Operations parsed from the current spec (--grep)",
      },
      {
        usage: "sdk settings get",
        description: "Studio settings (--key a.b.c)",
      },
      {
        usage: "sdk settings set <k> <v>",
        description: "Write a setting (--file settings.json)",
      },
      {
        usage: "sdk validate",
        description: "Validate the spec through the generator",
      },
      {
        usage: "sdk preview --lang go",
        description: "Generate one language, no build spent",
      },
      {
        usage: "sdk build --lang go,rust",
        description: "Build + live lanes (--download, --detach)",
      },
      { usage: "sdk builds", description: "Build history" },
      {
        usage: "sdk watch <buildId>",
        description: "Attach to a running build",
      },
      {
        usage: "sdk artifacts [buildId]",
        description: "Per-language artifacts",
      },
      {
        usage: "sdk download [buildId]",
        description: "Fetch + extract artifacts (--lang, --out)",
      },
      {
        usage: "sdk retry [buildId]",
        description: "Re-run the failed languages",
      },
      {
        usage: "sdk publish [buildId]",
        description: "Publish to registries (--mode pack|release)",
      },
      { usage: "sdk repos", description: "Per-language GitHub repos" },
      {
        usage: "sdk repos init <language>",
        description:
          "Initialize explicit staging and production GitHub targets",
      },
      { usage: "sdk stats", description: "Build health + failure hotspots" },
    ],
  },
  {
    title: "Generator lab",
    entries: [
      {
        usage: "lab run --lang go,rust",
        description: "Validate → build → pull → report, one command",
      },
      {
        usage: "lab run --all",
        description: "Every language in the catalogue",
      },
      { usage: "lab runs", description: "Cached local runs" },
      {
        usage: "lab pull <buildId>",
        description: "Fetch + extract an existing build",
      },
      {
        usage: "lab files <buildId> --lang go",
        description: "Emitted file tree",
      },
      {
        usage: "lab cat <buildId> --lang go --file x",
        description: "Read one generated file",
      },
      {
        usage: "lab diff <buildA> <buildB>",
        description: "What changed in the emitted code",
      },
    ],
  },
  {
    title: "Docs & agents",
    entries: [
      { usage: "docs pages", description: "Generated documentation pages" },
      { usage: "docs show <slug>", description: "One page" },
      { usage: "docs changelog", description: "Project changelog" },
      {
        usage: "mcp tools",
        description: "The project's published MCP tool catalogue",
      },
      {
        usage: "mcp serve",
        description: "Run this CLI as an MCP server over stdio",
      },
    ],
  },
];

const GLOBAL_FLAGS: Entry[] = [
  { usage: "--project <id>", description: "Override the selected project" },
  {
    usage: "--profile <name>",
    description: "Use a different stored environment",
  },
  {
    usage: "--api-url <url>",
    description: "Point at another API (`local` = :3001)",
  },
  { usage: "--json", description: "Machine-readable output, no decoration" },
  { usage: "--quiet", description: "Suppress non-essential output" },
  { usage: "--plain", description: "Disable animation (implied by CI)" },
  { usage: "--no-color", description: "Disable colour (or set NO_COLOR)" },
];

export function printHelp(topic?: string): void {
  banner("OpenAPI → docs, SDKs, MCP servers");

  if (topic !== undefined) {
    const group = GROUPS.find(
      (g) =>
        g.title.toLowerCase().includes(topic) ||
        g.entries.some((e) => e.usage.startsWith(topic)),
    );
    if (group !== undefined) {
      renderGroup(group);
      return;
    }
  }

  line(`  ${bold("USAGE")}  ${dim("octri")} <command> [options]`);

  for (const group of GROUPS) renderGroup(group);

  line();
  line(`  ${gray("GLOBAL")}`);
  for (const entry of GLOBAL_FLAGS) {
    line(`    ${accent(entry.usage.padEnd(30))} ${dim(entry.description)}`);
  }

  line();
  line(
    `  ${dim("Start here:")} ${gradient("octri auth login && octri projects use && octri lab run --lang go")}`,
  );
  line();
}

function renderGroup(group: Group): void {
  line();
  line(`  ${gray(group.title.toUpperCase())}`);
  for (const entry of group.entries) {
    line(`    ${bold(entry.usage.padEnd(30))} ${dim(entry.description)}`);
  }
}
