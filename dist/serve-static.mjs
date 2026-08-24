import { createStreamBody } from "./utils/stream.mjs";
import { getMimeType } from "hono/utils/mime";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";

//#region src/serve-static.ts
const COMPRESSIBLE_CONTENT_TYPE_REGEX = /^\s*(?:text\/[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|wasm|x-httpd-php|x-javascript|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i;
const ENCODINGS = {
	br: ".br",
	zstd: ".zst",
	gzip: ".gz"
};
const ENCODINGS_ORDERED_KEYS = Object.keys(ENCODINGS);
const getStats = (path) => {
	let stats;
	try {
		stats = statSync(path);
	} catch {}
	return stats;
};
const BYTE_RANGE_PATTERN = /^(?:bytes=)?(?!-$)(\d*)-(\d*)$/;
const parseByteRange = (range) => {
	const match = range.match(BYTE_RANGE_PATTERN);
	if (!match) return;
	const [, start, end] = match;
	if (start === "") return {
		type: "suffix",
		length: Number(end)
	};
	if (end === "") return {
		type: "open-ended",
		start: Number(start)
	};
	return {
		type: "bounded",
		start: Number(start),
		end: Number(end)
	};
};
const resolveByteRange = (spec, size) => {
	if (size === 0) return;
	if (spec.type === "suffix") {
		if (spec.length === 0) return;
		return {
			start: Math.max(size - spec.length, 0),
			end: size - 1
		};
	}
	const end = spec.type === "bounded" ? Math.min(spec.end, size - 1) : size - 1;
	if (spec.start >= size || spec.start > end) return;
	return {
		start: spec.start,
		end
	};
};
const isNotModifiedSince = (ifModifiedSince, mtimeMs) => {
	const sinceMs = Date.parse(ifModifiedSince);
	return !Number.isNaN(sinceMs) && Math.floor(mtimeMs / 1e3) <= Math.floor(sinceMs / 1e3);
};
const tryDecode = (str, decoder) => {
	try {
		return decoder(str);
	} catch {
		return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
			try {
				return decoder(match);
			} catch {
				return match;
			}
		});
	}
};
const tryDecodeURI = (str) => tryDecode(str, decodeURI);
const findFile = (path, index) => {
	const stats = getStats(path);
	if (!stats?.isDirectory()) return {
		path,
		stats
	};
	const indexPath = join(path, index ?? "index.html");
	return {
		path: indexPath,
		stats: getStats(indexPath)
	};
};
const findPrecompressedFile = (path, mimeType, acceptEncodingHeader) => {
	if (!(!mimeType || mimeType === "application/octet-stream" || COMPRESSIBLE_CONTENT_TYPE_REGEX.test(mimeType))) return;
	const acceptedEncodings = new Set(acceptEncodingHeader?.split(",").map((encoding) => encoding.trim()));
	for (const encoding of ENCODINGS_ORDERED_KEYS) {
		if (!acceptedEncodings.has(encoding)) continue;
		const precompressedPath = path + ENCODINGS[encoding];
		const stats = getStats(precompressedPath);
		if (stats) return {
			encoding,
			path: precompressedPath,
			stats
		};
	}
};
const createRangeResponse = (c, path, range, size) => {
	c.header("Accept-Ranges", "bytes");
	const resolvedRange = resolveByteRange(parseByteRange(range) ?? {
		type: "open-ended",
		start: 0
	}, size);
	if (!resolvedRange) {
		c.header("Content-Range", `bytes */${size}`);
		return c.body(null, 416);
	}
	const { start, end } = resolvedRange;
	const chunkSize = end - start + 1;
	c.header("Content-Length", chunkSize.toString());
	c.header("Content-Range", `bytes ${start}-${end}/${size}`);
	return c.body(createStreamBody(createReadStream(path, {
		start,
		end
	})), 206);
};
const createFileResponse = (c, path, size) => {
	if (c.req.method === "HEAD" || c.req.method === "OPTIONS") {
		c.header("Content-Length", size.toString());
		c.status(200);
		return c.body(null);
	}
	const range = c.req.header("range");
	if (!range) {
		c.header("Content-Length", size.toString());
		return c.body(createStreamBody(createReadStream(path)), 200);
	}
	return createRangeResponse(c, path, range, size);
};
const serveFile = async (c, path, stats, options) => {
	const mimeType = getMimeType(path);
	c.header("Content-Type", mimeType || "application/octet-stream");
	if (options.precompressed) {
		const precompressed = findPrecompressedFile(path, mimeType, c.req.header("Accept-Encoding"));
		if (precompressed) {
			c.header("Content-Encoding", precompressed.encoding);
			c.header("Vary", "Accept-Encoding", { append: true });
			path = precompressed.path;
			stats = precompressed.stats;
		}
	}
	c.header("Last-Modified", stats.mtime.toUTCString());
	const ifModifiedSince = c.req.header("if-modified-since");
	if (ifModifiedSince && !c.req.header("if-none-match") && (c.req.method === "GET" || c.req.method === "HEAD") && isNotModifiedSince(ifModifiedSince, stats.mtimeMs)) {
		c.header("Content-Type", void 0);
		c.header("Content-Encoding", void 0);
		await options.onFound?.(path, c);
		return c.body(null, 304);
	}
	const result = createFileResponse(c, path, stats.size);
	await options.onFound?.(path, c);
	return result;
};
const serveStatic = (options = { root: "" }) => {
	const root = options.root || "";
	const optionPath = options.path;
	if (root !== "" && !existsSync(root)) console.error(`serveStatic: root path '${root}' is not found, are you sure it's correct?`);
	return async (c, next) => {
		if (c.finalized) return next();
		let filename;
		if (optionPath) filename = optionPath;
		else try {
			filename = tryDecodeURI(c.req.path);
			if (/(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\/.test(filename)) throw new Error();
		} catch {
			await options.onNotFound?.(c.req.path, c);
			return next();
		}
		const found = findFile(join(root, !optionPath && options.rewriteRequestPath ? options.rewriteRequestPath(filename, c) : filename), options.index);
		if (!found.stats) {
			await options.onNotFound?.(found.path, c);
			return next();
		}
		return serveFile(c, found.path, found.stats, options);
	};
};
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
const sendFile = async (c, path, options = {}) => {
	if (c.finalized) return c.res;
	const found = findFile(join(options.root || "", path), options.index);
	if (!found.stats) return await options.onNotFound?.(found.path, c) ?? await c.notFound();
	return serveFile(c, found.path, found.stats, options);
};

//#endregion
export { sendFile, serveStatic };