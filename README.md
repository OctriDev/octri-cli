# @octri/cli

`octri` is the command line for your Octri project. It does what the dashboard
does: push a spec, build SDKs, publish docs, and work through the errors those
SDKs report from production.

Octri takes an OpenAPI spec and gives you a documentation site, client libraries
in ten languages, an MCP server, and monitoring for the API behind all of it.
See [octri.dev](https://octri.dev).

Node 20 or newer.

## Install

```bash
npm install -g @octri/cli
octri --help
```

## Start here

```bash
octri auth login
octri projects use
octri specs push ./openapi.yaml
```

`auth login` prompts for your email and password, and for your authenticator
code if you have two-factor on. `projects use` with no argument opens a picker.

`specs push` waits for the pipeline, not the upload. Your spec parses in about a
second, then the doc pages, search index and changelog get written behind it.
The spinner names the stage it is on.

## Build an SDK

```bash
octri sdk audit                            # what is costing you, scored
octri sdk build --lang go,typescript --download
```

In a terminal, `sdk build` draws a lane per language and repaints it through
`generating`, `verifying`, `packaging`, `installing`, `ready`. Piped or under
CI it prints append-only lines instead, and exits non-zero if any language
fails, so it works as a build step with no extra flags.

`sdk audit` scores the spec and marks which findings the generator can fix on
its own. `octri sdk audit apply <key>` writes one in.

For a look at real generator output without spending a build:

```bash
octri sdk preview --lang go
octri sdk preview --lang go --show client.go
```

## Publish docs

```bash
octri docs versions publish <specId>
octri docs versions label <specId> "Stable"
octri docs domain set docs.example.com
```

`docs domain` prints the CNAME and TXT records to create, then `docs domain
verify` checks them.

## Monitoring

Reads and triage run on your session, so they need nothing but a login:

```bash
octri monitoring summary
octri monitoring issues --status unresolved
octri monitoring issue <id>
octri monitoring resolve <id>
```

`monitoring issue` prints the stack and marks which frames resolved against
uploaded source maps. When none of them did, the release those errors came from
has no symbols, and the CLI says so.

The two upload commands work differently. They talk to the monitoring service
directly with an ingest token, because a CI job has one secret and no way to log
in:

```bash
# CI
octri monitoring sourcemaps upload ./dist \
  --url "$MONITORING_URL" --token "$MONITORING_TOKEN" \
  --environment "$MONITORING_ENVIRONMENT" --release "$GIT_SHA"

# your own machine, already signed in
octri monitoring sourcemaps upload ./dist
```

Run `octri monitoring config` for the three values to store as CI secrets. The
release you upload under has to equal the release your SDK reports at runtime,
or the service has nothing to pair a trace with.

## Commands

| Group | What |
|---|---|
| `auth` | `login` · `logout` · `whoami` · `token` · `profiles` |
| `config` | `list` · `set <k> <v>` · `use <profile>` · `path` |
| `projects` | `list` · `show` · `create` · `use` · `current` |
| `specs` | `list` · `push <file\|->` · `import <url>` · `status` · `delete` |
| `sdk` | `languages` · `operations` · `settings get\|set` · `validate` · `audit` · `preview` · `build` · `builds` · `watch` · `artifacts` · `download` · `retry` · `publish` · `repos` · `stats` |
| `docs` | `pages [generate\|regenerate\|publish\|title]` · `show <slug>` · `guides` · `nav` · `versions` · `domain` · `changelog` |
| `monitoring` | `status` · `enable` · `summary` · `issues` · `issue <id>` · `resolve\|ignore\|reopen\|comment` · `logs` · `traces` · `performance` · `releases` · `alerts` · `checks` · `sourcemaps upload` · `sources upload` · `config` |
| `orgs` | `list` · `show` · `switch` · `usage` · `billing` · `invoices` · `members` · `invites` |
| `keys` | `list` · `create <name>` · `revoke <id>` |
| `github` | `status` · `connect <owner/repo>` · `sync` · `auto-sync <on\|off>` |
| `jobs` | `list` · `show <id>` |
| `mcp` | `tools` · `serve` |

Run `octri <group> --help` for one group on its own.

Global flags: `--project <id>`, `--profile <name>`, `--api-url <url>`, `--json`,
`--quiet`, `--plain`, `--no-color`.

## Output

| Mode | When | What you get |
|---|---|---|
| Interactive | A terminal | Colour, spinners, live build lanes, tables |
| Plain | Piped, or `CI` is set | Append-only lines, no escape sequences |
| `--json` | You ask for it | One JSON document on stdout, errors on stderr |

`--json` is the one to script against:

```bash
octri sdk builds --json | jq '.[0].status'
octri monitoring issues --status unresolved --json | jq 'length'
```

`NO_COLOR` and `FORCE_COLOR` are both honoured.

## Configuration

State lives in `~/.octri/config.json`, mode `0600`, since it holds session
tokens. `OCTRI_CONFIG_DIR` moves it.

Profiles keep environments side by side:

```bash
octri config use prod --api-url api.octri.dev
octri config set defaultLanguages go,rust,swift
```

Every value resolves flag first, then environment, then the stored profile.

| Variable | Effect |
|---|---|
| `OCTRI_PROFILE` | Profile to use |
| `OCTRI_API_URL` | API root (`local` is shorthand for `:3001`) |
| `OCTRI_TOKEN` | Bearer token, bypassing the stored session |
| `OCTRI_API_KEY` | API key for the public routes |
| `OCTRI_PROJECT_ID` | Default project |
| `OCTRI_CONFIG_DIR` | Where config and the artifact cache live |
| `OCTRI_DEBUG` | Print stack traces on failure |

## MCP server

```bash
octri mcp serve
```

This speaks MCP over stdio and offers the same commands as typed tools. An
assistant can push a spec, wait for the build, read the generated Go, and then
read the production error that build caused.

```jsonc
// Claude Desktop / Cursor
{
  "mcpServers": {
    "octri": {
      "command": "octri",
      "args": ["mcp", "serve"]
    }
  }
}
```

Credentials come from your stored profile and the assistant never sees them.
Reads are open. The two operations you cannot take back are refused unless you
start the server with the flag for them:

```bash
octri mcp serve --allow-publish   # publishing to package registries
octri mcp serve --allow-delete    # deleting specs
```

Tool failures come back as tool results rather than protocol errors, so an
assistant can read the message and correct itself.

## Notes

- Build progress is polled, not streamed. The `/ws/sdk` socket authenticates
  from a header or cookie, which Node's built-in `WebSocket` cannot set, and a
  WebSocket dependency would buy about a second of latency on a build that takes
  minutes.
- Artifact archives are extracted by hand-rolled `tar` and `zip` readers, so
  neither binary needs to be installed. Both refuse entries that would write
  outside the destination directory.
- `@modelcontextprotocol/sdk` is the only runtime dependency. Colour, spinners,
  progress bars, tables and prompts are all local.

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

[Documentation](https://docs.octri.dev/docs/guides/cli/overview) ·
[Pricing](https://octri.dev/pricing) ·
[Changelog](https://docs.octri.dev/changelog)

MIT licensed.
