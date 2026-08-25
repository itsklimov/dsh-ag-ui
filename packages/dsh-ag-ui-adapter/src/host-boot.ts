/**
 * Child-side micro-host bootstrap. It mirrors `@deepseek-ai/cordis/bin.js` —
 * a fresh Context whose base URL is the process cwd, the Cordis Loader
 * service, then the include plugin reading `./cordis.yml` — with one
 * difference the clean temporary cwd forces: the include plugin itself is
 * passed in as a pre-resolved `file:` URL argument instead of being resolved
 * from the cwd. The overlay file is the documented row format; no upstream
 * package is patched or re-implemented.
 * @module dsh-ag-ui-adapter/src/host-boot
 */

import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const includeUrl = process.argv[2]
if (includeUrl === undefined) {
  throw new Error('dsh-ag-ui-adapter host bootstrap requires the include plugin URL as its first argument.')
}

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Loader)
await ctx.loader.create({ name: includeUrl, config: { path: './cordis.yml' } })
