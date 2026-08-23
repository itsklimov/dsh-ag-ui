/** HTTP or streamed failure with a stable AG-UI Gateway code. */
export class AgUiGatewayError extends Error {
  /**
   * @param code - stable public failure category.
   * @param message - correction-oriented message without secrets.
   * @param status - HTTP status used before an SSE response starts.
   * @param cause - optional contained internal error.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgUiGatewayError'
  }
}

/**
 * Convert an unknown failure without leaking stacks.
 * @param error - failure crossing the HTTP boundary.
 * @returns the existing public failure or a generic internal Gateway error.
 */
export function publicError(error: unknown): AgUiGatewayError {
  return error instanceof AgUiGatewayError
    ? error
    : new AgUiGatewayError('AGENT_EXECUTION_ERROR', 'The Agent run failed.', 500, error)
}
