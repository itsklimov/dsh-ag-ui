export const name = 'preset-alpha-tool'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'preset_alpha_probe',
    description: 'Report the marker of the alpha deployment preset.',
    parameters: {
      type: 'object',
      properties: { probe: { type: 'string' } },
      required: ['probe'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'unexpected' }],
    },
    isConcurrencySafe: () => true,
    execute: async ({ probe }) => JSON.stringify({ probe, preset: 'alpha', marker: 'alpha-tool-live' }),
  }), 'preset.alpha.tool')
}
