// `azox compile` — builds pages into static HTML plus hydration
// modules.
//
//   azox compile                 build every page in pages/
//   azox compile --page=about    build one page

import { relative } from 'node:path';

import { buildAll, buildPage, BuildError, BUILD_DIR } from '../build.js';
import { BANNER } from '../meta.js';

export function compileCommand({ flags }) {
  // Rooted at the user's project, not the framework checkout, so
  // `azox compile` inside a scaffolded app builds that app.
  const projectDir = process.cwd();

  try {
    const results = flags.page ? [buildPage(projectDir, flags.page)] : buildAll(projectDir);

    console.log(BANNER);
    console.log('');
    console.log(`Built ${results.length} page${results.length === 1 ? '' : 's'} to ${BUILD_DIR}/`);
    console.log('');

    const width = Math.max(...results.map((result) => result.url.length));
    for (const result of results) {
      console.log(`  ${result.url.padEnd(width)}  ${relative(projectDir, result.htmlPath)}`);
    }
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;

    console.error(`Azox: ${error.message}`);
    process.exitCode = 1;
  }
}
