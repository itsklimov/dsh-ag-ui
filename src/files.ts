import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AgUiGatewayError, publicError } from './errors.ts'
import type { ThreadBinding } from './thread.ts'
import type { AgUiPrincipal } from './types.ts'

interface FileRouteOptions {
  readonly path: string
  readonly maxFileBytes: number
  authenticate(request: IncomingMessage): AgUiPrincipal
  validateThreadId(threadId: string): void
  bindingFor(principal: AgUiPrincipal, threadId: string): Promise<ThreadBinding>
  existingBinding(principal: AgUiPrincipal, threadId: string): ThreadBinding | undefined
  respondError(response: ServerResponse, error: AgUiGatewayError): void
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
}

/**
 * Reduce a decoded client file name to one safe direct child name.
 * @param value - decoded UTF-8 file name supplied by the trusted BFF.
 * @returns a basename safe to join below a thread uploads directory.
 */
export function sanitizeFileName(value: string): string {
  // oxlint-disable-next-line no-control-regex -- the wire contract explicitly strips ASCII control characters.
  const name = value.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name === '' || name === '.' || name === '..' || name.startsWith('.') || Buffer.byteLength(name) > 255) {
    throw new AgUiGatewayError('INVALID_FILE_NAME', 'The file name is invalid.', 400)
  }
  return name
}

/**
 * Build the authenticated thread-file prefix handler owned by one Gateway.
 * @param options - Gateway callbacks and resolved file limits.
 * @returns a WebServer route handler for uploads and downloads.
 */
export function createFileRoute(options: FileRouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://ag-ui.local').pathname
      const relative = pathname.startsWith(`${options.path}/threads/`)
        ? pathname.slice(`${options.path}/threads/`.length)
        : ''
      const upload = /^([^/]+)\/files$/.exec(relative)
      if (upload !== null) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          throw new AgUiGatewayError('METHOD_NOT_ALLOWED', 'File uploads accept POST requests only.', 405)
        }
        const principal = options.authenticate(request)
        const threadId = decodeThreadId(upload[1]!)
        options.validateThreadId(threadId)
        await uploadFile(request, response, principal, threadId, options)
        return
      }

      const download = /^([^/]+)\/files\/([^/]+)$/.exec(relative)
      if (download !== null) {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET')
          throw new AgUiGatewayError('METHOD_NOT_ALLOWED', 'File downloads accept GET requests only.', 405)
        }
        const principal = options.authenticate(request)
        const threadId = decodeThreadId(download[1]!)
        options.validateThreadId(threadId)
        await downloadFile(response, principal, threadId, download[2]!, options)
        return
      }

      throw new AgUiGatewayError('NOT_FOUND', 'The requested AG-UI route was not found.', 404)
    } catch (error) {
      options.respondError(response, publicError(error))
    }
  }
}

async function uploadFile(
  request: IncomingMessage,
  response: ServerResponse,
  principal: AgUiPrincipal,
  threadId: string,
  options: FileRouteOptions,
): Promise<void> {
  const declared = requiredLength(request, options.maxFileBytes)
  const encodedName = singleHeader(request.headers['x-file-name'])
  if (encodedName === undefined) throw new AgUiGatewayError('INVALID_FILE_NAME', 'The x-file-name header is required.', 400)
  const requestedName = sanitizeFileName(decodeFileName(encodedName))
  const mimeType = singleHeader(request.headers['content-type']) ?? 'application/octet-stream'
  const binding = await options.bindingFor(principal, threadId)
  const workspace = binding.workspace
  if (workspace === undefined) {
    throw new AgUiGatewayError('THREAD_WITHOUT_WORKSPACE', 'The AG-UI thread has no workspace for uploaded files.', 409)
  }
  const name = await availableName(workspace.uploadsDir, requestedName)
  const target = join(workspace.uploadsDir, name)
  const temporary = join(workspace.uploadsDir, `.${name}.part`)
  const hash = createHash('sha256')
  let bytes = 0
  let exceeded = false
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > options.maxFileBytes) {
        exceeded = true
        const error = fileTooLarge()
        request.destroy(error)
        callback(error)
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(request, counter, createWriteStream(temporary))
  } catch (error) {
    await rm(temporary, { force: true })
    if (exceeded) throw fileTooLarge()
    if (!request.complete) return
    throw error
  }
  if (bytes !== declared) {
    await rm(temporary, { force: true })
    throw new AgUiGatewayError('CONTENT_LENGTH_MISMATCH', 'The file body does not match Content-Length.', 400)
  }
  await rename(temporary, target)
  const body = JSON.stringify({
    type: 'url',
    value: `${options.path}/threads/${encodeURIComponent(threadId)}/files/${encodeURIComponent(name)}`,
    mimeType,
    metadata: { filename: name, size: bytes, sha256: hash.digest('hex') },
  })
  response.writeHead(201, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function downloadFile(
  response: ServerResponse,
  principal: AgUiPrincipal,
  threadId: string,
  encodedName: string,
  options: FileRouteOptions,
): Promise<void> {
  const binding = options.existingBinding(principal, threadId)
  const workspace = binding?.workspace
  if (workspace === undefined) throw fileNotFound()
  const decodedName = decodeFileName(encodedName)
  if (/[\\/]/.test(decodedName)) throw new AgUiGatewayError('INVALID_FILE_NAME', 'The file name is invalid.', 400)
  const name = sanitizeFileName(decodedName)
  const path = join(workspace.uploadsDir, name)
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if (isMissing(error)) throw fileNotFound()
    throw error
  }
  if (!details.isFile()) throw fileNotFound()
  response.writeHead(200, {
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'content-length': details.size,
    'content-type': MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
  })
  await pipeline(createReadStream(path), response)
}

function requiredLength(request: IncomingMessage, maximum: number): number {
  const value = singleHeader(request.headers['content-length'])
  if (value === undefined) throw new AgUiGatewayError('LENGTH_REQUIRED', 'Content-Length is required for file uploads.', 411)
  if (!/^\d+$/.test(value)) throw new AgUiGatewayError('INVALID_CONTENT_LENGTH', 'Content-Length must be a non-negative integer.', 400)
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw fileTooLarge()
  if (length > maximum) throw fileTooLarge()
  return length
}

function decodeThreadId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    throw new AgUiGatewayError('INVALID_IDENTITY', 'The thread identifier is invalid.', 400, error)
  }
}

function decodeFileName(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    throw new AgUiGatewayError('INVALID_FILE_NAME', 'The file name is invalid.', 400, error)
  }
}

async function availableName(directory: string, requested: string): Promise<string> {
  const extension = extname(requested)
  const stem = requested.slice(0, requested.length - extension.length)
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? requested : `${stem}-${String(number)}${extension}`
    try {
      await stat(join(directory, candidate))
    } catch (error) {
      if (isMissing(error)) return candidate
      throw error
    }
  }
}

function fileTooLarge(): AgUiGatewayError {
  return new AgUiGatewayError('FILE_TOO_LARGE', 'The uploaded file exceeds its byte limit.', 413)
}

function fileNotFound(): AgUiGatewayError {
  return new AgUiGatewayError('FILE_NOT_FOUND', 'The requested file was not found.', 404)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
