#!/usr/bin/env node
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function cleanGeneratedFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      cleanGeneratedFiles(path);
      continue;
    }
    if (
      name.endsWith('.js')
      || name.endsWith('.d.ts')
      || name.endsWith('.cjs')
      || name.endsWith('.d.cts')
    ) {
      rmSync(path, { force: true });
    }
  }
}

cleanGeneratedFiles(join(repoRoot, 'src'));
rmSync(join(repoRoot, 'src', 'package.json'), { force: true });
rmSync(join(repoRoot, 'src', 'src'), { recursive: true, force: true });
rmSync(join(repoRoot, '_virtual'), { recursive: true, force: true });
rmSync(join(repoRoot, '.legacy-cjs'), { recursive: true, force: true });

