# Changelog

## 1.0.7

Commands, and matching MCP tools, for what Octri shipped since 1.0.6. All of
them run on a signed-in session (`octri auth login`); an API key is refused.

- `octri mcp permissions`, `usage`, `calls` and `package`: the project's own
  MCP server. Set a tool to `auto`, `confirm` or `off` and mark it destructive;
  the change reaches agents at once and never overwrites a teammate's publish.
  Read calls per tool and the live call feed. Download the npm package that
  ships the server under your name, or publish it to your linked npm account.
- `octri docs redirects`, `docs home` and `docs buttons`. Redirects and the home
  page are drafted and go live with `octri docs nav publish`; nav buttons apply
  on save, as in the API Studio.
- `octri docs components`: list, show, push and remove custom components. `push`
  creates or updates by name, so a folder of components can be pushed from CI.
- `octri docs endpoints`: draft new endpoints or mark existing ones for removal,
  then `publish` writes them into the spec as a new version.
- `octri webhooks`: create, update, test, inspect deliveries of, and delete
  project webhooks. The signing secret prints once, on create.
- `octri specs convert`: import a report exported from the spec converter, and
  download the report behind a converted spec.
- `octri github docs`: list the connected repo's MDX and Markdown, pull them to
  disk, and turn docs sync on push on or off.
- `octri sdk quickstart`: mark the endpoint every SDK README leads with.
- `octri sdk audit source`: the spec text the auditor scores, to a file or
  stdout.
- `octri sdk artifacts` prints each artifact's permanent share link.
- The MCP server gains 36 tools for the above, 69 in all.
- `--version 2.0.0` reaches the command that takes it (`sdk build`,
  `sdk settings set`, `lab run`, `mcp package publish`). It used to print the
  CLI's own version and exit, so only `--version=2.0.0` worked. A bare
  `octri --version` still prints the CLI's version. Publishing the MCP package needs
  `--allow-publish`; deleting a component or webhook needs `--allow-delete`.

## 1.0.6

- The CLI and `octri mcp serve` honour `HTTPS_PROXY`, `HTTP_PROXY` and
  `NO_PROXY` (either case). Node's built-in fetch ignores them unless
  `NODE_USE_ENV_PROXY=1` is set, and older Node releases (22.11, for one)
  ignore them even then, so a CI runner that only reaches the internet through
  a proxy timed out. Requests now go through undici's proxy agent whenever one
  of the proxy variables is set; without one nothing changes and undici is not
  loaded. Tested on Node 20.0, 20.20, 22.11, 22.23, 24.21 and 26.11.
- `server.json` lists `HTTPS_PROXY` and `NO_PROXY`, since MCP clients start
  servers with a minimal environment and rarely pass a shell's proxy through.
- Network errors name the cause (a refused connection, a DNS miss, a proxy's
  407) instead of a bare `fetch failed`.

## 1.0.5

- The MCP server's generated-file tools (`octri_list_generated_files`,
  `octri_read_generated_file`, `octri_diff_builds`, `octri_fetch_artifacts`)
  only accept ids the API issues and language ids, and never read outside the
  local artifact cache. A `build_id` such as `../../..` used to list and read any
  file your user could, `~/.octri/config.json` included, and an agent can be
  steered into sending one by text it has read.
- Signs in against the API's `__Host-` session cookies, and still works with
  APIs that send the older names.

## 1.0.4

- The MCP server (`octri mcp serve`) reports the CLI's real version in its
  handshake. It said `0.1.0` in every release, so MCP clients showed the wrong
  version. `octri --version` was already right, and both now read the same
  value from `package.json`.

## 1.0.3

- Listed in the official MCP Registry as `dev.octri/cli`. `package.json` carries
  the `mcpName` the registry checks ownership against, and `server.json`
  describes `octri mcp serve` and its environment variables for clients that
  install from the registry. No change to the CLI itself.

## 1.0.2

- Artifact extraction has a budget: 512 MB expanded, 20,000 entries, with zlib
  held to the same ceiling. A hostile or corrupt archive used to be able to
  fill the disk.
- `__proto__`, `constructor` and `prototype` are refused as profile names, and
  the profile map no longer inherits from `Object.prototype`.
- Plaintext HTTP to anything but this machine is refused, since every request
  carries a session JWT or an API key. Set `OCTRI_ALLOW_INSECURE_HTTP=1` for an
  internal proxy.

## 1.0.1

- Documentation pass over the command surface.

## 1.0.0

First public release.

- Specs, SDK builds, artifacts, docs, monitoring and lab runs from a terminal.
- An MCP server exposing the same surface to an agent.
