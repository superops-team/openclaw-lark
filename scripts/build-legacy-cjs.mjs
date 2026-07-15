#!/usr/bin/env node
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const legacyOutDir = join(repoRoot, '.legacy-cjs');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(legacyOutDir, { recursive: true, force: true });
mkdirSync(legacyOutDir, { recursive: true });
rmSync(join(repoRoot, 'src', 'src'), { recursive: true, force: true });
rmSync(join(repoRoot, '_virtual'), { recursive: true, force: true });

run('pnpm', [
  'exec',
  'tsdown',
  '--config',
  'tsdown.legacy.config.ts',
]);

cpSync(join(legacyOutDir, 'src'), join(repoRoot, 'src'), {
  recursive: true,
});
cpSync(join(legacyOutDir, '_virtual'), join(repoRoot, '_virtual'), {
  recursive: true,
});

function addJavaScriptCompatibilityFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      addJavaScriptCompatibilityFiles(path);
      continue;
    }
    if (name.endsWith('.d.cts')) {
      copyFileSync(path, path.slice(0, -'.d.cts'.length) + '.d.ts');
      continue;
    }
    if (name.endsWith('.cjs')) {
      const stem = name.slice(0, -'.cjs'.length);
      writeFileSync(
        join(dir, `${stem}.js`),
        `"use strict";\nmodule.exports = require("./${name}");\n`,
        'utf8',
      );
    }
  }
}

addJavaScriptCompatibilityFiles(join(repoRoot, 'src'));

writeFileSync(
  join(repoRoot, 'src', 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
  'utf8',
);

