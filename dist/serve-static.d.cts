import { Context, Env, MiddlewareHandler } from "hono";

//#region src/serve-static.d.ts
type ServeStaticOptions<E extends Env = Env> = {
  /**
   * Root path. Relative path is based on current working directory from which the app was started.
   */
  root?: string;
  path?: string;
  index?: string;
  precompressed?: boolean;
  rewriteRequestPath?: (path: string, c: Context<E>) => string;
  onFound?: (path: string, c: Context<E>) => void | Promise<void>;
  onNotFound?: (path: string, c: Context<E>) => void | Promise<void>;
};
type SendFileOptions<E extends Env = Env> = Pick<ServeStaticOptions<E>, 'root' | 'index' | 'precompressed' | 'onFound'> & {
  /**
   * Called when the file is not found. Unlike the `onNotFound` option of `serveStatic`,
   * it can return a `Response`, which is then used as the response.
   * If it returns nothing, the Not Found Response of the Context (`c.notFound()`) is used.
   */
  onNotFound?: (path: string, c: Context<E>) => Response | void | Promise<Response | void>;
};
declare const serveStatic: <E extends Env = any>(options?: ServeStaticOptions<E>) => MiddlewareHandler<E>;
/**
 * Send a file as the response, like `res.sendFile()` of Express.
 *
 * While `serveStatic` serves files based on the request path, `sendFile` serves
 * the file at the given path, so it is useful when you want to determine the
 * file to serve dynamically. It sets the same headers (e.g. `Content-Type`,
 * `Content-Length`, `Last-Modified`) and supports the same features (range
 * requests, HEAD/OPTIONS requests, precompressed files) as `serveStatic`.
 *
 * When the file is not found, `sendFile` returns the Not Found Response of the
 * Context instead of calling the next handler. Customize this with the
 * `onNotFound` option, which may return a `Response` to use instead.
 *
 * @example
 * ```ts
 * app.get('/download/:id', (c) => sendFile(c, lookupFilePathById(c.req.param('id'))))
 * ```
 *
 * @see {@link https://github.com/honojs/node-server/issues/205}
 */
declare const sendFile: <E extends Env = any>(c: Context<E>, path: string, options?: SendFileOptions<E>) => Promise<Response>;
//#endregion
export { SendFileOptions, ServeStaticOptions, sendFile, serveStatic };