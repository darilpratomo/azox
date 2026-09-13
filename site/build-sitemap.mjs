// Generates sitemap.xml and robots.txt from the pages that exist, so
// neither can list a route that was renamed or removed.

import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(SITE_DIR, 'pages');
const ORIGIN = 'https://azox.dev';

// The same rule the router uses: a file becomes a directory URL, and
// index.azox names its parent rather than adding a segment.
const walk = (dir, prefix = '') => {
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...walk(full, `${prefix}/${entry.name}`));
    } else if (entry.name.endsWith('.azox')) {
      const name = basename(entry.name, '.azox');
      found.push({
        url: name === 'index' ? prefix || '/' : `${prefix}/${name}`,
        changed: statSync(full).mtime.toISOString().slice(0, 10),
      });
    }
  }

  return found;
};

const routes = walk(PAGES).sort((a, b) => a.url.localeCompare(b.url));

// The home page matters most, the docs next, everything else after.
const priority = (url) => (url === '/' ? '1.0' : url.startsWith('/docs') ? '0.8' : '0.6');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (r) =>
      `  <url>\n    <loc>${ORIGIN}${r.url}</loc>\n    <lastmod>${r.changed}</lastmod>\n    <priority>${priority(r.url)}</priority>\n  </url>`
  )
  .join('\n')}
</urlset>
`;

writeFileSync(resolve(SITE_DIR, 'public/sitemap.xml'), sitemap);
writeFileSync(
  resolve(SITE_DIR, 'public/robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`
);

console.log(`sitemap.xml: ${routes.length} routes, robots.txt written`);
