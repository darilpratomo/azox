// Minimal terminal argument parser. No Commander, no Yargs —
// keeping the CLI dependency-free is part of the point.
//
// Usage: azox <command> [--flag] [-f] [--key=value] [positional...]
//
// Short flags are single-dash, single-letter (-v). Grouping like -abc
// is deliberately not supported: it buys little for a framework CLI
// and makes error messages harder to read.
//
// Returns:
//   { command, positionals, flags }

const isFlag = (arg) => arg.startsWith('-');

export function parseArgs(argv) {
  const command = argv.length > 0 && !isFlag(argv[0]) ? argv[0] : null;
  const rest = command ? argv.slice(1) : argv;

  const positionals = [];
  const flags = {};

  for (const arg of rest) {
    if (!isFlag(arg)) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
    const eqIndex = raw.indexOf('=');

    if (eqIndex === -1) {
      flags[raw] = true; // e.g. --watch, -v
    } else {
      flags[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1); // e.g. --port=3000
    }
  }

  return { command, positionals, flags };
}
