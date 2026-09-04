#!/usr/bin/env node

/**
 * `octri` entry point. The routing lives in `./run.js` so the deprecated
 * `octri-monitoring` binary can reuse it verbatim.
 */

import { report, run } from "./run.js";
import { cursor } from "./ui/ansi.js";
import { write } from "./ui/output.js";

process.on("SIGINT", () => {
  write(cursor.show);
  process.exit(130);
});

run(process.argv.slice(2)).catch(report);
