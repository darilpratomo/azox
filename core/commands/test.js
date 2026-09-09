// `azox test` — sanity check that the CLI engine boots correctly,
// then proves the compiler pipeline works end to end by compiling
// the default page.

import { compileCommand } from './compile.js';

export function testCommand(context) {
  console.log('Azox Framework v0.0.1 - The Sound of Future Web');
  compileCommand(context ?? { flags: {} });
}
