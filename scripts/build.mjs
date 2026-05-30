import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { build } from 'esbuild';

async function packageVersion() {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );

  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error('package.json must contain a non-empty version string');
  }

  return packageJson.version;
}

const version = await packageVersion();

await build({
  entryPoints: ['src/rss2md.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/rss2md',
  minify: true,
  define: {
    __VERSION__: JSON.stringify(version),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
});
