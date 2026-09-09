// Parses a .azox source file into a small AST. Deliberately not
// JSX: no React-flavored syntax, just HTML with {expr} interpolation
// and on:event bindings. This stays simple because the compiler's
// job is narrow — turn markup + bindings into signal-driven DOM ops.

import { BuildError } from '../buildError.js';
import { VOID_TAGS } from './html.js';

// Extends BuildError so a malformed page is reported as the user's
// problem, not as an Azox crash.
export class ParseError extends BuildError {}

// A capitalised tag is a component, the way a lowercase one is an
// HTML element. That keeps the distinction visible in the markup
// itself, with no separate registration step.
const isComponentName = (name) => /^[A-Z]/.test(name);

export function parseAzox(source) {
  const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);
  const script = scriptMatch ? scriptMatch[1].trim() : '';

  // An optional <head> block is copied into the document head
  // verbatim: stylesheets, meta tags, fonts. It is markup for the
  // document, not for the page body, so it skips the AST entirely.
  const headMatch = source.match(/<head>([\s\S]*?)<\/head>/);
  const head = headMatch ? headMatch[1].trim() : '';

  const template = source
    .replace(/<script>[\s\S]*?<\/script>/, '')
    .replace(/<head>[\s\S]*?<\/head>/, '')
    .trim();

  const tokens = tokenize(template);
  const { node, rest } = parseNode(tokens);
  if (rest.length) {
    throw new ParseError(`Azox parse error: unexpected trailing markup near "${rest[0]?.value ?? ''}"`);
  }

  return {
    script,
    head,
    markup: node,
    components: parseComponentImports(script),
    props: parsePropNames(script),
  };
}

// Component imports are written as ordinary import statements, so an
// editor treats them like any other module reference:
//   import Card from '../components/Card.azox';
function parseComponentImports(script) {
  const imports = {};
  const regex = /import\s+([A-Z]\w*)\s+from\s+['"]([^'"]+\.azox)['"]\s*;?/g;

  let match;
  while ((match = regex.exec(script))) {
    imports[match[1]] = match[2];
  }

  return imports;
}

// `const { title, count } = props();` declares what a component
// accepts. Declaring them explicitly lets the compiler reject a
// caller that passes something the component never asked for.
function parsePropNames(script) {
  const match = script.match(/const\s*\{([^}]*)\}\s*=\s*props\(\)/);
  if (!match) return [];

  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function tokenize(html) {
  const tokens = [];
  let i = 0;

  while (i < html.length) {
    if (html[i] === '<') {
      // <text> holds literal content: no tags, no {interpolation}.
      // Without it there is no way to show markup or braces on a
      // page, which documentation for this framework obviously needs.
      if (html.startsWith('<text>', i)) {
        const close = html.indexOf('</text>', i);
        if (close === -1) throw new ParseError('Azox parse error: <text> is never closed');

        tokens.push({ type: 'raw', value: html.slice(i + '<text>'.length, close) });
        i = close + '</text>'.length;
        continue;
      }

      const isClose = html[i + 1] === '/';
      const end = findTagEnd(html, i);
      const raw = html.slice(i + (isClose ? 2 : 1), end).trim();

      if (isClose) {
        tokens.push({ type: 'close', name: raw });
      } else {
        const selfClosing = raw.endsWith('/');
        const body = selfClosing ? raw.slice(0, -1).trim() : raw;
        const [name, ...attrParts] = splitTag(body);
        tokens.push({
          type: 'open',
          name,
          attrs: parseAttrs(attrParts.join(' ')),
          selfClosing: selfClosing || VOID_TAGS.has(name),
        });
      }
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      const text = html.slice(i, next === -1 ? undefined : next);
      if (text.trim().length) tokens.push({ type: 'text', value: text.trim() });
      i = next === -1 ? html.length : next;
    }
  }

  return tokens;
}

// Finds the ">" that actually closes a tag, ignoring any ">" inside
// a {expr} attribute value (arrow functions) or inside a string.
function findTagEnd(html, start) {
  let depth = 0;
  let quote = null;

  for (let i = start; i < html.length; i++) {
    const char = html[i];

    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (depth > 0 && (char === '"' || char === "'" || char === '`')) quote = char;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '>' && depth === 0) return i;
  }

  throw new ParseError('Azox parse error: unterminated tag');
}

// Splits a tag body into its name and attribute chunks, keeping any
// whitespace that falls inside an expression or a quoted value.
function splitTag(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (quote) {
      current += char;
      if (char === '\\') current += body[++i] ?? '';
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '{') depth++;
    else if (char === '}') depth--;

    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) parts.push(current);
  return parts;
}

// Scanned rather than matched with a regex: an expression can nest
// braces (an object literal, a template literal), and no regex can
// pair those. Getting this wrong silently truncates the expression.
function parseAttrs(attrString) {
  const attrs = {};
  let i = 0;

  while (i < attrString.length) {
    if (/\s/.test(attrString[i])) {
      i++;
      continue;
    }

    const nameEnd = findAttrNameEnd(attrString, i);
    const name = attrString.slice(i, nameEnd);

    if (!name) {
      i++;
      continue;
    }

    // A bare attribute with no value, e.g. `disabled`.
    if (attrString[nameEnd] !== '=') {
      attrs[name] = { kind: 'static', value: '' };
      i = nameEnd;
      continue;
    }

    const valueStart = nameEnd + 1;
    const quote = attrString[valueStart];

    if (quote === '"' || quote === "'") {
      const end = attrString.indexOf(quote, valueStart + 1);
      if (end === -1) {
        throw new ParseError(`Azox parse error: unterminated value for attribute "${name}"`);
      }
      attrs[name] = { kind: 'static', value: attrString.slice(valueStart + 1, end) };
      i = end + 1;
      continue;
    }

    if (quote === '{') {
      const end = findExpressionEnd(attrString, valueStart, `the {expression} for "${name}"`);
      attrs[name] = { kind: 'expr', expr: attrString.slice(valueStart + 1, end).trim() };
      i = end + 1;
      continue;
    }

    throw new ParseError(
      `Azox parse error: attribute "${name}" needs a quoted value or a {expression}`
    );
  }

  return attrs;
}

function findAttrNameEnd(source, start) {
  let i = start;
  while (i < source.length && /[\w:.@-]/.test(source[i])) i++;
  return i;
}

// Walks from the opening brace to its match, tracking nesting depth
// and skipping over string and template literals so a brace inside
// quotes never ends the expression.
function findExpressionEnd(source, start, describe) {
  let depth = 0;
  let quote = null;

  for (let i = start; i < source.length; i++) {
    const char = source[i];

    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new ParseError(`Azox parse error: ${describe} is never closed`);
}

function parseNode(tokens) {
  const [token, ...rest] = tokens;

  if (!token) return { node: null, rest: [] };

  // Literal content from <text>: one static part, never interpolated.
  if (token.type === 'raw') {
    return { node: { type: 'text', parts: [{ kind: 'literal', value: token.value }] }, rest };
  }

  if (token.type === 'text') {
    return { node: { type: 'text', parts: splitInterpolation(token.value) }, rest };
  }

  if (token.type === 'open') {
    const { name, attrs, selfClosing } = token;
    const type = isComponentName(name) ? 'component' : 'element';

    if (selfClosing) {
      return { node: { type, name, attrs, children: [] }, rest };
    }

    const children = [];
    let remaining = rest;
    while (remaining.length && !(remaining[0].type === 'close' && remaining[0].name === name)) {
      const result = parseNode(remaining);
      if (result.node) children.push(result.node);
      remaining = result.rest;
    }

    if (!remaining.length) {
      throw new ParseError(`Azox parse error: <${name}> is never closed`);
    }

    remaining = remaining.slice(1); // drop the matching close tag

    return { node: { type, name, attrs, children }, rest: remaining };
  }

  return { node: null, rest };
}

// Splits "Clicks: {count()}" into
// [{kind:'static', value:'Clicks: '}, {kind:'expr', expr:'count()'}]
//
// Uses the same brace-depth scan as attributes, so an interpolated
// expression may contain nested braces and strings.
function splitInterpolation(text) {
  const parts = [];
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf('{', i);

    if (start === -1) {
      parts.push({ kind: 'static', value: text.slice(i) });
      break;
    }

    if (start > i) parts.push({ kind: 'static', value: text.slice(i, start) });

    const end = findExpressionEnd(text, start, 'an interpolated {expression}');
    parts.push({ kind: 'expr', expr: text.slice(start + 1, end).trim() });
    i = end + 1;
  }

  return parts;
}
