// A host plugin that installs a no-op SIGTERM handler, simulating a child
// that ignores a graceful shutdown request, for the stop-escalation spec.
process.on('SIGTERM', () => {})

export const name = 'dsh-ag-ui-adapter/sigterm-shield'

export function apply() {}
