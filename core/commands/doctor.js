// `azox doctor` — checks that the toolchain and the current project
// are in a working state, and reports what it finds.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseAzox } from '../compiler/parser.js';
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

  const pagesDir = resolve(projectDir, 'pages');
  const pages = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((file) => file.endsWith('.azox'))
    : [];

  checks.push({
    ok: pages.length > 0,
    label: `pages/ (${pages.length} page${pages.length === 1 ? '' : 's'})`,
    detail: pages.length ? null : 'No .azox pages found — run "azox create <name>" to start one',
  });

  // Parse every page so a syntax error surfaces here rather than
  // halfway through a build.
  for (const page of pages) {
    try {
      parseAzox(readFileSync(resolve(pagesDir, page), 'utf8'));
      checks.push({ ok: true, label: `pages/${page}` });
    } catch (error) {
      checks.push({ ok: false, label: `pages/${page}`, detail: error.message });
    }
  }

  console.log(BANNER);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.label}`);
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

