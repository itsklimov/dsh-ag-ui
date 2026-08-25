/**
 * The embedded adapter agent: an `AbstractAgent` that spawns a DSH micro-host
 * (a Cordis overlay composing a loopback webserver on an ephemeral port, the
 * published `dsh-ag-ui` gateway with a per-process secret, and the caller's
 * plugin rows), then serves `run()` over loopback HTTP by composing the
 * official client primitives — no new protocol translation code.
 * @module dsh-ag-ui-adapter/src/agent
 */

import { AbstractAgent, runHttpRequest, transformHttpEventStream } from '@ag-ui/client'
import type { AgentConfig, AgentSubscriber, HttpAgentFetchFn, RunAgentParameters, RunAgentResult } from '@ag-ui/client'
import type { BaseEvent, RunAgentInput } from '@ag-ui/core'
import type { Observable } from 'rxjs'
import { MicroHost } from './host.ts'
import type { MicroHostOptions } from './host.ts'
import type { DshGatewayOptions, HostPluginRow } from './types.ts'

/** Everything an embedding application configures on a `DshAgent`. */
export interface DshAgentConfig extends AgentConfig {
  /** The gateway row of the generated micro-host overlay. */
  readonly gateway: DshGatewayOptions
  /** Extra overlay rows between the webserver and the gateway (spine, model). */
  readonly plugins?: readonly HostPluginRow[] | undefined
  /** Trusted tenant identity sent to the gateway; default `dsh-ag-ui-adapter`. */
  readonly tenantId?: string | undefined
  /** Trusted user identity sent to the gateway; default `local`. */
  readonly userId?: string | undefined
  /** Tenant identity header name; must match the gateway's `tenantHeader`. */
  readonly tenantHeader?: string | undefined
  /** User identity header name; must match the gateway's `userHeader`. */
  readonly userHeader?: string | undefined
  /** Extra request headers merged after the adapter-owned ones. */
  readonly headers?: Record<string, string> | undefined
  /** Custom fetch used for the loopback run requests. */
  readonly fetch?: HttpAgentFetchFn | undefined
  /** Milliseconds to wait for the micro-host to report readiness. */
  readonly readyTimeoutMs?: number | undefined
  /** Extra environment variables merged into the micro-host child. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

interface RunDshAgentParameters extends RunAgentParameters {
  abortController?: AbortController
}

/** An AG-UI agent backed by a child-process DSH micro-host. */
export class DshAgent extends AbstractAgent {
  public abortController = new AbortController()

  private host: MicroHost | undefined
  private starting: Promise<void> | undefined
  /** Copy of the running host's bearer secret; empty outside a started host. */
  private sharedSecret = ''
  private readonly hostOptions: MicroHostOptions
  private readonly identityHeaders: Record<string, string>
  private readonly headers: Record<string, string>
  private readonly fetchFn: HttpAgentFetchFn

  constructor(config: DshAgentConfig) {
    super(config)
    this.hostOptions = {
      gateway: config.gateway,
      ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
      ...(config.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: config.readyTimeoutMs }),
      ...(config.env === undefined ? {} : { env: config.env }),
    }
    this.identityHeaders = {
      [config.tenantHeader ?? 'x-dsh-tenant-id']: config.tenantId ?? 'dsh-ag-ui-adapter',
      [config.userHeader ?? 'x-dsh-user-id']: config.userId ?? 'local',
    }
    this.headers = structuredClone(config.headers ?? {})
    // bound like HttpAgent's default: a stored bare fetch would be invoked with
    // the agent as receiver, which a browser's native fetch rejects
    this.fetchFn = config.fetch ?? ((url, requestInit) => fetch(url, requestInit))
  }

  /** Spawn the micro-host and wait for readiness; idempotent. */
  async start(): Promise<void> {
    this.starting ??= this.spawn()
    await this.starting
  }

  private async spawn(): Promise<void> {
    const host = await MicroHost.start(this.hostOptions)
    this.host = host
    this.sharedSecret = host.sharedSecret
  }

  /** The loopback gateway URL of the running micro-host. */
  get url(): string {
    if (this.host === undefined) throw new Error('The DSH micro-host has not started; await start() first.')
    return this.host.url
  }

  /**
   * The fetch config for one run request: gateway bearer authentication and
   * trusted identity headers, mirroring what a BFF would inject.
   */
  protected requestInit(input: RunAgentInput): RequestInit {
    return {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.sharedSecret}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.identityHeaders,
        ...this.headers,
      },
      body: JSON.stringify(input),
      signal: this.abortController.signal,
    }
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (this.host === undefined) {
      throw new Error('The DSH micro-host has not started; await start() before running.')
    }
    const httpEvents = runHttpRequest(() => this.fetchFn(this.url, this.requestInit(input)))
    return transformHttpEventStream(httpEvents)
  }

  public override async runAgent(
    parameters?: RunDshAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.abortController = parameters?.abortController ?? new AbortController()
    return await super.runAgent(parameters, subscriber)
  }

  override abortRun(): void {
    this.abortController.abort()
    super.abortRun()
  }

  /** Terminate the micro-host and remove its directory; safe to call twice. */
  async stop(): Promise<void> {
    // a failed start leaves no host, but its rejection must not break stop()
    if (this.starting !== undefined) await this.starting.catch(() => {})
    await this.host?.stop()
    this.host = undefined
    this.sharedSecret = ''
    this.starting = undefined
  }
}
