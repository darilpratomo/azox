// Runs a page's or a component's <script> block during server
// rendering, and hands back the bindings it declared.
//
// The script is trusted project source, not user input — the same
// assumption any template engine's server step makes. It must never
// be pointed at .azox content submitted by someone else.
//
// One implementation, used by both the build and the renderer: two
// copies drifted apart once already, leaving pages able to use
// `computed` while components could not.

// Server rendering needs only the current value, not reactivity, so
// a signal here is a plain box. The real runtime takes over in the
// browser.
export function serverSignal(initial) {
  let value = initial;

  const read = () => value;
  read.set = (next) => {
    value = typeof next === 'function' ? next(value) : next;
  };
  read.peek = () => value;

  return read;
}

export function serverComputed(fn) {
  return () => fn();
}

// Server rendering produces a string: there is no DOM to mount into,
// and nothing is ever removed, so both hooks do nothing here. The real
// ones take over in the browser.
//
// They still have to exist, or a component that uses them fails the
// build with "onMount is not defined" — the page would be unbuildable
// rather than merely non-reactive on the server.
export function serverOnMount() {}
export function serverOnCleanup() {}

// Every top-level binding the script introduces, so they can all be
// handed to the markup. Function and class declarations count too — a
// component may well define a helper the template calls.
export function declaredNames(script) {
  const names = new Set();

  // Only what the script declares at its top level. A name declared
  // inside a callback — `const timer` within onMount, say — is a local
  // of that function, so returning it from the outer scope throws
  // "timer is not defined" and takes the whole page down.
  const topLevel = topLevelSource(script);

  for (const match of topLevel.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]);
  }
  for (const match of topLevel.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(match[1]);
  }
  for (const match of topLevel.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }

  // Destructured declarations: const { a, b: c, d = 1 } = …
  //
  for (const match of topLevel.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  return [...names];
}

// Blanks out everything nested inside braces, brackets or parentheses,
// leaving the top-level text with its offsets intact — so a declaration
// inside a function body is no longer visible to the patterns above.
//
// Strings, template literals and comments are blanked too: a brace in
// one of them would otherwise throw the depth count off.
function topLevelSource(script) {
  let out = '';
  let depth = 0;
  let i = 0;

  while (i < script.length) {
    const c = script[i];
    const next = script[i + 1];

    // Comments.
    if (c === '/' && next === '/') {
      const end = script.indexOf('\n', i);
      const stop = end === -1 ? script.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      const stop = end === -1 ? script.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    // Strings and template literals: skipped whole, so braces inside
    // them do not count. A template's ${...} is skipped with it, which
    // is fine — nothing is declared at the top level in there.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < script.length) {
        if (script[j] === '\\') j += 2;
        else if (script[j] === quote) break;
        else j++;
      }
      const stop = Math.min(j + 1, script.length);
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    // The delimiter itself is kept when it opens at the top level, so
    // `function f(` and `const { a } =` still match; what is nested
    // inside is blanked.
    //
    // The exception is a destructuring pattern — `const { a, b } = …` —
    // whose names are the thing being declared, so its contents are
    // kept even though they sit one level in.
    if (c === '{' || c === '(' || c === '[') {
      const destructuring = c === '{' && depth === 0 && /(?:const|let|var)\s*$/.test(out);

      out += depth === 0 ? c : ' ';
      depth++;

      if (destructuring) {
        const close = script.indexOf('}', i + 1);
        if (close !== -1) {
          out += script.slice(i + 1, close + 1);
          depth--;
          i = close + 1;
          continue;
        }
      }

      i++;
      continue;
    }

    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      out += depth === 0 ? c : ' ';
      i++;
      continue;
    }

    // Newlines are kept at any depth so line-anchored patterns still
    // behave; everything else nested is blanked.
    out += depth === 0 || c === '\n' ? c : ' ';
    i++;
  }

  return out;
}

// Evaluates a script body and returns its declarations. `params` and
// `args` pass a component's props in as arguments.
//
// `extras` are further bindings the caller supplies by name — `params`
// for a dynamic page, and `routes` while its route list is collected.
//
// `modules` carries what the script's imports brought in, as local
// name → value. The body runs inside a `new Function`, which cannot
// use `import`, so the bindings arrive as arguments instead — the
// build resolves them, since loading a module needs the filesystem
// and this file has to stay usable in a browser.
export function evaluateScript(body, params = [], args = [], modules = {}, extras = {}) {
  const imported = Object.keys(modules);
  const extraNames = Object.keys(extras);
  const reserved = new Set([...imported, ...extraNames]);
  const names = declaredNames(body).filter((name) => !reserved.has(name));

  const fn = new Function(
    'signal',
    'computed',
    'onMount',
    'onCleanup',
    ...imported,
    ...extraNames,
    ...params,
    `${body}\nreturn { ${names.join(', ')} };`
  );

  const declared = fn(
    serverSignal,
    serverComputed,
    serverOnMount,
    serverOnCleanup,
    ...imported.map((n) => modules[n]),
    ...extraNames.map((n) => extras[n]),
    ...args
  );

  // An imported binding is in scope for the markup too, the same way
  // it is in the compiled module.
  return { ...modules, ...declared };
}
