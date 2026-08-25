/**
 * Child-side readiness reporter: a legacy Cordis plugin mounted last in the
 * generated overlay. Once the webserver and the gateway service are both
 * active it atomically writes the bound loopback address, so the parent knows
 * the ephemeral port and that the gateway route is registered.
 * @module dsh-ag-ui-adapter/src/host-reporter
 */

import { rename, writeFile } from 'node:fs/promises'

export const name = 'dsh-ag-ui-adapter/host-reporter'
export const inject = ['webServer', 'agUi']

/** The reporter reads only the address of the already-started webserver. */
interface ReporterContext {
  readonly webServer: { readonly host: string, readonly port: number }
}

interface ReporterConfig {
  readonly readyFile: string
}

export async function apply(ctx: ReporterContext, config: ReporterConfig): Promise<void> {
  const payload = JSON.stringify({ host: ctx.webServer.host, port: ctx.webServer.port })
  // rename makes the file appear atomically, so the parent never reads a partial write
  const staging = `${config.readyFile}.staging`
  await writeFile(staging, payload)
  await rename(staging, config.readyFile)
}
