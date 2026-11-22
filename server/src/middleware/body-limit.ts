import type { AppMiddleware } from '../context.js';
import { error } from '../responses.js';
import { MAX_BODY_BYTES } from '../validation.js';

// The limit is on the bytes of the decoded text. Decoding drops a byte order mark (3 bytes) and
// never shrinks anything else, so past this many bytes on the wire a body is over it, whatever it is.
const MAX_READ_BYTES = MAX_BODY_BYTES + 3;

/**
 * The body, or null as soon as it is longer than `MAX_READ_BYTES`. It goes into one buffer, since
 * a list of the chunks costs far more than their bytes when a client sends one byte at a time.
 * The rest is not cancelled: on Node that destroys the socket before the 413 can be written.
 */
async function readAtMost(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  let bytes = new Uint8Array(0);
  if (body === null) {
    return bytes;
  }
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return bytes.subarray(0, size);
      }
      const end = size + value.byteLength;
      if (end > MAX_READ_BYTES) {
        return null;
      }
      if (end > bytes.length) {
        const grown = new Uint8Array(Math.min(MAX_READ_BYTES, Math.max(end, bytes.length * 2)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = end;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reads the body as JSON into `c.get('body')` (undefined when it is not JSON, which the handler's
 * parser answers with 400), or answers 413 over `MAX_BODY_BYTES`, never holding more than that:
 * not every host caps a body before it gets here. Not Hono's bodyLimit: that one trusts
 * Content-Length when it is there, and the real byte count has to be checked too.
 */
export const readJsonBody: AppMiddleware = async (c, next) => {
  const request = c.req.raw;
  // Content-Length first, so an honest oversized request is refused without reading it.
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large');
  }
  const bytes = await readAtMost(request.body);
  if (bytes === null) {
    return error(413, 'payload_too_large');
  }
  const text = new TextDecoder().decode(bytes);
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  c.set('body', body);
  await next();
};
