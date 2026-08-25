/**
 * Reproduction test for issue #84:
 * https://github.com/honojs/node-server/issues/84 — 500 responses for every
 * request with a body when a platform layer consumes the IncomingMessage
 * before the adapter runs, e.g. `@vercel/node` helpers (NODEJS_HELPERS=1, the
 * default in `vercel dev`) or the Next.js Pages API body parser.
 *
 * The tests drive `getRequestListener` behind a re-implementation of the
 * relevant part of `@vercel/node`'s `addHelpers()`
 * (vercel/vercel packages/node/src/serverless-functions/helpers.ts):
 * `readBody()` consumes the stream completely, then `restoreBody()` rebinds
 * `req.read`/`req.on('data'|'end')` to a PassThrough that replays the body.
 */
import { Hono } from 'hono'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { getRequestListener } from '../src/listener'

/**
 * Rebinds `read()` and `data`/`end` event handlers of `req` to a PassThrough
 * that replays `body`, exactly like `restoreBody()` in @vercel/node.
 */
const restoreBody = (req: IncomingMessage, body: Buffer): void => {
  const replicateBody = new PassThrough()
  const on = replicateBody.on.bind(replicateBody)
  const originalOn = req.on.bind(req)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(req as any).read = replicateBody.read.bind(replicateBody)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(req as any).on = (req as any).addListener = (name: string, cb: unknown) =>
    name === 'data' || name === 'end' ? on(name, cb as never) : originalOn(name, cb as never)
  replicateBody.write(body)
  replicateBody.end()
}

/**
 * Consumes the request body like `readBody()` in @vercel/node's `addHelpers()`.
 */
const addHelpersLikeVercel = async (req: IncomingMessage): Promise<void> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  restoreBody(req, Buffer.concat(chunks))
}

// The reporter's app (https://github.com/alexiglesias93/hono-vercel-bug)
const app = new Hono()
app.get('/hello', (c) => c.body('Hello from Hono!'))
app.post('/echo-json', async (c) => c.json(await c.req.json()))
app.post('/echo-stream', async (c) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of c.req.raw.body!) {
    chunks.push(chunk)
  }
  const received = Buffer.concat(chunks)
  return c.json({ length: received.length, text: received.toString('utf8') })
})
// Handlers that never touch the body must still complete promptly.
app.post('/ignore-body', (c) => c.body('ok'))
// Standard double-read semantics must be preserved after the replay recovery.
app.post('/double-read', async (c) => {
  await c.req.raw.body?.cancel()
  try {
    await c.req.text()
    return c.text('no-error')
  } catch {
    return c.text('rejected')
  }
})

const payload = JSON.stringify({ hello: 'world', from: 'issue-84' })

const startServer = async (withVercelHelpers: boolean): Promise<Server> => {
  const listener = getRequestListener(app.fetch)
  const server = createServer((req, res) => {
    if (!withVercelHelpers) {
      listener(req, res)
      return
    }
    addHelpersLikeVercel(req)
      .then(() => listener(req, res))
      .catch((e) => {
        // the helper itself failed — surface it instead of hanging
        res.statusCode = 500
        res.end(`vercel-like helper failed: ${e}`)
      })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

describe('issue #84 — requests with a body payload behind a platform that pre-consumes the IncomingMessage', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = await startServer(true)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('GET requests should work (issue reports only requests with a payload fail)', async () => {
    const res = await fetch(`${baseUrl}/hello`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Hello from Hono!')
  })

  it('POST with a JSON payload should be echoed, not silently fail with 500', async () => {
    const res = await fetch(`${baseUrl}/echo-json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: 'world', from: 'issue-84' })
  })

  it('POST body stream should deliver the payload instead of an empty body', async () => {
    const res = await fetch(`${baseUrl}/echo-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ length: payload.length, text: payload })
  })

  it('POST whose handler never reads the body should respond promptly (no hang)', async () => {
    const res = await fetch(`${baseUrl}/ignore-body`, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('double body read should still be rejected with standard semantics', async () => {
    const res = await fetch(`${baseUrl}/double-read`, {
      method: 'POST',
      body: payload,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('rejected')
  })
})

describe('control — same app without platform body consumption (NODEJS_HELPERS=0 workaround)', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = await startServer(false)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('POST with a JSON payload is echoed', async () => {
    const res = await fetch(`${baseUrl}/echo-json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: 'world', from: 'issue-84' })
  })
})
