import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgUiGateway, { type Config } from 'dsh-ag-ui'
import { createFileRoute, sanitizeFileName } from '../src/files.ts'
import { durableSessionId } from '../src/session-id.ts'
import type { ThreadBinding } from '../src/thread.ts'
import type { AgUiPrincipal } from '../src/types.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { ScriptedAdapter } from './scripted-adapter.ts'

const SECRET = 'test-only-ag-ui-shared-secret'
const PRINCIPAL = { tenantId: 'tenant-1', userId: 'user-1' }
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': PRINCIPAL.tenantId,
  'x-dsh-user-id': PRINCIPAL.userId,
}
const LEGACY_SECRET = 'resume-test-shared-secret'
const LEGACY_PRINCIPAL = { tenantId: 'tenant-resume', userId: 'user-resume' }
const LEGACY_THREAD = 'thread-resume'
const LEGACY_FIXTURE = fileURLToPath(new URL('./fixtures/sessions/dsh-0.1.1-rc.2.jsonl', import.meta.url))

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(overrides: Partial<Config> = {}, persistenceRoot?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestAgentCore(ctx)
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([]))
  if (persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  const workspaceRoot = overrides.workspaceRoot ?? await mkdtemp(join(tmpdir(), 'ag-ui-files-workspaces-'))
  if (overrides.workspaceRoot === undefined) roots.push(workspaceRoot)
  await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    workspaceRoot,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
    ...overrides,
  })
  return { ctx, workspaceRoot, url: `http://127.0.0.1:${String(ctx.webServer.port)}${overrides.path ?? '/ag-ui'}` }
}

function workspacePath(root: string, threadId = 'thread-1', principal: AgUiPrincipal = PRINCIPAL, secret = SECRET): string {
  return join(root, String(durableSessionId(principal, threadId, secret)))
}

async function upload(
  url: string,
  body: BodyInit,
  name = 'note.txt',
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/threads/thread-1/files`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), ...headers },
    body,
  })
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ code })
}

function rawRequest(
  url: string,
  options: { method?: string, headers?: Record<string, string>, writes?: readonly Buffer[], abort?: boolean } = {},
): Promise<{ status: number, body: Buffer, headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (result: { status: number, body: Buffer, headers: import('node:http').IncomingHttpHeaders }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const request = httpRequest(url, { method: options.method ?? 'POST', headers: options.headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => settle({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers }))
    })
    request.on('error', (error) => {
      if (options.abort === true) settle({ status: 0, body: Buffer.alloc(0), headers: {} })
      else reject(error)
    })
    request.on('close', () => {
      if (options.abort === true) settle({ status: 0, body: Buffer.alloc(0), headers: {} })
    })
    for (const chunk of options.writes ?? []) request.write(chunk)
    if (options.abort === true) setTimeout(() => request.destroy(), 10)
    else request.end()
  })
}

function uploadRepeated(url: string, chunk: Buffer, count: number): Promise<{ status: number, body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.byteLength * count),
        'x-file-name': 'large.bin',
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (item: Buffer) => { chunks.push(item) })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    let written = 0
    const write = (): void => {
      while (written < count) {
        written += 1
        if (!request.write(chunk)) {
          request.once('drain', write)
          return
        }
      }
      request.end()
    }
    write()
  })
}

async function waitForNoParts(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readdir(directory)).every(name => !name.endsWith('.part'))) return
    } catch {
      // The upload may still be creating its workspace.
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect((await readdir(directory)).filter(name => name.endsWith('.part'))).toEqual([])
}

interface DirectRouteInput {
  readonly root?: string
  readonly url?: string
  readonly method?: string
  readonly headers?: Record<string, string | string[] | undefined>
  readonly body?: Buffer
  readonly maximum?: number
  readonly workspace?: 'present' | 'missing'
  readonly existing?: 'present' | 'missing'
  readonly complete?: boolean
  readonly stream?: Readable
  readonly prepareUploads?: boolean
}

async function directRoute(input: DirectRouteInput = {}): Promise<{
  root: string
  status: number
  code: string | undefined
  headers: Record<string, string | number>
  body: Buffer
}> {
  const root = input.root ?? await mkdtemp(join(tmpdir(), 'ag-ui-file-direct-'))
  if (input.root === undefined) roots.push(root)
  const uploadsDir = join(root, 'uploads')
  if (input.prepareUploads !== false) await mkdir(uploadsDir, { recursive: true })
  const request = (input.stream ?? Readable.from([input.body ?? Buffer.alloc(0)])) as Readable & {
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
    complete: boolean
    aborted: boolean
  }
  request.method = input.method ?? 'POST'
  request.url = input.url ?? '/ag-ui/threads/thread-1/files'
  request.headers = input.headers ?? {
    'content-length': String(input.body?.byteLength ?? 0),
    'x-file-name': 'direct.txt',
  }
  request.complete = input.complete ?? true
  request.aborted = !request.complete

  const response = new PassThrough()
  const responseBody: Buffer[] = []
  response.on('data', (chunk: Buffer) => { responseBody.push(chunk) })
  let status = 0
  let code: string | undefined
  const headers: Record<string, string | number> = {}
  Object.assign(response, {
    setHeader(name: string, value: string | number) {
      headers[name] = value
      return response
    },
    writeHead(value: number, values: Record<string, string | number>) {
      status = value
      Object.assign(headers, values)
      return response
    },
  })
  const binding = { workspace: input.workspace === 'missing' ? undefined : { cwd: root, uploadsDir } } as ThreadBinding
  const route = createFileRoute({
    path: '/ag-ui',
    maxFileBytes: input.maximum ?? 1024,
    authenticate: () => PRINCIPAL,
    validateThreadId: (threadId) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(threadId)) throw new Error('invalid test identity')
    },
    bindingFor: async () => binding,
    existingBinding: () => input.existing === 'missing' ? undefined : binding,
    respondError: (_response, error) => {
      status = error.status
      code = error.code
      response.end(JSON.stringify({ code }))
    },
  })
  await route(request as never, response as never)
  return { root, status, code, headers, body: Buffer.concat(responseBody) }
}

describe('file name sanitizing', () => {
  it('keeps only a clean direct basename', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('folder\\report\u0000.txt\u007f ')).toBe('report.txt')
  })

  it.each(['', ' ', '.', '..', '.hidden', '/\u0000', 'x'.repeat(256)])('rejects invalid name %j', (name) => {
    expect(() => sanitizeFileName(name)).toThrow(expect.objectContaining({ code: 'INVALID_FILE_NAME' }))
  })
})

describe('thread file HTTP routes', () => {
  it('uploads empty and 1 MiB files with metadata and no temporary files', async () => {
    const mounted = await mount()
    const empty = await upload(mounted.url, Buffer.alloc(0), 'empty.bin', { 'content-type': 'application/octet-stream' })
    expect(empty.status).toBe(201)
    expect(await empty.json()).toEqual({
      type: 'url',
      value: '/ag-ui/threads/thread-1/files/empty.bin',
      mimeType: 'application/octet-stream',
      metadata: { filename: 'empty.bin', size: 0, sha256: createHash('sha256').digest('hex') },
    })

    const bytes = Buffer.alloc(1024 * 1024, 0x5a)
    const response = await upload(mounted.url, bytes, 'sample.dat')
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      mimeType: 'text/plain',
      metadata: {
        filename: 'sample.dat',
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    })
    const uploads = join(workspacePath(mounted.workspaceRoot), 'uploads')
    expect(await readFile(join(uploads, 'sample.dat'))).toEqual(bytes)
    expect((await readdir(uploads)).filter(name => name.endsWith('.part'))).toEqual([])
  }, 15_000)

  it('accepts the exact limit and rejects a declared byte over it without artifacts', async () => {
    const mounted = await mount({ maxFileBytes: 4 })
    expect((await upload(mounted.url, Buffer.from('1234'), 'exact.txt')).status).toBe(201)
    await expectCode(await upload(mounted.url, Buffer.from('12345'), 'large.txt'), 413, 'FILE_TOO_LARGE')
    const uploads = join(workspacePath(mounted.workspaceRoot), 'uploads')
    expect(await readdir(uploads)).toEqual(['exact.txt'])
  })

  it('validates required headers, names, authentication, and thread identity', async () => {
    const mounted = await mount({ maxIdentityBytes: 8 })
    const endpoint = `${mounted.url}/threads/thread-1/files`
    const missingLength = await rawRequest(endpoint, { headers: { ...HEADERS, 'transfer-encoding': 'chunked', 'x-file-name': 'x' } })
    await expectCode(new Response(missingLength.body, { status: missingLength.status }), 411, 'LENGTH_REQUIRED')

    await expectCode(await fetch(endpoint, { method: 'POST', headers: HEADERS, body: Buffer.from('x') }), 400, 'INVALID_FILE_NAME')
    await expectCode(await fetch(endpoint, { method: 'POST', headers: { ...HEADERS, authorization: 'Bearer wrong', 'x-file-name': 'x' }, body: Buffer.from('x') }), 401, 'UNAUTHORIZED')
    await expectCode(await fetch(`${mounted.url}/threads/thread-too-long/files`, { method: 'POST', headers: { ...HEADERS, 'x-file-name': 'x' }, body: Buffer.from('x') }), 400, 'INVALID_IDENTITY')
    await expectCode(await upload(mounted.url, Buffer.from('x'), '..'), 400, 'INVALID_FILE_NAME')
  })

  it('reduces traversal names to a basename without escaping uploads', async () => {
    const mounted = await mount()
    const response = await fetch(`${mounted.url}/threads/thread-1/files`, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'text/plain', 'x-file-name': '..%2F..%2Fetc%2Fpasswd' },
      body: Buffer.from('safe'),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ metadata: { filename: 'passwd' } })
    expect(await readFile(join(workspacePath(mounted.workspaceRoot), 'uploads', 'passwd'), 'utf8')).toBe('safe')
    await expect(stat(join(mounted.workspaceRoot, 'passwd'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adds the first free numeric suffix for repeated names', async () => {
    const mounted = await mount()
    expect((await upload(mounted.url, Buffer.from('one'), 'name.ext')).status).toBe(201)
    const second = await upload(mounted.url, Buffer.from('two'), 'name.ext')
    expect(await second.json()).toMatchObject({ metadata: { filename: 'name-2.ext' } })
    const uploads = join(workspacePath(mounted.workspaceRoot), 'uploads')
    expect(await readFile(join(uploads, 'name.ext'), 'utf8')).toBe('one')
    expect(await readFile(join(uploads, 'name-2.ext'), 'utf8')).toBe('two')
  })

  it('removes the partial file when the client disconnects', async () => {
    const mounted = await mount()
    const endpoint = `${mounted.url}/threads/thread-1/files`
    expect((await upload(mounted.url, Buffer.alloc(0), 'kept.bin')).status).toBe(201)
    await rawRequest(endpoint, {
      headers: { ...HEADERS, 'content-type': 'application/octet-stream', 'content-length': '1000', 'x-file-name': 'aborted.bin' },
      writes: [Buffer.alloc(100)],
      abort: true,
    })
    const uploads = join(workspacePath(mounted.workspaceRoot), 'uploads')
    await waitForNoParts(uploads)
    expect(await readdir(uploads)).toEqual(['kept.bin'])
  })

  it('downloads exact bytes with fixed media headers and isolates bindings', async () => {
    const mounted = await mount()
    const bytes = Buffer.from('{"ok":true}')
    const created = await upload(mounted.url, bytes, 'result.JSON')
    const location = (await created.json() as { value: string }).value
    const downloaded = await fetch(`http://127.0.0.1:${String(mounted.ctx.webServer.port)}${location}`, { headers: HEADERS })
    expect(downloaded.status).toBe(200)
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes)
    expect(downloaded.headers.get('content-type')).toBe('application/json')
    expect(downloaded.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(downloaded.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''result.JSON")

    await expectCode(await fetch(`${mounted.url}/threads/never-created/files/no.txt`, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    await expectCode(await fetch(`http://127.0.0.1:${String(mounted.ctx.webServer.port)}${location}`, {
      headers: { ...HEADERS, 'x-dsh-tenant-id': 'tenant-2' },
    }), 404, 'FILE_NOT_FOUND')
    await expectCode(await fetch(`${mounted.url}/threads/thread-1/files/nested/name.txt`, { headers: HEADERS }), 404, 'NOT_FOUND')
    await expectCode(await fetch(`${mounted.url}/threads/thread-1/files/nested%2Fname.txt`, { headers: HEADERS }), 400, 'INVALID_FILE_NAME')
  })

  it('rejects unknown paths and wrong methods with route-specific allow headers', async () => {
    const mounted = await mount()
    await expectCode(await fetch(`${mounted.url}/threads`, { headers: HEADERS }), 404, 'NOT_FOUND')
    const uploadMethod = await fetch(`${mounted.url}/threads/thread-1/files`, { method: 'GET', headers: HEADERS })
    expect(uploadMethod.headers.get('allow')).toBe('POST')
    await expectCode(uploadMethod, 405, 'METHOD_NOT_ALLOWED')
    const downloadMethod = await fetch(`${mounted.url}/threads/thread-1/files/x.txt`, { method: 'POST', headers: { ...HEADERS, 'content-length': '0' } })
    expect(downloadMethod.headers.get('allow')).toBe('GET')
    await expectCode(downloadMethod, 405, 'METHOD_NOT_ALLOWED')
  })

  it('streams 64 MiB without retaining the file in memory', async () => {
    const mounted = await mount({ maxFileBytes: 64 * 1024 * 1024 })
    const chunk = Buffer.alloc(64 * 1024, 0x37)
    const before = process.memoryUsage().rss
    const response = await uploadRepeated(`${mounted.url}/threads/thread-1/files`, chunk, 1024)
    expect(response.status).toBe(201)
    expect(process.memoryUsage().rss - before).toBeLessThan(32 * 1024 * 1024)
    expect((await stat(join(workspacePath(mounted.workspaceRoot), 'uploads', 'large.bin'))).size).toBe(64 * 1024 * 1024)
  })

  it('returns 409 when a resumed legacy thread has no workspace', async () => {
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'ag-ui-file-legacy-'))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ag-ui-file-legacy-workspaces-'))
    roots.push(persistenceRoot, workspaceRoot)
    const sessionId = durableSessionId(LEGACY_PRINCIPAL, LEGACY_THREAD, LEGACY_SECRET)
    const sessionDir = join(persistenceRoot, '_no-cwd', String(sessionId))
    await mkdir(sessionDir, { recursive: true })
    const fixture = await readFile(LEGACY_FIXTURE, 'utf8')
    await writeFile(join(sessionDir, 'session.jsonl'), fixture.replace('ag-ui-0c27b585ac1d7528dde9c37ee11ef9ff51f4d310', String(sessionId)), 'utf8')
    const mounted = await mount({ sharedSecret: LEGACY_SECRET, workspaceRoot }, persistenceRoot)
    const response = await fetch(`${mounted.url}/threads/${LEGACY_THREAD}/files`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LEGACY_SECRET}`,
        'x-dsh-tenant-id': LEGACY_PRINCIPAL.tenantId,
        'x-dsh-user-id': LEGACY_PRINCIPAL.userId,
        'x-file-name': 'legacy.txt',
      },
      body: Buffer.from('x'),
    })
    await expectCode(response, 409, 'THREAD_WITHOUT_WORKSPACE')
  })
})

describe('file route stream failures', () => {
  async function invoke(body: Buffer, declared: string, maximum: number): Promise<string | undefined> {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-file-route-'))
    roots.push(root)
    const uploadsDir = join(root, 'uploads')
    await mkdir(uploadsDir)
    const request = Readable.from([body]) as Readable & {
      method: string
      url: string
      headers: Record<string, string>
      complete: boolean
      aborted: boolean
    }
    request.method = 'POST'
    request.url = '/ag-ui/threads/thread-1/files'
    request.headers = { 'content-length': declared, 'x-file-name': 'unit.bin' }
    request.complete = true
    request.aborted = false
    let code: string | undefined
    const route = createFileRoute({
      path: '/ag-ui',
      maxFileBytes: maximum,
      authenticate: () => PRINCIPAL,
      validateThreadId: () => {},
      bindingFor: async () => ({ workspace: { cwd: root, uploadsDir } }) as ThreadBinding,
      existingBinding: () => undefined,
      respondError: (_response, error) => { code = error.code },
    })
    await route(request as never, {} as never)
    expect((await readdir(uploadsDir)).filter(name => name.endsWith('.part'))).toEqual([])
    return code
  }

  it('rejects streamed overflow and completed length mismatch', async () => {
    expect(await invoke(Buffer.from('12345'), '4', 4)).toBe('FILE_TOO_LARGE')
    expect(await invoke(Buffer.from('123'), '4', 4)).toBe('CONTENT_LENGTH_MISMATCH')
  })

  it('handles uploads directly, including defaults, suffixes, and header failures', async () => {
    const first = await directRoute({ body: Buffer.from('first') })
    expect(first.status).toBe(201)
    expect(first.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(first.body.toString())).toMatchObject({
      mimeType: 'application/octet-stream',
      metadata: { filename: 'direct.txt', size: 5 },
    })
    const second = await directRoute({ root: first.root, body: Buffer.from('second') })
    expect(JSON.parse(second.body.toString())).toMatchObject({ metadata: { filename: 'direct-2.txt' } })

    expect((await directRoute({ headers: {} })).code).toBe('LENGTH_REQUIRED')
    expect((await directRoute({ headers: { 'content-length': ['0'], 'x-file-name': 'x' } })).code).toBe('LENGTH_REQUIRED')
    expect((await directRoute({ headers: { 'content-length': '-1', 'x-file-name': 'x' } })).code).toBe('INVALID_CONTENT_LENGTH')
    expect((await directRoute({ headers: { 'content-length': '999999999999999999999', 'x-file-name': 'x' } })).code).toBe('FILE_TOO_LARGE')
    expect((await directRoute({ headers: { 'content-length': '2', 'x-file-name': 'x' }, maximum: 1 })).code).toBe('FILE_TOO_LARGE')
    expect((await directRoute({ headers: { 'content-length': '0', 'x-file-name': ['x'] } })).code).toBe('INVALID_FILE_NAME')
    expect((await directRoute({ headers: { 'content-length': '0', 'x-file-name': '%' } })).code).toBe('INVALID_FILE_NAME')
    expect((await directRoute({ workspace: 'missing' })).code).toBe('THREAD_WITHOUT_WORKSPACE')
  })

  it('dispatches paths and methods and rejects malformed path identities', async () => {
    expect((await directRoute({ method: 'GET' })).code).toBe('METHOD_NOT_ALLOWED')
    expect((await directRoute({ url: '/ag-ui/threads/thread-1/files/x.txt', method: 'POST' })).code).toBe('METHOD_NOT_ALLOWED')
    expect((await directRoute({ url: '/ag-ui/threads' })).code).toBe('NOT_FOUND')
    expect((await directRoute({ url: '/ag-ui/threads/%/files' })).code).toBe('INVALID_IDENTITY')
    expect((await directRoute({ url: '/ag-ui/threads/%/files/x.txt', method: 'GET' })).code).toBe('INVALID_IDENTITY')
  })

  it('downloads regular files with known and fallback media types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-file-download-'))
    roots.push(root)
    await mkdir(join(root, 'uploads'), { recursive: true })
    await writeFile(join(root, 'uploads', 'image.png'), Buffer.from('png'))
    await writeFile(join(root, 'uploads', 'opaque.bin'), Buffer.from('bin'))
    const image = await directRoute({ root, url: '/ag-ui/threads/thread-1/files/image.png', method: 'GET' })
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.body).toEqual(Buffer.from('png'))
    const opaque = await directRoute({ root, url: '/ag-ui/threads/thread-1/files/opaque.bin', method: 'GET' })
    expect(opaque.headers['content-type']).toBe('application/octet-stream')

    expect((await directRoute({ root, url: '/ag-ui/threads/thread-1/files/missing.txt', method: 'GET' })).code).toBe('FILE_NOT_FOUND')
    expect((await directRoute({ root, url: '/ag-ui/threads/thread-1/files/x.txt', method: 'GET', existing: 'missing' })).code).toBe('FILE_NOT_FOUND')
    await mkdir(join(root, 'uploads', 'directory'))
    expect((await directRoute({ root, url: '/ag-ui/threads/thread-1/files/directory', method: 'GET' })).code).toBe('FILE_NOT_FOUND')
    expect((await directRoute({ root, url: '/ag-ui/threads/thread-1/files/nested%2Fimage.png', method: 'GET' })).code).toBe('INVALID_FILE_NAME')
    expect((await directRoute({ root, url: '/ag-ui/threads/thread-1/files/%', method: 'GET' })).code).toBe('INVALID_FILE_NAME')
  })

  it('cleans interrupted writes and reports unexpected stream and filesystem failures', async () => {
    const interrupted = new Readable({
      read() {
        this.push(Buffer.from('part'))
        this.destroy(new Error('disconnected'))
      },
    })
    const stopped = await directRoute({
      stream: interrupted,
      complete: false,
      headers: { 'content-length': '10', 'x-file-name': 'part.bin' },
    })
    expect(stopped.status).toBe(0)
    expect((await readdir(join(stopped.root, 'uploads'))).filter(name => name.endsWith('.part'))).toEqual([])

    const failed = new Readable({ read() { this.destroy(new Error('read failed')) } })
    expect((await directRoute({
      stream: failed,
      headers: { 'content-length': '1', 'x-file-name': 'failed.bin' },
    })).code).toBe('AGENT_EXECUTION_ERROR')

    const badRoot = await mkdtemp(join(tmpdir(), 'ag-ui-file-not-directory-'))
    roots.push(badRoot)
    await writeFile(join(badRoot, 'uploads'), 'not a directory')
    expect((await directRoute({ root: badRoot, body: Buffer.from('x'), prepareUploads: false })).code).toBe('AGENT_EXECUTION_ERROR')
    expect((await directRoute({ root: badRoot, url: '/ag-ui/threads/thread-1/files/x.txt', method: 'GET', prepareUploads: false })).code).toBe('AGENT_EXECUTION_ERROR')
  })
})
