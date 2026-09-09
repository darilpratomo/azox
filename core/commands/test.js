// `azox test` — end-to-end check that the toolchain works: parses,
// server-renders and compiles the default page. Delegates to
// `compile`, which prints the banner and the emitted paths.

import { compileCommand } from './compile.js';

export function testCommand(context) {
  compileCommand(context);
}
