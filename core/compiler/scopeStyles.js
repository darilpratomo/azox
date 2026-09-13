// Scoped styles: a component's CSS applies to that component's markup
// and nothing else.
//
// The mechanism is the one most frameworks settled on, because it needs
// no runtime: every element the component owns gets an attribute, and
// every selector in its <style> block is rewritten to require that
// attribute. The result is plain CSS a browser can parse — no shadow
// DOM, no class-name mangling, nothing to ship.
//
// This file has no Node built-ins on purpose: it runs in the browser
// playground like the rest of the compiler.

// A short, stable id from the component's path. Not cryptographic — it
// only has to be stable across builds and unlikely to collide between
// the files of one project.
export function scopeId(path) {
  let hash = 0;

  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) | 0;
  }

  return `a${(hash >>> 0).toString(36).slice(0, 6)}`;
}

export const scopeAttribute = (id) => `data-azox-${id}`;

// At-rules whose body is more CSS, so the selectors inside them need
// rewriting too — a rule in a @media block still belongs to the
// component.
const NESTED_AT_RULES = /^@(media|supports|container|layer)\b/;

// At-rules that contain no selectors. @keyframes names its steps `from`
// and `50%`, and scoping those would break the animation.
const OPAQUE_AT_RULES =
  /^@(keyframes|-\w+-keyframes|font-face|import|charset|namespace|property)\b/;

/**
 * Rewrites every selector in `css` to require the scope attribute.
 *
 *   .title { … }        →  .title[data-azox-a1b2c3] { … }
 *   .a, .b { … }        →  .a[data-azox-a1b2c3], .b[data-azox-a1b2c3] { … }
 *   :global(.x) { … }   →  .x { … }
 */
export function scopeCss(css, id) {
  return rewriteBlock(css, `[${scopeAttribute(id)}]`);
}

function rewriteBlock(css, attr) {
  let out = '';
  let i = 0;

  while (i < css.length) {
    const open = css.indexOf('{', i);

    // Trailing text with no rule after it: a stray comment, or nothing.
    if (open === -1) {
      out += css.slice(i);
      break;
    }

    const prelude = css.slice(i, open);
    const close = matchingBrace(css, open);
    const body = css.slice(open + 1, close);
    const trimmed = prelude.trim();

    if (OPAQUE_AT_RULES.test(trimmed)) {
      // Kept whole: its body is not selectors.
      out += `${prelude}{${body}}`;
    } else if (NESTED_AT_RULES.test(trimmed)) {
      // The condition stays; what is inside it is scoped.
      out += `${prelude}{${rewriteBlock(body, attr)}}`;
    } else {
      out += `${scopeSelectorList(prelude, attr)}{${body}}`;
    }

    i = close + 1;
  }

  return out;
}

// Finds the brace closing the one at `open`, so a @media body is taken
// whole rather than cut at its first inner rule.
function matchingBrace(css, open) {
  let depth = 0;

  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }

  return css.length;
}

// A placeholder for a comment while the selector list is split on
// commas. Printable on purpose: a control character would be invisible
// in any output that quotes this source.
const COMMENT_MARK = (n) => `/*__azox${n}__*/`;

function scopeSelectorList(prelude, attr) {
  // Comments carry no selectors and may contain commas.
  const comments = [];
  const stripped = prelude.replace(/\/\*[\s\S]*?\*\//g, (comment) => {
    comments.push(comment);
    return COMMENT_MARK(comments.length - 1);
  });

  const scoped = stripped
    .split(',')
    .map((selector) => scopeSelector(selector, attr))
    .join(',');

  return scoped.replace(/\/\*__azox(\d+)__\*\//g, (_, n) => comments[Number(n)]);
}

function scopeSelector(selector, attr) {
  const trimmed = selector.trim();
  if (!trimmed) return selector;

  // An escape hatch for the times a component must reach outside
  // itself — a body class, or markup it renders into a portal.
  const global = trimmed.match(/^:global\(([\s\S]*)\)$/);
  if (global) return selector.replace(trimmed, global[1].trim());

  const leading = selector.slice(0, selector.length - selector.trimStart().length);
  const trailing = selector.slice(selector.trimEnd().length);

  // The attribute goes on the last compound of the selector, so
  // `.card .title` scopes the element actually being styled rather than
  // its ancestor. Combinators are left where they are.
  const parts = trimmed.split(/(\s+|\s*[>+~]\s*)/);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].trim() || /^[>+~\s]+$/.test(parts[i])) continue;
    parts[i] = attachAttribute(parts[i], attr);
    break;
  }

  return leading + parts.join('') + trailing;
}

// Placed before any pseudo-element or pseudo-class: `.a[attr]:hover` is
// what was meant, and `.a:hover[attr]` would not match a browser's
// reading of it.
function attachAttribute(compound, attr) {
  const pseudo = compound.search(/::?[a-z-]/i);
  if (pseudo === -1) return compound + attr;

  return compound.slice(0, pseudo) + attr + compound.slice(pseudo);
}
