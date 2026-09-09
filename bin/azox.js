#!/usr/bin/env node

// Azox CLI entry point. Kept thin on purpose — it just reads argv
// and delegates to the engine in core/.

import { parseArgs } from '../core/cli/parseArgs.js';
import { runCommand } from '../core/cli/router.js';

const { command, positionals, flags } = parseArgs(process.argv.slice(2));

runCommand(command, { positionals, flags });
