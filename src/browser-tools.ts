/**
 * Reusable Agent-scoped browser Tool leases for DSH integrations.
 * @module dsh-ag-ui/browser-tools
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { valueDigest } from './json.ts'

const BROWSER_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Transport-neutral browser Tool declaration. */
export interface BrowserToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: ObjectJsonSchema & Record<string, unknown>
}

/** One Agent Tool call delivered to its owning browser Adapter. */
export interface BrowserToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
}

/** Adapter that transports one Tool call to a browser and returns its result. */
export interface BrowserToolTransport {
  invoke(call: BrowserToolCall, signal: AbortSignal): Promise<string>
}

/** Mutable lease for one browser capability set on one exact Agent. */
export interface BrowserToolLease {
  readonly agent: Agent
  readonly owner: string
  update(tools: readonly BrowserToolDescriptor[]): void
  dispose(): void
}

/** Broker limits independent from AG-UI Gateway configuration. */
export interface BrowserToolBrokerConfig {
  /** Maximum tools in one lease. */
  maxTools?: number
  /** Maximum wait for one browser result. */
  toolTimeoutMs?: number
}

export const BrowserToolBrokerConfig: z<BrowserToolBrokerConfig> = z.object({
  maxTools: z.natural().default(32),
  toolTimeoutMs: z.natural().default(5 * 60 * 1000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserTools: BrowserToolBroker
  }
}

/**
 * Owns browser Tool leases without owning their Agents or transports.
 *
 * A caller decides which Agent receives a lease and how calls reach the
 * browser. The broker contains schema validation, scoped registration,
 * cancellation, timeout, collision handling, and teardown.
 */
export class BrowserToolBroker extends Service {
  static inject = ['tools']
  static Config = BrowserToolBrokerConfig

  private readonly leases = new Set<BrowserToolLeaseImpl>()
  private readonly byAgent = new WeakMap<Agent, Map<string, BrowserToolLeaseImpl>>()
  private readonly resolved: Required<BrowserToolBrokerConfig>

  constructor(ctx: Context, config: BrowserToolBrokerConfig = {}) {
    super(ctx, 'browserTools')
    this.resolved = {
      maxTools: config.maxTools ?? 32,
      toolTimeoutMs: config.toolTimeoutMs ?? 5 * 60 * 1000,
    }
    assertPositiveConfig(this.resolved)
    ctx.effect(() => () => {
      for (const lease of this.leases) lease.dispose()
    }, 'browser-tools: dispose leases')
  }

  /** Bind one replaceable browser capability set to one exact live Agent. */
  bind(
    agent: Agent,
    owner: string,
    tools: readonly BrowserToolDescriptor[],
    transport: BrowserToolTransport,
  ): BrowserToolLease {
    if (!OWNER_NAME.test(owner)) {
      throw new TypeError('Browser Tool owner must use a supported identifier')
    }
    const owners = this.byAgent.get(agent) ?? new Map<string, BrowserToolLeaseImpl>()
    if (owners.has(owner)) {
      throw new Error(`Browser Tool owner ${owner} already has a lease on Agent ${String(agent.id)}`)
    }

    const lease = new BrowserToolLeaseImpl(
      this.ctx,
      agent,
      owner,
      transport,
      this.resolved,
      () => {
        this.leases.delete(lease)
        owners.delete(owner)
        if (owners.size === 0) this.byAgent.delete(agent)
      },
    )
    owners.set(owner, lease)
    this.byAgent.set(agent, owners)
    this.leases.add(lease)
    try {
      lease.update(tools)
    } catch (error) {
      lease.dispose()
      throw error
    }
    agent.ctx.effect(
      () => () => lease.dispose(),
      `browser-tools: ${owner} Agent lease`,
    )
    return lease
  }
}

interface PreparedTool {
  readonly descriptor: BrowserToolDescriptor
  readonly fingerprint: string
  readonly schema: ObjectJsonSchema & Record<string, unknown>
}

interface ToolRegistration {
  readonly dispose: () => void
  readonly fingerprint: string
}

class BrowserToolLeaseImpl implements BrowserToolLease {
  private readonly registrations = new Map<string, ToolRegistration>()
  private readonly invocations = new Set<AbortController>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    readonly agent: Agent,
    readonly owner: string,
    private readonly transport: BrowserToolTransport,
    private readonly config: Required<BrowserToolBrokerConfig>,
    private readonly onDispose: () => void,
  ) {}

  update(tools: readonly BrowserToolDescriptor[]): void {
    if (this.disposed) throw new Error('Browser Tool lease is disposed')
    const prepared = prepareTools(tools, this.config.maxTools)
    for (const tool of prepared) {
      const own = this.registrations.get(tool.descriptor.name)
      const visible = this.ctx.tools.get(tool.descriptor.name, this.agent)
      if (own === undefined && visible !== undefined) {
        throw new Error(`Browser Tool ${tool.descriptor.name} collides with an Agent-visible Tool`)
      }
    }

    const incoming = new Map(prepared.map((tool) => [tool.descriptor.name, tool]))
    for (const [name, registration] of this.registrations) {
      const next = incoming.get(name)
      if (next !== undefined && next.fingerprint === registration.fingerprint) continue
      registration.dispose()
      this.registrations.delete(name)
    }
    for (const tool of prepared) {
      if (this.registrations.has(tool.descriptor.name)) continue
      const dispose = this.agent.ctx.tools.register(this.definitionFor(tool))
      this.registrations.set(tool.descriptor.name, {
        dispose,
        fingerprint: tool.fingerprint,
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.invocations) {
      controller.abort(new Error('Browser Tool lease was released'))
    }
    this.invocations.clear()
    for (const registration of this.registrations.values()) registration.dispose()
    this.registrations.clear()
    this.onDispose()
  }

  private definitionFor(tool: PreparedTool): ToolDefinition {
    return {
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      parameters: tool.schema,
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: tool.descriptor.description,
        rawInput: args,
      }),
      isConcurrencySafe: () => true,
      timeoutMs: this.config.toolTimeoutMs,
      execute: (args, exec) => this.invoke(tool, args, exec),
    }
  }

  private async invoke(
    tool: PreparedTool,
    args: unknown,
    exec: ToolRunContext,
  ): Promise<string> {
    if (this.disposed) throw new Error('Browser Tool lease is no longer active')
    const violations = validateJsonSchemaValue(tool.schema, args, '')
    if (violations.length > 0) {
      throw new Error(`Invalid browser Tool arguments: ${violations.join('; ')}`)
    }

    const controller = new AbortController()
    this.invocations.add(controller)
    const onAbort = (): void => controller.abort(exec.signal.reason)
    exec.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('Browser Tool result timed out')),
      this.config.toolTimeoutMs,
    )
    try {
      return await this.transport.invoke(
        {
          callId: String(exec.callId),
          name: tool.descriptor.name,
          arguments: args,
        },
        controller.signal,
      )
    } finally {
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', onAbort)
      this.invocations.delete(controller)
    }
  }
}

function prepareTools(
  tools: readonly BrowserToolDescriptor[],
  maximum: number,
): PreparedTool[] {
  if (tools.length > maximum) {
    throw new Error(`Browser Tool lease exceeds its ${String(maximum)} tool limit`)
  }
  const names = new Set<string>()
  return tools.map((descriptor) => {
    if (!BROWSER_TOOL_NAME.test(descriptor.name)) {
      throw new TypeError(`Invalid browser Tool name: ${descriptor.name}`)
    }
    if (!descriptor.description.trim()) {
      throw new TypeError(`Browser Tool ${descriptor.name} has no description`)
    }
    if (names.has(descriptor.name)) {
      throw new TypeError(`Duplicate browser Tool name: ${descriptor.name}`)
    }
    names.add(descriptor.name)
    assertObjectJsonSchema(descriptor.parameters)
    const schema = structuredClone(descriptor.parameters)
    return {
      descriptor: { ...descriptor, parameters: schema },
      fingerprint: valueDigest({
        name: descriptor.name,
        description: descriptor.description,
        parameters: schema,
      }),
      schema,
    }
  })
}

function assertPositiveConfig(config: Required<BrowserToolBrokerConfig>): void {
  if (config.maxTools <= 0 || config.toolTimeoutMs <= 0) {
    throw new TypeError('Browser Tool broker limits must be positive')
  }
}

export default BrowserToolBroker
