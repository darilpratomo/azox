// The command registry is the single source of truth: each entry
// carries its handler, its one-line description, and example usage.
// `azox help` renders itself from this, so adding a command here is
// enough to make it discoverable.

import { doctorCommand } from '../commands/doctor.js';
import { compileCommand } from '../commands/compile.js';
import { devCommand } from '../commands/dev.js';
import { versionCommand } from '../commands/version.js';
import { createCommand } from '../commands/create.js';
import { helpCommand } from '../commands/help.js';

export const registry = {
  create: {
    run: createCommand,
    describe: 'Scaffold a new Azox project',
    examples: ['azox create my-app'],
  },
  dev: {
    run: devCommand,
    describe: 'Serve the project and rebuild on every change',
    examples: ['azox dev', 'azox dev --port=5000'],
  },
  compile: {
    run: compileCommand,
    describe: 'Compile pages to HTML + hydration modules',
    examples: ['azox compile', 'azox compile --page=about'],
  },
  doctor: {
    run: doctorCommand,
    describe: 'Check that the toolchain and project are healthy',
    examples: ['azox doctor'],
  },
  version: {
    run: versionCommand,
    describe: 'Print the Azox version',
    examples: ['azox -v'],
  },
  help: {
    run: helpCommand,
    describe: 'Show this help',
    examples: ['azox help'],
  },
};

// Flags that stand in for a command, so `azox -v` works like
// `azox version` without making every command parse them.
const FLAG_ALIASES = {
  v: 'version',
  version: 'version',
  h: 'help',
  help: 'help',
};

// Returns whatever the handler returns, so an async command (dev)
// can be awaited by the entry point.
export function runCommand(command, context) {
  const resolved = command ?? aliasFor(context.flags) ?? 'help';
  const entry = registry[resolved];

  if (!entry) {
    console.error(`Azox: unknown command "${resolved}".`);
    console.error(`Run "azox help" to see available commands.`);
    process.exitCode = 1;
    return;
  }

  return entry.run({ ...context, registry });
}

function aliasFor(flags) {
  for (const [flag, command] of Object.entries(FLAG_ALIASES)) {
    if (flags[flag]) return command;
  }
  return null;
}
