/** Shared configuration shapes of the embedded adapter. */

/**
 * One caller-supplied row of the generated micro-host overlay, appended in
 * order between the webserver and the gateway. This is where an embedding
 * application composes its agent spine and model adapter.
 */
export interface HostPluginRow {
  /** Stable entry id inside the overlay; defaults to `plugin-<index>`. */
  readonly id?: string | undefined
  /**
   * Module specifier of the Cordis plugin. A `file:` URL or an absolute path
   * is used verbatim; a bare specifier must resolve from this package's own
   * module graph (install the plugin next to `dsh-ag-ui-adapter`).
   */
  readonly name: string
  /** Raw plugin config written into the overlay row. */
  readonly config?: Readonly<Record<string, unknown>> | undefined
}

/** The gateway row of the generated micro-host overlay. */
export interface DshGatewayOptions {
  /** Registered DSH model provider route served by the micro-host. */
  readonly provider: string
  /** Model ID owned by the provider. */
  readonly model: string
  /** Exact Host HTTP route of the gateway; defaults to `/ag-ui`. */
  readonly path?: string | undefined
  /**
   * Remaining gateway row config, merged after the adapter-owned values. Use
   * this for resource bounds such as `maxRunEvents` or `threadIdleMs`.
   */
  readonly overrides?: Readonly<Record<string, unknown>> | undefined
}
