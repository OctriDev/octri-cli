/**
 * Library entry point — the CLI's building blocks, for anything that wants to
 * script Octri from Node without shelling out (the MCP server is one such
 * consumer, and lives in `./mcp/server.js`).
 */

export * as api from "./api.js";
export { OctriClient, ApiError, login, completeMfa } from "./client.js";
export {
  resolve,
  readProfile,
  updateProfile,
  normalizeApiUrl,
  type Profile,
  type Resolved,
} from "./config.js";
export { extract, extractTar, extractTarGz, extractZip } from "./archive.js";
export { parse, type ParsedArgs } from "./args.js";
export { run, report } from "./run.js";
export { serve as serveMcp, type ServeOptions } from "./mcp/server.js";
export {
  uploadSourceMaps,
  uploadSourceFiles,
  gitRelease,
  SOURCE_EXTENSIONS,
  type UploadOptions,
  type UploadResult,
  type SourceUploadOptions,
  type SourceUploadResult,
} from "./monitoring/upload.js";
