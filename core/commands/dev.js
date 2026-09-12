// `azox dev` — builds the project, serves it, and rebuilds and
// reloads the browser whenever a source file changes.
//
//   azox dev
//   azox dev --port=5000 --host=0.0.0.0 --open

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { buildAll, BuildError, PAGES_DIR, PUBLIC_DIR, COMPONENTS_DIR, BUILD_DIR } from '../build.js';
import { createDevServer } from '../dev/server.js';
import { watchDirectory } from '../dev/watcher.js';
import { injectLiveReload } from '../dev/liveReload.js';
import { BANNER } from '../meta.js';

const DEFAULT_PORT = 4321;
const DEFAULT_HOST = 'localhost';
const MAX_PORT_ATTEMPTS = 10;

export async function devCommand({ flags }) {
  const projectDir = process.cwd();
  const pagesDir = resolve(projectDir, PAGES_DIR);

  if (!existsSync(pagesDir)) {
    console.error(`Azox: no ${PAGES_DIR}/ directory in ${projectDir}.`);
    console.error('Run "azox create <name>" to start a project.');
    process.exitCode = 1;
    return;
  }

  const host = typeof flags.host === 'string' ? flags.host : DEFAULT_HOST;
  const requestedPort = Number(flags.port) || DEFAULT_PORT;

  console.log(BANNER);
  console.log('');

  // Build once up front so the first request is served from output
  // that already exists.
  const built = rebuild(projectDir);
  if (!built.ok) reportFailure(built.error);

  const dev = createDevServer({ rootDir: resolve(projectDir, BUILD_DIR) });
  dev.setBuildError(built.ok ? null : built.error);

  let port;
  try {
    port = await listenOnFreePort(dev, requestedPort, host);
  } catch (error) {
    console.error(`Azox: could not start the dev server — ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const url = `http://${host}:${port}`;
  console.log(`  Local:   ${url}`);
  console.log(`  Pages:   ${built.ok ? built.results.length : 0}`);
  console.log('');
  console.log('  Watching for changes. Press Ctrl+C to stop.');
  console.log('');

  const onChange = (filename) => {
    const result = rebuild(projectDir);
    dev.setBuildError(result.ok ? null : result.error);

    if (result.ok) {
      console.log(`  rebuilt${filename ? ` (${filename})` : ''}`);
    } else {
      reportFailure(result.error);
    }

    // Reload either way: on failure the browser picks up the error
    // page the server renders in place of the build output.
    dev.reload();
  };

  // Everything a page is built from, not just the pages themselves.
  // Watching pages/ alone meant editing a component or a stylesheet
  // did nothing until an unrelated .azox file was touched.
  const watched = [
    { dir: pagesDir, filter: (name) => name.endsWith('.azox') },
    { dir: resolve(projectDir, COMPONENTS_DIR), filter: (name) => name.endsWith('.azox') },
    // public/ holds stylesheets, fonts and images; any of them
    // changing is worth a reload.
    { dir: resolve(projectDir, PUBLIC_DIR), filter: () => true },
    // A page can import a .json file for its content, and a dynamic
    // route builds its pages from one. Editing the data has to rebuild
    // or the new entry never appears. Not recursive: the project root
    // also holds the build output, and watching that rebuilds forever.
    {
      dir: projectDir,
      filter: (name) => name.endsWith('.json') && !name.includes('package-lock'),
      recursive: false,
    },
  ];

  const stoppers = watched
    .filter(({ dir }) => existsSync(dir))
    .map(({ dir, filter, recursive }) => watchDirectory(dir, onChange, { filter, recursive }));

  const stopWatching = () => {
    for (const stop of stoppers) stop();
  };

  const shutdown = async () => {
    stopWatching();
    await dev.close();
    console.log('\nAzox: dev server stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function rebuild(projectDir) {
  try {
    return { ok: true, results: buildAll(projectDir, { transformHtml: injectLiveReload }) };
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    return { ok: false, error };
  }
}

function reportFailure(error) {
  console.error(`  build failed: ${error.message}`);
}

// A dev server that dies because the port is taken is a bad first
// impression, so step forward until a free one is found.
async function listenOnFreePort(dev, startPort, host) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = startPort + offset;

    try {
      await new Promise((done, fail) => {
        dev.server.once('error', fail);
        dev.listen(port, host).then(() => {
          dev.server.removeListener('error', fail);
          done();
        }, fail);
      });

      if (offset > 0) console.log(`  Port ${startPort} was busy, using ${port}.`);
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }

  throw new Error(`ports ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1} are all in use`);
}
