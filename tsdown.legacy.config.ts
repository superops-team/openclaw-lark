import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';

function listTypeScriptFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      return listTypeScriptFiles(fullPath, relative);
    }
    return name.endsWith('.ts') ? [`src/${relative}`] : [];
  });
}

const entry = Object.fromEntries(
  listTypeScriptFiles('src').map((file) => [file.replace(/\.ts$/, ''), file]),
);

export default defineConfig({
  entry,
  format: 'cjs',
  target: 'node22',
  platform: 'node',
  clean: true,
  outDir: '.legacy-cjs',
  dts: true,
  unbundle: true,
  root: '.',
  deps: {
    neverBundle: [
      /^openclaw(\/.*)?$/,
      /^@larksuiteoapi\//,
      /^@sinclair\//,
      'image-size',
      'zod',
      /^node:/,
    ],
  },
});
