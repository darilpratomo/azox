// Maps files under pages/ to routes and to their place in the build.
//
//   pages/index.azox        →  /              →  index.html
//   pages/about.azox        →  /about         →  about/index.html
//   pages/blog/index.azox   →  /blog          →  blog/index.html
//   pages/blog/first.azox   →  /blog/first    →  blog/first/index.html
//
// A segment in brackets is a parameter, and the file is a template
// rather than a route of its own:
//
//   pages/blog/[slug].azox  →  one page per entry the file declares
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

// A bracketed segment names a parameter: [slug] matches one segment
// and binds it to `slug`.
const PARAM_SEGMENT = /^\[([A-Za-z_$][\w$]*)\]$/;

export function paramNames(segments) {
  return segments.map((segment) => segment.match(PARAM_SEGMENT)?.[1]).filter(Boolean);
}

// Fills a template's bracketed segments from a set of parameter
// values, producing the concrete route that will be written.
export function resolveRoute(route, values) {
  const segments = route.templateSegments.map((segment) => {
    const name = segment.match(PARAM_SEGMENT)?.[1];
    if (!name) return segment;
    return String(values[name]);
  });

  const url = segments.length ? `/${segments.join('/')}` : '/';
  const outputDir = segments.join('/');

  return {
    ...route,
    params: values,
    isTemplate: false,
    name: segments.join('/'),
    url,
    htmlPath: outputDir ? `${outputDir}/index.html` : 'index.html',
    assetPrefix: '../'.repeat(segments.length) || './',
    outputDir,
  };
}

function describeRoute(pagesDir, sourcePath) {
  const relativePath = relative(pagesDir, sourcePath);
  const segments = relativePath.slice(0, -PAGE_EXTENSION.length).split(sep);

  // A trailing "index" names its parent directory rather than adding
  // a segment, so blog/index.azox is /blog and not /blog/index.
  const routeSegments = segments[segments.length - 1] === 'index' ? segments.slice(0, -1) : segments;

  const url = routeSegments.length ? `/${routeSegments.join('/')}` : '/';
  const outputDir = routeSegments.join('/');

  const params = paramNames(routeSegments);

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
    // A template is not a page: it stands in for however many the
    // file declares, and is never written at this url.
    isTemplate: params.length > 0,
    paramNames: params,
    templateSegments: routeSegments,
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
