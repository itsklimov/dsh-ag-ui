import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'

/**
 * Mount the published test spine and wait for its asynchronously spawned
 * AgentLoop child to become active before a test creates an Agent directly.
 */
export async function mountTestSpine(ctx: Context, persona = 'Test persona.'): Promise<void> {
  const ready = Promise.withResolvers<void>()
  const dispose = ctx.on('internal/status', (fiber: Fiber) => {
    if (fiber.runtime?.name !== 'AgentLoop') return
    if (fiber.state === 2) ready.resolve()
    else if (fiber.state === 3) ready.reject(new Error('The test AgentLoop failed to start.'))
  })
  try {
    await ctx.plugin(AgentSpine, {
      workspaceContext: false,
      skills: { enabled: false },
      toolBash: false,
      toolJobs: false,
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona,
    })
    await ready.promise
  } finally {
    dispose()
  }
}
