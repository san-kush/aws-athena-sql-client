import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // Only 'vscode' is provided by the host at runtime. Everything else must be
  // bundled: .vscodeignore excludes node_modules from the .vsix, so anything
  // left external would resolve at runtime in development but throw
  // "Cannot find module" in an installed extension.
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log(`Build complete${production ? ' (production)' : ''}.`);
}
