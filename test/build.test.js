// End-to-end: run the real CLI against a temporary project, then
// execute the compiled output against a minimal DOM to confirm the
// page is actually reactive — not just that the files were written.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'azox.js');

let projectDir;

const azox = (args, cwd = projectDir) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

before(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'azox-test-'));
  mkdirSync(join(projectDir, 'pages'), { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'fixture-app', type: 'module' }, null, 2)
  );
  writeFileSync(
    join(projectDir, 'pages', 'index.azox'),
    `<script>
  import { signal } from 'azox/reactivity';

  const count = signal(0);
</script>

<main class="page">
  <h1>Fixture</h1>
  <button on:click={() => count.set(count() + 1)}>
    Clicks: {count()}
  </button>
</main>
`
  );
});

after(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test('compile reports the routes it built', () => {
  const output = azox(['compile']);

  assert.match(output, /Built 1 page/);
  assert.match(output, /index\.html/);
});

test('compile writes the html, client module and runtime', () => {
  azox(['compile']);

  for (const file of ['index.html', 'page.client.js', 'azox-runtime.js']) {
    assert.ok(
      existsSync(join(projectDir, '.azox/build', file)),
      `expected .azox/build/${file} to exist`
    );
  }
});

test('server-rendered html contains the initial state', () => {
  azox(['compile']);
  const html = readFileSync(join(projectDir, '.azox/build/index.html'), 'utf8');

  assert.match(html, /<h1>Fixture<\/h1>/);
  assert.match(html, /Clicks: 0/);
  assert.match(html, /data-azox-root/);
});

test('page title comes from the project name', () => {
  azox(['compile']);
  const html = readFileSync(join(projectDir, '.azox/build/index.html'), 'utf8');
  assert.match(html, /<title>fixture-app<\/title>/);
});

// Regression: the runtime was once imported through two different
// specifiers, producing two module instances with unlinked signals.
test('every runtime import resolves to the single copied runtime', () => {
  azox(['compile']);
  const client = readFileSync(join(projectDir, '.azox/build/page.client.js'), 'utf8');

  const specifiers = [...client.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(specifiers.length >= 2, 'expected runtime imports in the output');
  assert.deepEqual(
    [...new Set(specifiers)],
    ['./azox-runtime.js'],
    'all imports must point at the one copied runtime'
  );
});

test('compiled page is reactive when executed', async () => {
  azox(['compile']);

  class El {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.listeners = {};
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    setAttribute() {}
    addEventListener(event, fn) {
      this.listeners[event] = fn;
    }
  }

  globalThis.document = {
    querySelector: () => null,
    body: new El('body'),
    createElement: (tag) => new El(tag),
    createTextNode: (data) => ({ data }),
  };

  const modulePath = join(projectDir, '.azox/build/page.client.js');
  const { render } = await import(`file://${modulePath}`);

  const root = render(new El('div'));
  const button = root.children.find((child) => child.tag === 'button');
  const text = button.children[0];

  assert.equal(text.data, 'Clicks: 0');

  button.listeners.click();
  assert.equal(text.data, 'Clicks: 1', 'a click must update the bound text node');

  button.listeners.click();
  button.listeners.click();
  assert.equal(text.data, 'Clicks: 3');
});

test('compile fails clearly when the page does not exist', () => {
  assert.throws(
    () => azox(['compile', '--page=missing']),
    (error) => {
      assert.match(error.stderr, /pages\/missing\.azox" not found/);
      return true;
    }
  );
});

// Regression: an unknown flag was ignored, so `azox compile --pge=x`
// built every page while looking as though it had built one.
test('a mistyped flag is reported rather than ignored', () => {
  assert.throws(
    () => azox(['compile', '--pge=index']),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /unknown flag for "compile": --pge/);
      assert.match(error.stderr, /It accepts: --page/, 'and says what is valid');
      return true;
    }
  );
});

test('a command with no flags says so', () => {
  assert.throws(
    () => azox(['doctor', '--wat']),
    (error) => {
      assert.match(error.stderr, /It accepts no flags/);
      return true;
    }
  );
});

test('a valid flag still works', () => {
  assert.doesNotThrow(() => azox(['compile', '--page=index']));
});

test('-v and --help are accepted anywhere', () => {
  assert.doesNotThrow(() => azox(['-v']));
  assert.doesNotThrow(() => azox(['--help']));
});

test('unknown commands exit non-zero', () => {
  assert.throws(
    () => azox(['nope']),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /unknown command "nope"/);
      return true;
    }
  );
});

test('version matches package.json', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(azox(['-v'], ROOT).trim(), `azox v${version}`);
});

test('help lists the available commands', () => {
  const output = azox(['help'], ROOT);
  for (const command of ['create', 'compile', 'doctor', 'version', 'help']) {
    assert.match(output, new RegExp(`\\b${command}\\b`));
  }
});

test('doctor reports a healthy project', () => {
  const output = azox(['doctor']);
  assert.match(output, /Everything looks good/);
});

test('doctor fails on a page that cannot be parsed', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'azox-doctor-'));

  try {
    mkdirSync(join(workspace, 'pages'), { recursive: true });
    writeFileSync(join(workspace, 'pages/index.azox'), '<main><h1>oops</main>');

    assert.throws(
      () => azox(['doctor'], workspace),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stdout, /<h1> is never closed/);
        return true;
      }
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('create scaffolds a runnable project', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'azox-create-'));

  try {
    azox(['create', 'scaffolded'], workspace);

    const pkg = JSON.parse(readFileSync(join(workspace, 'scaffolded/package.json'), 'utf8'));
    assert.equal(pkg.name, 'scaffolded');

    const page = readFileSync(join(workspace, 'scaffolded/pages/index.azox'), 'utf8');
    assert.match(page, /from 'azox\/reactivity'/, 'scaffold must use the package specifier');
    assert.match(page, /<h1>scaffolded<\/h1>/);

    // The scaffold is most people's first sight of the framework, so
    // it should show what the framework can do.
    assert.match(page, /<each /, 'shows a loop');
    assert.match(page, /<if /, 'shows a conditional');

    const component = readFileSync(
      join(workspace, 'scaffolded/components/Counter.azox'),
      'utf8'
    );
    assert.match(component, /signal\(0\)/, 'shows a component holding its own state');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('create refuses to overwrite an existing directory', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'azox-create-'));

  try {
    azox(['create', 'twice'], workspace);
    assert.throws(
      () => azox(['create', 'twice'], workspace),
      (error) => {
        assert.match(error.stderr, /already exists/);
        return true;
      }
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a component prop stays reactive through the boundary', async () => {
  mkdirSync(join(projectDir, 'components'), { recursive: true });
  writeFileSync(
    join(projectDir, 'components/Readout.azox'),
    `<script>
  const { value } = props();
</script>
<span class="readout">{value}</span>`
  );
  writeFileSync(
    join(projectDir, 'pages/index.azox'),
    `<script>
  import Readout from '../components/Readout.azox';
  import { signal } from 'azox/reactivity';

  const count = signal(0);
</script>

<main>
  <Readout value={count()} />
  <button on:click={() => count.set(count() + 1)}>bump</button>
</main>
`
  );

  azox(['compile']);

  class El {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.listeners = {};
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    setAttribute() {}
    addEventListener(event, fn) {
      this.listeners[event] = fn;
    }
  }

  globalThis.document = {
    querySelector: () => null,
    body: new El('body'),
    createElement: (tag) => new El(tag),
    createTextNode: (data) => ({ data }),
    createDocumentFragment: () => new El('#fragment'),
  };

  const modulePath = join(projectDir, '.azox/build/page.client.js');
  const { render } = await import(`file://${modulePath}?component-reactivity`);

  const root = render(new El('div'));
  const readout = root.children.find((child) => child.tag === 'span');
  const button = root.children.find((child) => child.tag === 'button');

  assert.equal(readout.children[0].data, '0');

  button.listeners.click();
  assert.equal(readout.children[0].data, '1', 'a signal must update text inside a component');
});

test('compile builds every page when no --page is given', () => {
  writeFileSync(join(projectDir, 'pages/second.azox'), '<main><h1>Second</h1></main>');

  try {
    const output = azox(['compile']);

    assert.match(output, /Built 2 pages/);
    assert.match(output, /^\s+\/\s/m, 'the root route should be listed');
    assert.match(output, /\/second/);
    assert.match(readFileSync(join(projectDir, '.azox/build/second/index.html'), 'utf8'), /Second/);
  } finally {
    rmSync(join(projectDir, 'pages/second.azox'), { force: true });
  }
});

test('compiled output carries no dev-server machinery', () => {
  azox(['compile']);
  const html = readFileSync(join(projectDir, '.azox/build/index.html'), 'utf8');

  assert.doesNotMatch(html, /EventSource|__azox_reload/, 'live reload must not reach a build');
});

test('create rejects an invalid project name', () => {
  assert.throws(
    () => azox(['create', '../escape'], projectDir),
    (error) => {
      assert.match(error.stderr, /not a valid project name/);
      return true;
    }
  );
});
