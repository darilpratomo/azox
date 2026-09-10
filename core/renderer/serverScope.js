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

// Every top-level binding the script introduces, so they can all be
// handed to the markup. Function and class declarations count too — a
// component may well define a helper the template calls.
export function declaredNames(script) {
  const names = new Set();

  for (const match of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]);
  }
  for (const match of script.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(match[1]);
  }
  for (const match of script.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }

  // Destructured declarations: const { a, b: c, d = 1 } = …
  for (const match of script.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  return [...names];
}

// Evaluates a script body and returns its declarations. `params` and
// `args` pass a component's props in as arguments.
export function evaluateScript(body, params = [], args = []) {
  const names = declaredNames(body);

  const fn = new Function(
    'signal',
    'computed',
    ...params,
    `${body}\nreturn { ${names.join(', ')} };`
  );

  return fn(serverSignal, serverComputed, ...args);
}
