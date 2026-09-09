// Maps files under pages/ to routes and to their place in the build.
//
//   pages/index.azox        →  /              →  index.html
//   pages/about.azox        →  /about         →  about/index.html
//   pages/blog/index.azox   →  /blog          →  blog/index.html
//   pages/blog/first.azox   →  /blog/first    →  blog/first/index.html
//
// Emitting a directory with an index.html means clean URLs work on
// any static host without rewrite rules, since serving index.html
// for a directory is universal behaviour.

import { readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PAGE_EXTENSION = '.azox';

// Directories that are never routes.
const IGNORED = new Set(['node_modules']);

export function collectRoutes(pagesDir) {
  if (!existsSync(pagesDir)) return [];

  return walk(pagesDir, pagesDir)
    .map((sourcePath) => describeRoute(pagesDir, sourcePath))
    .sort((a, b) => a.url.localeCompare(b.url));
}

function walk(dir, pagesDir) {
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...walk(full, pagesDir));
    } else if (entry.name.endsWith(PAGE_EXTENSION)) {
      found.push(full);
    }
  }

  return found;
}

function describeRoute(pagesDir, sourcePath) {
  const relativePath = relative(pagesDir, sourcePath);
  const segments = relativePath.slice(0, -PAGE_EXTENSION.length).split(sep);

  // A trailing "index" names its parent directory rather than adding
  // a segment, so blog/index.azox is /blog and not /blog/index.
  const routeSegments = segments[segments.length - 1] === 'index' ? segments.slice(0, -1) : segments;

  const url = routeSegments.length ? `/${routeSegments.join('/')}` : '/';
  const outputDir = routeSegments.join('/');

  return {
    // The name used on the command line: `azox compile --page=blog/first`
    name: segments.join('/'),
    sourcePath,
    url,
    htmlPath: outputDir ? `${outputDir}/index.html` : 'index.html',
    // Assets sit beside the page, so a nested page needs to climb
    // back out to reach the shared runtime at the build root.
    assetPrefix: '../'.repeat(routeSegments.length) || './',
    outputDir,
  };
}

export function findRoute(routes, name) {
  // Accept the route URL as well as the file name, since both read
  // naturally on the command line.
  const wanted = name.replace(/^\/+|\/+$/g, '');

  return routes.find(
    (route) => route.name === wanted || route.url === `/${wanted}` || (wanted === '' && route.url === '/')
  );
}
