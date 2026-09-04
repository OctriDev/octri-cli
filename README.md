# @octri/cli

**The `octri` command line: push OpenAPI specs, build SDKs, publish docs and
work production errors from a terminal, with an MCP server that hands an AI
agent the same commands.** Push a spec, trigger an SDK build across ten
languages, watch every lane live, publish a docs version, upload source maps
from CI, then triage the issues those SDKs report back.

Octri turns an OpenAPI spec into a documentation site, client SDKs for ten
languages, an MCP server your AI assistant can call, and monitoring for the
API behind them. This package is the CLI, and it carries its own MCP server so
an agent can run the same commands. See [octri.dev](https://octri.dev).

Node 20 or newer.

## Install

```bash
npm install -g @octri/cli
octri --help
```

## Quick start

```bash
octri config use local --api-url local     # local = http://localhost:3001/api/v1
octri auth login                           # prompts; --email/--password also work
octri projects use                         # interactive picker
octri lab run --lang go,rust               # validate → build → pull → report
```

## The generator loop

`octri lab run` is the whole cycle in one command:

1. validates the current spec through the generator (skip with `--skip-validate`),
2. triggers a build for the requested languages,
3. renders a live lane per language showing its real phase
   (`generating` → `verifying` → `packaging` → `installing` → `ready`),
4. downloads and extracts every artifact that shipped,
5. prints a per-language verdict with failing output inline, and fingerprints
   each emitted tree,
6. exits non-zero if any language failed.

```bash
octri lab run --all                        # every language in the catalogue
octri lab files <buildId> --lang go        # the emitted file tree
octri lab cat  <buildId> --lang go --file client.go
octri lab diff <oldBuildId> <newBuildId>   # what changed in the generated code
```

Runs are cached under `~/.octri/cache/lab/<projectId>/<buildId>/` with a
`manifest.json`, which is what makes `diff` possible after the fact.

For a faster inner loop that spends no build at all:

```bash
octri sdk preview --lang go                # real generator output, paths only
octri sdk preview --lang go --show client.go
octri sdk preview --lang go --out ./out
```

## Command map

| Group | What |
|---|---|
| `auth` | `login` · `logout` · `whoami` · `token` · `profiles` |
| `config` | `list` · `set <k> <v>` · `use <profile>` · `path` |
| `projects` | `list` · `show` · `create` · `use` · `current` |
| `specs` | `list` · `push <file\|->` · `import <url>` · `status` · `delete` |
| `sdk` | `languages` · `operations` · `settings get\|set` · `validate` · `audit` · `preview` · `build` · `builds` · `watch` · `artifacts` · `download` · `retry` · `publish` · `repos` · `stats` |
| `lab` | `run` · `runs` · `pull` · `files` · `cat` · `diff` |
| `docs` | `pages [generate\|regenerate\|publish\|title]` · `show <slug>` · `guides` · `nav` · `versions` · `domain` · `changelog` |
| `monitoring` | `status` · `enable` · `summary` · `issues` · `issue <id>` · `resolve\|ignore\|reopen\|comment` · `logs` · `traces` · `performance` · `releases` · `alerts` · `checks` · `sourcemaps upload` · `sources upload` · `config` |
| `orgs` | `list` · `show` · `switch` · `usage` · `billing` · `invoices` · `members` · `invites` |
| `keys` | `list` · `create <name>` · `revoke <id>` |
| `github` | `status` · `connect <owner/repo>` · `sync` · `auto-sync <on\|off>` |
| `jobs` | `list` · `show <id>` |
| `mcp` | `tools` · `serve` |

Global flags: `--project <id>`, `--profile <name>`, `--api-url <url>`, `--json`,
`--quiet`, `--plain`, `--no-color`.

## Output modes

Everything is rendered through one output layer, so:

- **TTY** — colour, spinners, live repainting lanes, box-drawing tables.
- **Piped / CI** — animation off automatically, append-only lines, no escape
  sequences. `CI=1` and `--plain` force this.
- **`--json`** — exactly one JSON document on stdout and nothing else; errors go
  to stderr. This is what scripts and the MCP layer consume.

`NO_COLOR` and `FORCE_COLOR` are both honoured.

## Configuration

State lives in `~/.octri/config.json` (mode `0600` — it holds session tokens).
Override the location with `OCTRI_CONFIG_DIR`.

Profiles keep local, staging and production side by side:

```bash
octri config use local --api-url local
octri config use prod  --api-url api.octri.dev
octri config set defaultLanguages go,rust,swift
```

Resolution order for every value is **flag → environment → profile → default**:

| Variable | Effect |
|---|---|
| `OCTRI_PROFILE` | Profile to use |
| `OCTRI_API_URL` | API root (`local` is shorthand for `:3001`) |
| `OCTRI_TOKEN` | Bearer token, bypassing the stored session |
| `OCTRI_API_KEY` | API key for the public `/api/v1` surface |
| `OCTRI_PROJECT_ID` | Default project |
| `OCTRI_CONFIG_DIR` | Where config and the artifact cache live |
| `OCTRI_DEBUG` | Print stack traces on failure |

### Authentication

`octri auth login` posts to `/auth/login` and reads the session out of the
`Set-Cookie` headers — the API returns tokens only as cookies. Later requests
present the access token as `Authorization: Bearer`, which the API accepts on
both the dashboard and public routes. An expired token is refreshed once,
silently, using the stored refresh token.

MFA accounts are handled: the login returns a challenge, and the CLI prompts for
the authenticator code (or takes `--code`).

## MCP server

```bash
octri mcp serve
```

Speaks MCP over stdio, exposing the CLI's surface as typed tools so an agent can
work on the generator without driving a browser.

```jsonc
// Claude Desktop / Cursor
{
  "mcpServers": {
    "octri": {
      "command": "octri",
      "args": ["mcp", "serve", "--profile", "local"]
    }
  }
}
```

Tools include `octri_whoami`, `octri_list_projects`, `octri_list_operations`,
`octri_get_sdk_settings` / `octri_set_sdk_settings`, `octri_validate_spec`,
`octri_preview_sdk`, `octri_trigger_build`, `octri_wait_for_build`,
`octri_retry_build`, `octri_fetch_artifacts`, `octri_list_generated_files`,
`octri_read_generated_file` and `octri_diff_builds`, plus the monitoring set:
`octri_monitoring_summary`, `octri_list_issues`, `octri_get_issue`,
`octri_set_issue_status`, `octri_query_logs`, `octri_monitoring_releases` and
`octri_monitoring_performance`. That last group is what lets an agent close the
loop: read the production error its own SDK change caused, then fix it.

**Safety posture.** Credentials come from the stored profile; the agent never
sees them. Reads are unrestricted. The two irreversible operations are gated
behind explicit operator flags and are neither advertised nor callable without
them:

```bash
octri mcp serve --allow-publish   # publishing to package registries
octri mcp serve --allow-delete    # deleting specs
```

Tool failures are returned as tool results, not protocol errors, so an agent can
read the message and correct itself.

## Monitoring, and the CLI it replaces

`octri monitoring` was a second binary, `octri-monitoring`, published as
`@octri/monitoring-cli`. It is one CLI now. That package still exists and still
works, so pipelines pinned to it keep running, but it holds no code of its own:
it prints a deprecation notice and forwards straight into this router.

Reads and triage go through the dashboard API using your session. The two upload
commands are different, deliberately: they POST at the monitoring service with
the project's ingest token, because a CI job has one secret and no interactive
login.

```bash
# CI: three values, no login
octri monitoring sourcemaps upload ./dist \
  --url "$MONITORING_URL" --token "$MONITORING_TOKEN" \
  --environment "$MONITORING_ENVIRONMENT" --release "$GIT_SHA"

# Laptop: signed in, connection resolved for you
octri monitoring sourcemaps upload ./dist
```

`octri monitoring config` prints the three values for pasting into CI. The
release you upload under must equal the release your SDK reports at runtime, or
the service has nothing to pair a trace with.

## Notes

- Build progress is **polled**, not streamed. The `/ws/sdk` socket authenticates
  from a header or cookie, which Node's built-in `WebSocket` cannot set, and a
  WebSocket dependency buys about a second of latency on a multi-minute build.
- Artifact archives are extracted by hand-rolled `tar`/`zip` readers, so no
  `tar` or `unzip` binary is needed. Both refuse entries that would write
  outside the destination directory.
- The only runtime dependency is `@modelcontextprotocol/sdk`. Colour, spinners,
  progress bars, tables, trees and prompts are all local.

## Development

```bash
pnpm --filter @octri/cli build
pnpm --filter @octri/cli typecheck
pnpm --filter @octri/cli test
```

To put a development build of `octri` on your PATH:

```bash
cd packages/octri-cli && npm link
```

---

## The rest of Octri

| Product | What it does |
|---|---|
| [API Studio](https://octri.dev/api-studio) | Your OpenAPI spec becomes a hosted documentation site with a live request playground, editable page by page. |
| [SDK Studio](https://octri.dev/sdk-studio) | The same spec becomes client libraries for ten languages, versioned and released together. |
| [MCP](https://octri.dev/mcp) | Your endpoints and docs become tools an AI assistant can call, generated from the same spec. |
| [Monitoring](https://octri.dev/monitoring) | Errors, traces, uptime and releases for the API, joined to the SDK calls that reached it. |

### Monitoring runtimes

[Node](https://github.com/octridev/octri-node) ·
[Python](https://github.com/octridev/octri-python) ·
[Go](https://github.com/octridev/octri-go) ·
[Ruby](https://github.com/octridev/octri-ruby) ·
[Rust](https://github.com/octridev/octri-rust) ·
[PHP](https://github.com/octridev/octri-php) ·
[Java](https://github.com/octridev/octri-java) ·
[Kotlin](https://github.com/octridev/octri-kotlin) ·
[Swift](https://github.com/octridev/octri-swift) ·
[Dart](https://github.com/octridev/octri-dart)

[Documentation](https://docs.octri.dev/docs) ·
[Pricing](https://octri.dev/pricing) ·
[Changelog](https://docs.octri.dev/changelog)

MIT licensed.
