// Parses a .azox source file into a small AST. Deliberately not
// JSX: no React-flavored syntax, just HTML with {expr} interpolation
// and on:event bindings. This stays simple because the compiler's
// job is narrow — turn markup + bindings into signal-driven DOM ops.

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

export function parseAzox(source) {
  const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);
  const script = scriptMatch ? scriptMatch[1].trim() : '';
  const template = source.replace(/<script>[\s\S]*?<\/script>/, '').trim();

  const tokens = tokenize(template);
  const { node, rest } = parseNode(tokens);
  if (rest.length) {
    throw new Error(`Azox parse error: unexpected trailing markup near "${rest[0]?.value ?? ''}"`);
  }

  return { script, markup: node };
}

function tokenize(html) {
  const tokens = [];
  let i = 0;

  while (i < html.length) {
    if (html[i] === '<') {
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

// Finds the ">" that actually closes a tag, ignoring any ">" that
// appears inside a {expr} attribute value (e.g. arrow functions
// like `on:click={() => count.set(...)}`).
function findTagEnd(html, start) {
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return i;
  }
  throw new Error('Azox parse error: unterminated tag');
}

function splitTag(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ' ' && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseAttrs(attrString) {
  const attrs = {};
  const regex = /([\w:.-]+)=(\{[^}]*\}|"[^"]*"|'[^']*')/g;
  let match;
  while ((match = regex.exec(attrString))) {
    const [, key, rawValue] = match;
    if (rawValue.startsWith('{')) {
      attrs[key] = { kind: 'expr', expr: rawValue.slice(1, -1).trim() };
    } else {
      attrs[key] = { kind: 'static', value: rawValue.slice(1, -1) };
    }
  }
  return attrs;
}

function parseNode(tokens) {
  const [token, ...rest] = tokens;

  if (!token) return { node: null, rest: [] };

  if (token.type === 'text') {
    return { node: { type: 'text', parts: splitInterpolation(token.value) }, rest };
  }

  if (token.type === 'open') {
    const { name, attrs, selfClosing } = token;
    if (selfClosing) {
      return { node: { type: 'element', name, attrs, children: [] }, rest };
    }

    const children = [];
    let remaining = rest;
    while (remaining.length && !(remaining[0].type === 'close' && remaining[0].name === name)) {
      const result = parseNode(remaining);
      if (result.node) children.push(result.node);
      remaining = result.rest;
    }

    if (!remaining.length) {
      throw new Error(`Azox parse error: <${name}> is never closed`);
    }

    remaining = remaining.slice(1); // drop the matching close tag

    return { node: { type: 'element', name, attrs, children }, rest: remaining };
  }

  return { node: null, rest };
}

// Splits "Clicks: {count()}" into [{kind:'static', value:'Clicks: '}, {kind:'expr', expr:'count()'}]
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
    const end = text.indexOf('}', start);
    parts.push({ kind: 'expr', expr: text.slice(start + 1, end).trim() });
    i = end + 1;
  }
  return parts;
}
