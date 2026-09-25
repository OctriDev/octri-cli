/**
 * The CLI's own version, read from the manifest rather than duplicated here, so
 * `octri --version`, the MCP handshake and the published version can never
 * disagree. npm always ships package.json, and `dist/version.js` sits one
 * directory below it.
 */

import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const manifest = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    return (JSON.parse(manifest) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const CLI_VERSION = readVersion();
