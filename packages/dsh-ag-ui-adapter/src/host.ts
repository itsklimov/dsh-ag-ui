/**
 * Parent-side micro-host process manager: materializes the generated overlay
 * in a clean temporary directory, spawns the child-side bootstrap through the
 * current Node executable, waits for the readiness file the reporter writes,
 * and owns the child's shutdown.
 * @module dsh-ag-ui-adapter/src/host
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_GATEWAY_PATH, generateSharedSecret, overlayRows } from './overlay.ts'
import { resolveHostModule } from './resolve.ts'
import type { DshGatewayOptions, HostPluginRow } from './types.ts'

/** What the embedded application configures about its micro-host. */
export interface MicroHostOptions {
  readonly gateway: DshGatewayOptions
  /** Extra overlay rows between the webserver and the gateway. */
  readonly plugins?: readonly HostPluginRow[] | undefined
  /** Milliseconds to wait for the child to report readiness; default 20000. */
  readonly readyTimeoutMs?: number | undefined
  /** Extra environment variables merged over the parent's environment. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** The address the readiness reporter writes once the gateway route is live. */
interface ReadyFile {
  readonly host: string
  readonly port: number
}

const PACKAGE_ROOT = new URL('./', import.meta.resolve('dsh-ag-ui-adapter/package.json', import.meta.url))
const HOST_BOOT = new URL('lib/host-boot.js', PACKAGE_ROOT)
const HOST_REPORTER = new URL('lib/host-reporter.js', PACKAGE_ROOT)
/** Bounded stderr tail kept for failure diagnostics. */
const DIAGNOSTIC_BYTES = 8192

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Read and parse the readiness file, or undefined while it is not there yet. */
async function readReadyFile(path: string): Promise<ReadyFile | undefined> {
  try {
    // the reporter writes the file atomically, so a read sees either nothing or the complete payload
    return JSON.parse(await readFile(path, 'utf8')) as ReadyFile
  } catch {
    return undefined
  }
}

/** Resolve when the child is gone, or false when the timeout elapses first. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

/**
 * Stop the child: `immediate` hard-kills (used on failed starts, where nothing
 * is worth shutting down gracefully); `graceful` SIGTERMs first and escalates
 * to SIGKILL after the grace period. A child that is already gone is a no-op.
 */
async function terminate(child: ChildProcess, mode: 'graceful' | 'immediate'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (mode === 'immediate') {
    child.kill('SIGKILL')
    await waitForExit(child, 5000)
    return
  }
  child.kill('SIGTERM')
  if (!await waitForExit(child, 3000)) {
    child.kill('SIGKILL')
    await waitForExit(child, 5000)
  }
}

/** One running micro-host child together with its ephemeral address. */
export class MicroHost {
  private stopping: Promise<void> | undefined

  private constructor(
    private readonly child: ChildProcess,
    private readonly ready: ReadyFile,
    private readonly gatewayPath: string,
    readonly sharedSecret: string,
    /** The temporary directory the child runs from; removed on stop. */
    readonly directory: string,
  ) {}

  /** The loopback address the child's webserver actually bound. */
  get address(): string {
    return `${this.ready.host}:${String(this.ready.port)}`
  }

  /** Full gateway URL the adapter's `run()` posts to. */
  get url(): string {
    return `http://${this.address}${this.gatewayPath}`
  }

  /**
   * Compose the overlay, spawn the bootstrap, and wait for the reporter.
   * Every failure path kills the child and removes its directory.
   */
  static async start(options: MicroHostOptions): Promise<MicroHost> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ag-ui-adapter-'))
    const sharedSecret = generateSharedSecret()
    const readyFile = join(directory, 'ready.json')
    const rows = overlayRows({
      gatewayName: resolveHostModule('dsh-ag-ui'),
      webserverName: resolveHostModule('@deepseek-ai/dsh-host-webserver'),
      reporterName: HOST_REPORTER.href,
      readyFile,
      sharedSecret,
      gateway: options.gateway,
      plugins: (options.plugins ?? []).map(plugin => ({ ...plugin, name: resolveHostModule(plugin.name) })),
    })
    await writeFile(join(directory, 'cordis.yml'), `${JSON.stringify(rows, null, 2)}\n`)

    const child = spawn(
      process.execPath,
      [fileURLToPath(HOST_BOOT), resolveHostModule('@deepseek-ai/cordis-plugin-include')],
      { cwd: directory, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let diagnostics = ''
    const record = (chunk: Buffer): void => {
      diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-DIAGNOSTIC_BYTES)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    // a spawn-system failure (not a child exit) would otherwise surface as an
    // unhandled 'error' event; the readiness loop reports it as a timeout
    // v8 ignore next 2 -- a spawn-system failure cannot be produced deterministically
    child.once('error', () => {})

    const fail = async (message: string): Promise<never> => {
      await terminate(child, 'immediate')
      await rm(directory, { recursive: true, force: true })
      throw new Error(`${message}${diagnostics === '' ? '' : `\n${diagnostics}`}`)
    }

    const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000)
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return await fail(`The DSH micro-host exited before becoming ready (code ${String(child.exitCode)}).`)
      }
      const ready = await readReadyFile(readyFile)
      if (ready !== undefined) {
        return new MicroHost(child, ready, options.gateway.path ?? DEFAULT_GATEWAY_PATH, sharedSecret, directory)
      }
      await delay(20)
    }
    return await fail('The DSH micro-host did not become ready in time.')
  }

  /** Terminate the child (gracefully first) and remove its directory; idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.dispose()
    return this.stopping
  }

  private async dispose(): Promise<void> {
    await terminate(this.child, 'graceful')
    await rm(this.directory, { recursive: true, force: true })
  }
}
