import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class ScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream() {
    const text = 'The standalone AG-UI bundle is running.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'scripted-model'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
}
