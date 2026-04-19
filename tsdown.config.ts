import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  minify: false,
  sourcemap: true,
  dts: true,
  clean: true,
})
