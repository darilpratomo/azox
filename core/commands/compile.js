// `azox compile` — builds pages into static HTML plus hydration
// modules.
//
//   azox compile                 build every page in pages/
//   azox compile --page=about    build one page

import { relative } from 'node:path';

import { buildAll, buildPage, BuildError } from '../build.js';
import { BANNER } from '../meta.js';

export function compileCommand({ flags }) {
  // Rooted at the user's project, not the framework checkout, so
  // `azox compile` inside a scaffolded app builds that app.
  const projectDir = process.cwd();

  try {
    const results = flags.page
      ? [buildPage(projectDir, flags.page)]
      : buildAll(projectDir);

    console.log(BANNER);
    for (const result of results) {
      console.log(`Compiled ${relative(projectDir, result.sourcePath)} ->`);
      for (const path of [result.htmlPath, result.clientPath, result.runtimePath]) {
        console.log(`  ${relative(projectDir, path)}`);
      }
    }
  } catch (error) {
    if (!(error instanceof BuildError) && !/Azox parse error/.test(error.message)) throw error;

    console.error(`Azox: ${error.message}`);
    process.exitCode = 1;
  }
}
