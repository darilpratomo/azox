// Minimal terminal argument parser. No Commander, no Yargs —
// keeping the CLI dependency-free is part of the point.
//
// Usage: azox <command> [--flag] [--key=value] [positional...]
//
// Returns:
//   { command, positionals, flags }

export function parseArgs(argv) {
  const command = argv.length > 0 && !argv[0].startsWith('--') ? argv[0] : null;
  const rest = command ? argv.slice(1) : argv;

  const positionals = [];
  const flags = {};

  for (const arg of rest) {
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eqIndex = raw.indexOf('=');

    if (eqIndex === -1) {
      flags[raw] = true; // e.g. --watch
    } else {
      flags[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1); // e.g. --port=3000
    }
  }

  return { command, positionals, flags };
}
