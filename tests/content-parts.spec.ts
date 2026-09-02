import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type InputContent, type RunAgentInput } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import {
  AttachmentError,
  type AttachmentStore,
  type ImageAttachmentRef,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ThreadBinding, type ThreadOptions } from '../src/thread.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { ScriptedAdapter, textResponse } from './scripted-adapter.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const OPTIONS = {
  provider: 'scripted',
  model: 'scripted',
  frontendToolTimeoutMs: 10_000,
  threadIdleMs: 60_000,
  maxRunEvents: 128,
  maxRunEventBytes: 128 * 1024,
  maxRunsPerThread: 8,
  maxStateBytes: 64 * 1024,
  maxFilesPerMessage: 8,
} satisfies Omit<ThreadOptions, 'workspaceRoot'>

const contexts: Context[] = []
const workspaceRoots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(workspaceRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface FakeAttachments {
  readonly saved: SaveImageAttachment[][]
  readonly store: AttachmentStore
}

function imageRef(input: SaveImageAttachment, index: number): ImageAttachmentRef {
  return {
    attachmentId: `fake-${String(index)}` as ImageAttachmentRef['attachmentId'],
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...(input.name === undefined ? {} : { name: input.name }),
  }
}

function fakeAttachments(failure?: Error): FakeAttachments {
  const saved: SaveImageAttachment[][] = []
  const saveImage = vi.fn(async (input: SaveImageAttachment) => imageRef(input, saved.length))
  const store = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 8 * 1024 * 1024,
      maxImagePixels: 1024 * 1024,
      maxImageDimension: 1024,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    validateImage: vi.fn(async () => {}),
    saveImage,
    saveImages: vi.fn(async (inputs: readonly SaveImageAttachment[]) => {
      saved.push(inputs.map(input => ({ ...input, data: new Uint8Array(input.data) })))
      if (failure !== undefined) throw failure
      return inputs.map(imageRef)
    }),
  } as unknown as AttachmentStore
  return { saved, store }
}

async function mount(
  attachments?: FakeAttachments,
  overrides: Partial<ThreadOptions> = {},
): Promise<{ binding: ThreadBinding, attachments?: FakeAttachments }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestAgentCore(ctx)
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([textResponse('ok')]))
  if (attachments !== undefined) ctx.provide('attachments', attachments.store)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ag-ui-content-parts-'))
  workspaceRoots.push(workspaceRoot)
  const binding = new ThreadBinding(
    ctx,
    { tenantId: 'tenant-1', userId: 'user-1' },
    'thread-1',
    SessionId(`content-parts-${String(workspaceRoots.length)}`),
    { ...OPTIONS, workspaceRoot, ...overrides },
    () => {},
  )
  await binding.initialize()
  return { binding, ...(attachments === undefined ? {} : { attachments }) }
}

function input(runId: string, messageId: string, content: string | InputContent[]): RunAgentInput {
  return {
    threadId: 'thread-1',
    runId,
    messages: [{ id: messageId, role: 'user', content }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }
}

async function drive(binding: ThreadBinding, runId: string, messageId: string, content: string | InputContent[]) {
  const controller = binding.reserveRun(input(runId, messageId, content), `digest-${runId}`)
  binding.drive(controller)
  await controller.done
  return controller
}

function loggedUsers(binding: ThreadBinding): UserMessage[] {
  return binding.liveAgent.session.snapshotEvents().flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
}

function fileUrl(name: string, threadId = 'thread-1'): string {
  return `/api/threads/${encodeURIComponent(threadId)}/files/${encodeURIComponent(name)}`
}

describe('AG-UI user content parts', () => {
  it('keeps text order and describes a workspace file to the model', async () => {
    const { binding } = await mount()
    await writeFile(join(binding.workspace?.uploadsDir ?? '', 'report.csv'), 'hello world\n')
    const controller = await drive(binding, 'document', 'document-message', [
      { type: 'text', text: 'Review this report.' },
      { type: 'document', source: { type: 'url', value: fileUrl('report.csv'), mimeType: 'text/csv' } },
    ])
    expect(controller.record.events.at(-1)?.type).toBe('RUN_FINISHED')
    expect(loggedUsers(binding).at(-1)?.content).toEqual([
      { type: 'text', text: 'Review this report.' },
      { type: 'text', text: 'Attached file: uploads/report.csv (text/csv, 12 bytes)' },
    ])
  })

  it('admits an image file with its decoded bytes and name', async () => {
    const attachments = fakeAttachments()
    const { binding } = await mount(attachments)
    await writeFile(join(binding.workspace?.uploadsDir ?? '', 'pixel.png'), PNG)
    await drive(binding, 'image-url', 'image-url-message', [
      { type: 'image', source: { type: 'url', value: fileUrl('pixel.png'), mimeType: 'image/png' } },
    ])
    expect(Buffer.from(attachments.saved[0]?.[0]?.data ?? [])).toEqual(PNG)
    expect(attachments.saved[0]?.[0]?.name).toBe('pixel.png')
    expect(loggedUsers(binding).at(-1)?.content).toEqual([{
      type: 'image',
      attachment: expect.objectContaining({ attachmentId: 'fake-0', name: 'pixel.png' }),
    }])
  })

  it('admits inline image data without reading the workspace', async () => {
    const attachments = fakeAttachments()
    const { binding } = await mount(attachments)
    await drive(binding, 'image-data', 'image-data-message', [
      { type: 'image', source: { type: 'data', value: PNG.toString('base64'), mimeType: 'image/png' } },
    ])
    expect(Buffer.from(attachments.saved[0]?.[0]?.data ?? [])).toEqual(PNG)
    expect(attachments.saved[0]?.[0]?.name).toBeUndefined()
    expect(loggedUsers(binding).at(-1)?.content[0]?.type).toBe('image')
  })

  it('treats a URL part with an image media type as a native image', async () => {
    const attachments = fakeAttachments()
    const { binding } = await mount(attachments)
    await writeFile(join(binding.workspace?.uploadsDir ?? '', 'photo.webp'), PNG)
    await drive(binding, 'document-image', 'document-image-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('photo.webp'), mimeType: 'image/webp' } },
    ])
    expect(attachments.saved[0]?.[0]).toMatchObject({ mediaType: 'image/webp', name: 'photo.webp' })
  })

  it('uses the binary fallback media type for ordinary URL files', async () => {
    const { binding } = await mount()
    await writeFile(join(binding.workspace?.uploadsDir ?? '', 'notes.bin'), 'abc')
    await drive(binding, 'fallback-media', 'fallback-media-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('notes.bin') } },
    ])
    expect(loggedUsers(binding).at(-1)?.content).toEqual([
      { type: 'text', text: 'Attached file: uploads/notes.bin (application/octet-stream, 3 bytes)' },
    ])
  })

  it.each([
    ['another thread', fileUrl('report.csv', 'thread-2'), 'INVALID_CONTENT_PART'],
    ['foreign path', 'https://files.example.test/not-a-thread-file', 'INVALID_CONTENT_PART'],
    ['invalid URL', 'http://[', 'INVALID_CONTENT_PART'],
    ['invalid encoding', '/threads/thread-1/files/%E0%A4%A', 'INVALID_CONTENT_PART'],
    ['missing file', fileUrl('missing.csv'), 'FILE_NOT_FOUND'],
    ['nested name', fileUrl('nested/report.csv'), 'FILE_NOT_FOUND'],
    ['hidden name', fileUrl('.secret'), 'FILE_NOT_FOUND'],
  ])('rejects a %s URL before appending DSH input', async (_name, value, code) => {
    const { binding } = await mount()
    const controller = await drive(binding, `bad-url-${code}-${value.length}`, `bad-url-${value.length}`, [
      { type: 'document', source: { type: 'url', value, mimeType: 'text/csv' } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('rejects a non-regular upload entry', async () => {
    const { binding } = await mount()
    await mkdir(join(binding.workspace?.uploadsDir ?? '', 'folder'))
    const controller = await drive(binding, 'directory', 'directory-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('folder') } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_FOUND' })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it.each([
    ['document data', [{ type: 'document', source: { type: 'data', value: 'YQ==', mimeType: 'text/plain' } }], 'UNSUPPORTED_CONTENT_PART'],
    ['binary data', [{ type: 'binary', mimeType: 'application/octet-stream', data: 'YQ==' }], 'UNSUPPORTED_CONTENT_PART'],
    ['image data media type', [{ type: 'image', source: { type: 'data', value: 'YQ==', mimeType: 'image/bmp' } }], 'UNSUPPORTED_MEDIA_TYPE'],
    ['image URL media type', [{ type: 'image', source: { type: 'url', value: fileUrl('image.bmp'), mimeType: 'image/bmp' } }], 'UNSUPPORTED_MEDIA_TYPE'],
  ] satisfies Array<[string, InputContent[], string]>)('rejects unsupported %s', async (_name, content, code) => {
    const { binding } = await mount()
    if (_name === 'image URL media type') await writeFile(join(binding.workspace?.uploadsDir ?? '', 'image.bmp'), 'bmp')
    const controller = await drive(binding, `unsupported-${code}-${_name}`, `unsupported-${_name}`, content)
    expect(controller.record.events.at(-1)).toMatchObject({ code })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('limits non-text parts before resolving any files', async () => {
    const { binding } = await mount(undefined, { maxFilesPerMessage: 1 })
    const controller = await drive(binding, 'file-limit', 'file-limit-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('one') } },
      { type: 'document', source: { type: 'url', value: fileUrl('two') } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'FILE_LIMIT_EXCEEDED' })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('rejects images when the Host has no attachment storage', async () => {
    const { binding } = await mount()
    const controller = await drive(binding, 'no-attachments', 'no-attachments-message', [
      { type: 'image', source: { type: 'data', value: PNG.toString('base64'), mimeType: 'image/png' } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'IMAGES_UNSUPPORTED' })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('maps attachment admission errors without appending DSH input', async () => {
    const attachments = fakeAttachments(new AttachmentError('The image is invalid.', 'INVALID_IMAGE'))
    const { binding } = await mount(attachments)
    const controller = await drive(binding, 'attachment-error', 'attachment-error-message', [
      { type: 'image', source: { type: 'data', value: PNG.toString('base64'), mimeType: 'image/png' } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'INVALID_IMAGE', message: 'The image is invalid.' })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('contains unknown attachment-store failures as execution errors', async () => {
    const attachments = fakeAttachments(new Error('storage offline'))
    const { binding } = await mount(attachments)
    const controller = await drive(binding, 'store-error', 'store-error-message', [
      { type: 'image', source: { type: 'data', value: PNG.toString('base64'), mimeType: 'image/png' } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'AGENT_EXECUTION_ERROR' })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('validates every part before admitting an image batch', async () => {
    const attachments = fakeAttachments()
    const { binding } = await mount(attachments)
    const controller = await drive(binding, 'atomic-parts', 'atomic-parts-message', [
      { type: 'image', source: { type: 'data', value: PNG.toString('base64'), mimeType: 'image/png' } },
      { type: 'document', source: { type: 'url', value: fileUrl('missing.txt') } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_FOUND' })
    expect(attachments.saved).toHaveLength(0)
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('rejects URL parts for a resumed legacy thread without a workspace', async () => {
    const { binding } = await mount()
    ;(binding as unknown as { workspaceValue: undefined }).workspaceValue = undefined
    const controller = await drive(binding, 'legacy', 'legacy-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('report.csv') } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'THREAD_WITHOUT_WORKSPACE' })
    expect(loggedUsers(binding)).toHaveLength(0)
  })

  it('recovers the full content digest and detects a changed attachment', async () => {
    const { binding } = await mount()
    await writeFile(join(binding.workspace?.uploadsDir ?? '', 'first.txt'), 'first')
    await drive(binding, 'first-attachment', 'same-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('first.txt'), mimeType: 'text/plain' } },
    ])
    const bindingInternals = binding as unknown as {
      acceptedMessages: Map<string, unknown>
      recover(events: ReturnType<ThreadBinding['liveAgent']['session']['snapshotEvents']>): void
    }
    const events = binding.liveAgent.session.snapshotEvents()
    const userEvent = events.find(event => event.type === 'user/message')
    if (userEvent?.type !== 'user/message') throw new Error('The durable user message is missing')
    expect((userEvent.data.source as { agUiContentDigest?: string }).agUiContentDigest).toMatch(/^[a-f0-9]+$/)
    bindingInternals.acceptedMessages.clear()
    bindingInternals.recover(events)
    const controller = await drive(binding, 'changed-attachment', 'same-message', [
      { type: 'document', source: { type: 'url', value: fileUrl('second.txt'), mimeType: 'text/plain' } },
    ])
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
    expect(loggedUsers(binding)).toHaveLength(1)
  })
})
