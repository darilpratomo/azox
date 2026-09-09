// Maps a command name to its handler. Register new commands here —
// bin/azox.js never needs to change.

import { testCommand } from '../commands/test.js';
import { compileCommand } from '../commands/compile.js';

const registry = {
  test: testCommand,
  compile: compileCommand,
};

export function runCommand(command, context) {
  if (!command) {
    console.log('Azox Framework v0.0.1 - The Sound of Future Web');
    console.log('Usage: azox <command>   (e.g. azox test)');
    return;
  }

  const handler = registry[command];

  if (!handler) {
    console.error(`Azox: unknown command "${command}".`);
    console.error(`Available commands: ${Object.keys(registry).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  handler(context);
}
