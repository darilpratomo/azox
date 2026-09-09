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
  writeFileSync(join(targetDir, 'package.json'), projectPackageJson(name), 'utf8');
  writeFileSync(join(targetDir, 'pages', 'index.azox'), starterPage(name), 'utf8');
  writeFileSync(join(targetDir, '.gitignore'), '.azox/\nnode_modules/\n.DS_Store\n', 'utf8');
  writeFileSync(join(targetDir, 'README.md'), projectReadme(name), 'utf8');

  console.log(BANNER);
  console.log('');
  console.log(`Created ${name}/`);
  console.log('  package.json');
  console.log('  pages/index.azox');
  console.log('  .gitignore');
  console.log('  README.md');
  console.log('');
  console.log('Next:');
  console.log(`  cd ${name}`);
  console.log('  npm link azox   # while Azox is not published yet');
  console.log('  azox compile');
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
  import { signal } from 'azox/reactivity';

  const count = signal(0);
</script>

<main class="page">
  <h1>${name}</h1>
  <p>Built with Azox.</p>
  <button on:click={() => count.set(count() + 1)}>
    Clicks: {count()}
  </button>
</main>
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
