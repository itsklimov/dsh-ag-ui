import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent } from '@ag-ui/client'

const exampleRoot = fileURLToPath(new URL('../examples/test/', import.meta.url))
const cordisBin = fileURLToPath(new URL('../node_modules/@deepseek-ai/cordis/bin.js', import.meta.url))
const children: ChildProcessWithoutNullStreams[] = []

const headers = {
  authorization: 'Bearer test-only-ag-ui-shared-secret',
  'x-dsh-tenant-id': 'test-tenant',
  'x-dsh-user-id': 'test-user',
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

describe('standalone Cordis composition', () => {
  it('loads the built plugin and streams one Agent response', async () => {
    const port = await reservePort()
    const child = spawn(process.execPath, [cordisBin], {
      cwd: exampleRoot,
      env: { ...process.env, AG_UI_TEST_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdin.end()
    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr.push(chunk) })

    const url = `http://127.0.0.1:${String(port)}/ag-ui`
    await waitForServer(url, child, stderr)

    const agent = new HttpAgent({ url, threadId: 'loader-thread', headers })
    agent.addMessage({ id: 'loader-user', role: 'user', content: 'Verify the standalone bundle.' })
    await agent.runAgent({ runId: 'loader-run', tools: [], context: [], forwardedProps: {} })

    expect(agent.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: 'The standalone AG-UI bundle is running.',
    }))
  })
})

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Port reservation returned no TCP address.')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return address.port
}

async function waitForServer(url: string, child: ChildProcessWithoutNullStreams, stderr: string[]): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Cordis example exited ${String(child.exitCode)}: ${stderr.join('')}`)
    try {
      const response = await fetch(url)
      if (response.status === 405) return
    } catch {
      // Connection refusal means the real WebServer has not bound yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Cordis example did not become ready: ${stderr.join('')}`)
}
