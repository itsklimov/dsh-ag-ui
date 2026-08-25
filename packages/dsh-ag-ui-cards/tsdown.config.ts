import { defineConfig } from 'tsdown'

/** Bundle the public browser entry from the TypeScript compiler output. */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
  sourcemap: true,
})
