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
      // An HTML comment is skipped outright. Treating it as a tag
      // would fail on the "--" and report a confusing error about an
      // element that was never written.
      if (html.startsWith('<!--', i)) {
        const close = html.indexOf('-->', i);
        if (close === -1) throw new ParseError('Azox parse error: a comment is never closed');

        i = close + '-->'.length;
        continue;
      }

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
      const collapsed = collapseWhitespace(text);
      if (collapsed) tokens.push({ type: 'text', value: collapsed });
      i = next === -1 ? html.length : next;
    }
  }

  return trimEdgeWhitespace(tokens);
}

// Removes the space that sits immediately inside an element — right
// after its opening tag, or right before its closing one. Nothing sits
// on the other side of it to be kept apart, so it is indentation
// rather than a real space, and keeping it would pad an element's text
// content for no visible benefit.
function trimEdgeWhitespace(tokens) {
  const out = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type !== 'text') {
      out.push(token);
      continue;
    }

    const before = tokens[i - 1];
    const after = tokens[i + 1];

    let value = token.value;
    if (!before || before.type === 'open') value = value.replace(/^ /, '');
    if (!after || after.type === 'close') value = value.replace(/ $/, '');

    if (value) out.push({ ...token, value });
  }

  return out;
}

// Collapses runs of whitespace to a single space, the way HTML does,
// and drops text that is only whitespace between block-level tags.
//
// Trimming the edges outright — which this used to do — deletes the
// space in "Read <a>this</a> for more", running the words together.
// Keeping one space preserves the sentence while still discarding
// the indentation between elements on their own lines.
function collapseWhitespace(text) {
  if (!text.trim()) {
    // Whitespace containing a newline is layout indentation between
    // elements; a space on one line is a real space between them.
    return text.includes('\n') ? '' : ' ';
  }

  return text.replace(/\s+/g, ' ');
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

// <each> and <if> are control flow rather than markup, so they become
// their own node types. Everything else is an element or a component.
function nodeTypeFor(name) {
  if (name === 'each') return 'each';
  if (name === 'if') return 'if';
  if (name === 'else') return 'else';
  return isComponentName(name) ? 'component' : 'element';
}

// <each item={list()} as="thing"> — `as` names the loop variable so
// the body can refer to it, the way a parameter names an argument.
function buildEach(attrs, children) {
  const list = attrs.item ?? attrs.of;

  if (!list || list.kind !== 'expr') {
    throw new ParseError(
      'Azox parse error: <each> needs item={...} — for example <each item={todos()} as="todo">'
    );
  }

  const alias = attrs.as;

  if (!alias || alias.kind !== 'static' || !/^[A-Za-z_$][\w$]*$/.test(alias.value)) {
    throw new ParseError(
      'Azox parse error: <each> needs as="name", where name is a plain identifier'
    );
  }

  // An optional index, declared the same way.
  const indexAttr = attrs.index;
  const index =
    indexAttr && indexAttr.kind === 'static' && /^[A-Za-z_$][\w$]*$/.test(indexAttr.value)
      ? indexAttr.value
      : null;

  return { type: 'each', expr: list.expr, alias: alias.value, index, children };
}

// <if cond={...}> … <else /> … </if> — the marker splits the children
// into the two branches.
function buildIf(attrs, children) {
  const condition = attrs.cond ?? attrs.when;

  if (!condition || condition.kind !== 'expr') {
    throw new ParseError(
      'Azox parse error: <if> needs cond={...} — for example <if cond={user()}>'
    );
  }

  const splitAt = children.findIndex((child) => child.type === 'else');

  return {
    type: 'if',
    expr: condition.expr,
    then: splitAt === -1 ? children : children.slice(0, splitAt),
    otherwise: splitAt === -1 ? [] : children.slice(splitAt + 1),
  };
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
    const type = nodeTypeFor(name);

    if (selfClosing) {
      // <else /> is a marker inside <if>, not a node of its own; the
      // <if> handler below is what gives it meaning.
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

    if (type === 'each') return { node: buildEach(attrs, children), rest: remaining };
    if (type === 'if') return { node: buildIf(attrs, children), rest: remaining };

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
