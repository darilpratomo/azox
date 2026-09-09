// `azox doctor` — checks that the toolchain and the current project
// are in a working state, and reports what it finds.

import { readFileSync } from 'node:fs';

import { parseAzox } from '../compiler/parser.js';
import { resolveComponents } from '../compiler/resolveComponents.js';
import { createNodeResolver } from '../nodeResolver.js';
import { listRoutes, PAGES_DIR } from '../build.js';
import { BANNER, VERSION } from '../meta.js';

const MIN_NODE_MAJOR = 18;

export function doctorCommand() {
  const projectDir = process.cwd();
  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    ok: nodeMajor >= MIN_NODE_MAJOR,
    label: `Node ${process.versions.node}`,
    detail: nodeMajor >= MIN_NODE_MAJOR ? null : `Azox needs Node ${MIN_NODE_MAJOR} or newer`,
  });

  checks.push({ ok: true, label: `Azox v${VERSION}` });

  const routes = listRoutes(projectDir);

  checks.push({
    ok: routes.length > 0,
    label: `${PAGES_DIR}/ (${routes.length} page${routes.length === 1 ? '' : 's'})`,
    detail: routes.length
      ? null
      : `No .azox pages found — run "azox create <name>" to start one`,
  });

  // Fully resolve every page — parse it and its components — so a
  // broken reference surfaces here rather than halfway through a
  // build.
  for (const route of routes) {
    try {
      resolveComponents(
        parseAzox(readFileSync(route.sourcePath, 'utf8')),
        route.sourcePath,
        createNodeResolver()
      );
      checks.push({ ok: true, label: `${route.url}`, note: `${PAGES_DIR}/${route.name}.azox` });
    } catch (error) {
      checks.push({
        ok: false,
        label: `${route.url}`,
        note: `${PAGES_DIR}/${route.name}.azox`,
        detail: error.message,
      });
    }
  }

  console.log(BANNER);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.label}${check.note ? `  (${check.note})` : ''}`);
    if (check.detail) console.log(`      ${check.detail}`);
  }
  console.log('');

  const failures = checks.filter((check) => !check.ok).length;
  if (failures) {
    console.log(`${failures} problem${failures === 1 ? '' : 's'} found.`);
    process.exitCode = 1;
  } else {
    console.log('Everything looks good.');
  }
}
