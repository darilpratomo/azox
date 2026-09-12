// Builds the docs search index from the pages themselves.
//
// Read from the .azox sources rather than the built HTML, so the index
// exists before the build that would consume it — and so a heading is
// found by its tag rather than by guessing at rendered markup.
//
// The result is one JSON file the browser fetches once. At this size a
// linear scan in the page is faster than any index structure would be,
// and it needs no server.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(SITE_DIR, 'pages/docs');

// Markup that is not prose: a code sample is indexed separately and at
// a lower weight, since matching "const" in an example is rarely what
// someone meant.
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ');

const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const tidy = (text) => decode(stripTags(text)).replace(/\s+/g, ' ').trim();

// An anchor a heading can be linked to. The docs do not carry ids, so
// one is derived the way most documentation tools do.
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

// The API names a section is about, taken from the code it shows.
//
// A heading is written for a reader — "Two-way inputs" — while the
// thing being searched for is the syntax: bind:. Without this, typing
// "bind" found ten pages that mention binding and not the one section
// that explains it.
function keywordsIn(block) {
  const found = new Set();

  for (const match of block.matchAll(/\b(bind|on):[a-z]+/g)) found.add(match[1] + ':');
  // <text> and <script> wrap every sample on the site, so they appear
  // in almost every section and say nothing about what it is about.
  for (const match of block.matchAll(/<(each|if|else|slot)\b/g)) found.add('<' + match[1] + '>');
  for (const match of block.matchAll(/\b(signal|effect|computed|onMount|onCleanup|dispose|untracked|props|params|routes)\s*\(/g)) {
    found.add(match[1]);
  }
  for (const match of block.matchAll(/\bazox\s+(create|dev|compile|doctor|version|help)\b/g)) {
    found.add('azox ' + match[1]);
  }

  return [...found];
}

function sectionsOf(source, url, pageTitle) {
  // The page's own frontmatter: metadata and imports, not prose. Both
  // were landing in the first result's excerpt.
  const body = source
    .replace(/<head>[\s\S]*?<\/head>/g, ' ')
    .replace(/^<script>[\s\S]*?<\/script>/m, ' ');

  // Samples are kept here so keywords can be read from them, and
  // dropped from `prose` so they never become an excerpt.
  const prose = body.replace(/<CodeBlock[\s\S]*?<\/CodeBlock>/g, ' ');

  const sections = [];
  const headings = [...prose.matchAll(/<(h2|h3)[^>]*>([\s\S]*?)<\/\1>/g)];
  const bodyHeadings = [...body.matchAll(/<(h2|h3)[^>]*>([\s\S]*?)<\/\1>/g)];

  // Keywords come from the full text of a section, samples included,
  // matched to the same heading by position.
  const keywordsFor = (i) => {
    const from = bodyHeadings[i]?.index ?? 0;
    const to = bodyHeadings[i + 1]?.index ?? body.length;
    return keywordsIn(body.slice(from, to));
  };

  // Text before the first h2 belongs to the page itself.
  const lede = tidy(prose.slice(0, headings[0]?.index ?? prose.length));
  if (lede) {
    sections.push({ url, title: pageTitle, heading: null, text: lede.slice(0, 600) });
  }

  for (const [i, match] of headings.entries()) {
    const heading = tidy(match[2]);
    if (!heading) continue;

    const from = match.index + match[0].length;
    const to = headings[i + 1]?.index ?? prose.length;

    sections.push({
      url: `${url}#${slugify(heading)}`,
      title: pageTitle,
      heading,
      // 2 or 3: a parent section is a better landing place than one of
      // its own subsections when both match equally well.
      level: match[1] === 'h2' ? 2 : 3,
      text: tidy(prose.slice(from, to)).slice(0, 600),
      keywords: keywordsFor(i),
    });
  }

  return sections;
}

const entries = [];

for (const file of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.azox'))) {
  const source = readFileSync(resolve(DOCS_DIR, file), 'utf8');
  const name = basename(file, '.azox');
  const url = name === 'index' ? '/docs' : `/docs/${name}`;

  const title = tidy(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? name);
  entries.push(...sectionsOf(source, url, title));
}

// Sorted so the output is stable between builds and a diff is readable.
entries.sort((a, b) => a.url.localeCompare(b.url));

writeFileSync(resolve(SITE_DIR, 'public/search-index.json'), JSON.stringify(entries));

const bytes = readFileSync(resolve(SITE_DIR, 'public/search-index.json')).length;
console.log(`search-index.json: ${entries.length} sections, ${(bytes / 1024).toFixed(1)} KB`);
