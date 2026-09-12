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
  console.log('  npm install');
  console.log('  npx azox dev');
}

function projectPackageJson(name) {
  return `${JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'azox dev',
        build: 'azox compile',
      },
      devDependencies: {
        azoxjs: `^${VERSION}`,
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

  const tasks = signal([
    { id: 1, title: 'Edit this page', done: true },
    { id: 2, title: 'Add a page of your own', done: false },
  ]);
  const draft = signal('');
  let nextId = 3;
</script>

<main class="page">
  <h1>${name}</h1>
  <p>Built with Azox.</p>

  <!-- Each Counter holds a count of its own. -->
  <Counter label="Left" />
  <Counter label="Right" />

  <!-- key={task.id} gives each row an identity, so adding to the
       list leaves the rows already there untouched. -->
  <ul>
    <each item={tasks()} as="task" index="i" key={task.id}>
      <li>
        <if cond={task.done}>
          <s>{i + 1}. {task.title}</s>
        <else />
          <span>{i + 1}. {task.title}</span>
        </if>
      </li>
    </each>
  </ul>

  <input
    value={draft()}
    on:input={(e) => draft.set(e.target.value)}
    placeholder="Add a task"
  />
  <button on:click={() => {
    if (!draft()) return;
    tasks.set([...tasks(), { id: nextId++, title: draft(), done: false }]);
    draft.set('');
  }}>Add</button>

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

// A component may hold state of its own, and each use gets its own
// copy — the two Counters on the starter page count independently.
function starterComponent() {
  return `<script>
  import { signal } from 'azox/reactivity';

  const { label } = props();
  const count = signal(0);
</script>

<span class="counter">
  {label}: {count()}
  <button on:click={() => count.set(count() + 1)}>+</button>
</span>
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
