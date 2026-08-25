/**
 * Reproduction test for issue #84:
 * https://github.com/honojs/node-server/issues/84
 *
 * "`500` responses when including `body` payload in any request using
 * `@hono/node-server/vercel`"
 *
 * When `@hono/node-server` runs behind a platform layer that reads the
 * IncomingMessage body *before* the adapter gets it — e.g. `@vercel/node`
 * helpers (`vercel dev`, NODEJS_HELPERS enabled by default) or the Next.js
 * Pages API body parser — every request that includes a payload silently
 * fails with a `500` response.
 *
 * The old `@hono/node-server/vercel` adapter (v1.x) was simply
 * `getRequestListener(app.fetch)`, so this test drives that same listener
 * behind a faithful re-implementation of `@vercel/node`'s `addHelpers()`
 * (vercel/vercel `packages/node/src/serverless-functions/helpers.ts`):
 *
 *   - `readBody()` consumes the IncomingMessage stream completely
 *     (making it "disturbed": `readableDidRead === true`), then
 *   - `restoreBody()` rebinds `req.read`/`req.on('data'|'end')` to a
 *     PassThrough that replays the buffered body.
 *
 * The reported behavior (v1.2.0) was `new Request()` throwing
 * "TypeError: Response body object should not be disturbed or locked".
 * On the current implementation the body reads are what fail:
 *
 *   - `c.req.json()` / `.text()` / `.arrayBuffer()` reject with
 *     `TypeError: Body is unusable` (`readBodyDirect()` refuses the request
 *     because `incoming.readableDidRead` is true) => Hono returns `500`.
 *   - `c.req.body` (the wrapped stream) resolves with an *empty* body —
 *     the payload is silently dropped.
 *
 * Expected (bug-free) behavior: the adapter should still deliver the
 * request body that the platform layer consumed and kept available, so the
 * reporter's echo app responds `200` with the original payload.
 */
import { Hono } from 'hono'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { getRequestListener } from '../src/listener'

// ---------------------------------------------------------------------------
// Re-implementation of @vercel/node's addHelpers() body handling, see
// vercel/vercel packages/node/src/serverless-functions/helpers.ts
// ---------------------------------------------------------------------------

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
 * Consumes the request body like `readBody()` in @vercel/node's `addHelpers()`
 * (NODEJS_HELPERS enabled — the default in `vercel dev` and deployments).
 */
const addHelpersLikeVercel = async (req: IncomingMessage): Promise<void> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  restoreBody(req, Buffer.concat(chunks))
}

// ---------------------------------------------------------------------------
// The reporter's app (https://github.com/alexiglesias93/hono-vercel-bug)
// ---------------------------------------------------------------------------

const app = new Hono()
app.get('/hello', (c) => c.body('Hello from Hono!'))
app.post('/echo-json', async (c) => c.json(await c.req.json()))
app.post('/echo-stream', async (c) => {
  // consume the raw body stream, then echo what was received
  const reader = c.req.raw.body!.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    chunks.push(value)
  }
  const received = Buffer.concat(chunks)
  return c.json({ length: received.length, text: received.toString('utf8') })
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
    server.closeAllConnections?.()
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
    // The bug: "Hono silently fails and just returns a 500 response"
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
    // The bug: the wrapped stream resolves empty, silently dropping the payload
    expect(await res.json()).toEqual({ length: payload.length, text: payload })
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
    server.closeAllConnections?.()
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
