// `azox create <name>` — scaffolds a new Azox project.
//
// Generated projects import the runtime by its package name
// ("azox/reactivity"), which is what will work once Azox is on npm.
// Until then `npm link azox` from the framework checkout makes the
// same specifier resolve locally, so the scaffold never has to bake
// in a brittle relative path.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { BANNER, VERSION } from '../meta.js';

export function createCommand({ positionals, flags }) {
  const name = positionals[0] ?? flags.name;

  if (!name) {
    console.error('Azox: missing project name.');
    console.error('Usage: azox create <name>');
    process.exitCode = 1;
    return;
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    console.error(`Azox: "${name}" is not a valid project name.`);
    console.error('Use letters, digits, dots, dashes or underscores.');
    process.exitCode = 1;
    return;
  }

  const targetDir = resolve(process.cwd(), name);

  if (existsSync(targetDir)) {
    console.error(`Azox: directory "${name}" already exists.`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(join(targetDir, 'pages'), { recursive: true });
  mkdirSync(join(targetDir, 'components'), { recursive: true });

  const files = {
    'package.json': projectPackageJson(name),
    'pages/index.azox': starterPage(name),
    'pages/about.azox': aboutPage(name),
    'components/Counter.azox': starterComponent(),
    '.gitignore': '.azox/\nnode_modules/\n.DS_Store\n',
    'README.md': projectReadme(name),
  };

  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(targetDir, path), contents, 'utf8');
  }

  console.log(BANNER);
  console.log('');
  console.log(`Created ${name}/`);
  for (const path of Object.keys(files)) console.log(`  ${path}`);
  console.log('');
  console.log('Next:');
  console.log(`  cd ${name}`);
  console.log('  npm link azox   # while Azox is not published yet');
  console.log('  azox dev');
}

function projectPackageJson(name) {
  return `${JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        build: 'azox compile',
      },
      devDependencies: {
        azox: `^${VERSION}`,
      },
    },
    null,
    2
  )}\n`;
}

function starterPage(name) {
  return `<script>
  import Counter from '../components/Counter.azox';
  import { signal } from 'azox/reactivity';

  const count = signal(0);
</script>

<main class="page">
  <h1>${name}</h1>
  <p>Built with Azox.</p>

  <Counter label="Clicks" value={count()} />

  <button on:click={() => count.set(count() + 1)}>
    Add one
  </button>

  <p><a href="/about">About</a></p>
</main>
`;
}

// pages/about.azox is served at /about — the file layout is the
// routing table.
function aboutPage(name) {
  return `<main class="page">
  <h1>About</h1>
  <p>${name} is built with Azox.</p>
  <p><a href="/">Home</a></p>
</main>
`;
}

// Components take props and render markup. State lives in the page
// that uses them.
function starterComponent() {
  return `<script>
  const { label, value } = props();
</script>

<p class="counter">{label}: {value}</p>
`;
}

function projectReadme(name) {
  return `# ${name}

An Azox project.

## Build

\`\`\`bash
azox compile
\`\`\`

Output lands in \`.azox/build/\`.
`;
}

const toPosix = (p) => p.split('\\').join('/');
