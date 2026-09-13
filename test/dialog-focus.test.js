import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

// Closing an overlay with Escape used to leave focus on <body>: the
// reader pressed Escape and their place on the page was gone, with
// nothing to tab back from. Verified fixed in Chrome — the search dialog
// on three pages, opened by click and by the "/" shortcut, and the mobile
// nav at 390x780 — and both paths hand focus back to the control that
// opened them.
//
// These assert the shape of that fix rather than the behaviour, because
// the suite runs in Node against DOM stubs. They are here so deleting a
// line that the browser proved necessary fails loudly instead of
// silently regressing something no test covers.

test('closing the search dialog hands focus back to its opener', () => {
  const source = read('site/public/search.js');
  const close = /const close = \(\) => \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(close, 'close() is still a single arrow function');
  const body = close[1];

  // The field inside the overlay still holds focus, and the browser
  // blurs it as the panel hides — after our call, which would land on
  // <body>. Blurring first makes the focus below the last word.
  assert.match(
    body,
    /overlay\.contains\(document\.activeElement\)\)\s*document\.activeElement\.blur\(\)/,
    'the focused field inside the overlay is blurred first'
  );

  // Looked up again rather than reused: hydration and the router both
  // replace the header, so the node captured on open may be detached,
  // and focusing a detached element silently does nothing.
  assert.match(
    body,
    /isConnected \? returnTo : document\.querySelector\('\[data-search-open\]'\)/,
    'a detached opener falls back to the live one'
  );
  assert.match(body, /back\?\.focus\?\.\(\)/, 'and focus is handed to it');

  // Order matters: blurring after the focus call would undo it.
  assert.ok(
    body.indexOf('.blur()') < body.indexOf('back?.focus?.()'),
    'the blur comes before the focus, or it undoes it'
  );
});

test('Escape closes the search dialog', () => {
  const source = read('site/public/search.js');
  assert.match(
    source,
    /event\.key === 'Escape'[\s\S]{0,120}close\(\)/,
    'Escape reaches close()'
  );
});

test('Escape closes the mobile nav and hands focus back', () => {
  const source = read('site/public/site.js');
  const handler = /if \(event\.key === 'Escape' && nav\.dataset\.open === 'true'\) \{([\s\S]*?)\n    \}/.exec(
    source
  );
  assert.ok(handler, 'the nav still closes on Escape');

  assert.match(handler[1], /setOpen\(false\)/, 'the panel closes');
  assert.match(handler[1], /navToggle\.focus\(\)/, 'and focus returns to the button that opened it');
});
