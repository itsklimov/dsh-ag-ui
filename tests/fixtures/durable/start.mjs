import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.chdir(dirname(fileURLToPath(import.meta.url)))
await import(new URL('../../../node_modules/@deepseek-ai/cordis/bin.js', import.meta.url))
