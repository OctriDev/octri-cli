# Changelog

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
