// `azox help` / `azox --help` / bare `azox`
//
// Reads its content straight from the command registry so the help
// output can never fall out of step with what the CLI actually does.

import { BANNER } from '../meta.js';

export function helpCommand({ registry }) {
  const names = Object.keys(registry);
  const width = Math.max(...names.map((n) => n.length));

  console.log(BANNER);
  console.log('');
  console.log('Usage: azox <command> [options]');
  console.log('');
  console.log('Commands:');
  for (const name of names) {
    console.log(`  ${name.padEnd(width)}  ${registry[name].describe}`);
  }
  console.log('');
  console.log('Options:');
  console.log('  -v, --version  Print the Azox version');
  console.log('  -h, --help     Show this help');
  console.log('');
  console.log('Examples:');
  for (const name of names) {
    for (const example of registry[name].examples ?? []) {
      console.log(`  ${example}`);
    }
  }
}
