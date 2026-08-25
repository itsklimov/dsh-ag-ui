import { defineConfig } from 'tsdown'

/**
 * Bundle the public adapter entry plus the two child-side modules the spawned
 * micro-host loads by file URL: the host bootstrap and the readiness reporter.
 */
export default defineConfig(
  ['index', 'host-boot', 'host-reporter'].map(entry => ({
    entry: [`lib/types/${entry}.js`],
    outDir: 'lib',
    format: ['esm'] as const,
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
    sourcemap: true,
  })),
)
