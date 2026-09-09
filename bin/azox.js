#!/usr/bin/env node

// Azox CLI entry point. Kept thin on purpose — it just reads argv
// and delegates to the engine in core/.

import { parseArgs } from '../core/cli/parseArgs.js';
import { runCommand } from '../core/cli/router.js';

const { command, positionals, flags } = parseArgs(process.argv.slice(2));

try {
  await runCommand(command, { positionals, flags });
} catch (error) {
  // Anything reaching here is a bug rather than user error, so keep
  // the stack: it's what makes the report actionable.
  console.error(`Azox: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
