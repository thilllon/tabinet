// Both production entry points as their hosts run them: the function Vercel calls, and the process
// Railway starts with the start script.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import * as vercel from '../../api/vercel.adaptor.js';
import { readPort } from '../env.js';
import { FAKE_ENV, FAKE_KEY_ID, FAKE_TOKEN, RECORD_BYTES, RECORD_COUNT } from './fake-network.js';
import { ORIGIN } from './helpers.js';

// The Vercel side runs in this process: the same fake pin the server process gets from its hook.
vi.mock('../key-encryption-key-id.js', async () => ({
  PINNED_KEY_ENCRYPTION_KEY_ID: (await import('./fake-network.js')).FAKE_KEY_ENCRYPTION_KEY_ID,
}));

const ROOT = path.resolve(import.meta.dirname, '../..');
const START: string = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  .start;

const children = new Set<ChildProcess>();

async function canListen(port: number, host?: string): Promise<boolean> {
  const probe = net.createServer();
  const free = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => resolve(true));
  });
  if (free) {
    await new Promise((resolve) => probe.close(resolve));
  }
  return free;
}

/**
 * The server cannot be given PORT=0: on every interface, macOS hands out ports that another
 * program holds on 127.0.0.1, and that program then gets the test's requests. So the port is
 * checked on each address, and is below the range connections and PORT=0 draw from, or one of
 * those could take it before the server does.
 */
async function freePort(): Promise<number> {
  for (;;) {
    const port = randomInt(20_000, 32_000);
    if (
      (await canListen(port, '127.0.0.1')) &&
      (await canListen(port, '::1')) &&
      (await canListen(port))
    ) {
      return port;
    }
  }
}

/** The start script, with the fake network loaded first and only the environment given here. */
async function start(env: Record<string, string> = FAKE_ENV) {
  const [, ...args] = START.split(' ');
  const script = args.pop() as string;
  const child = spawn(
    process.execPath,
    [...args, '--import', './src/tests/fake-network.ts', script],
    { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(await freePort()), ...env } },
  );
  children.add(child);
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const read = (data: Buffer) => {
      output += data;
      const match = /listening on port (\d+)/.exec(output);
      if (match) {
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    void exited.then((code) => reject(new Error(`exited with ${code}: ${output}`)));
  });
  return { child, port, exited, output: () => output };
}

type Running = Awaited<ReturnType<typeof start>>;

function stopAll(): void {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  children.clear();
}

interface Call {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// What the transport adds, which is not part of the contract.
const TRANSPORT = ['connection', 'content-length', 'date', 'keep-alive', 'transfer-encoding'];

function contractHeaders(headers: Iterable<[string, unknown]>): Record<string, string> {
  return Object.fromEntries(
    [...headers]
      .filter(([name]) => !TRANSPORT.includes(name))
      .map(([name, value]): [string, string] => [name, String(value)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function viaVercel({ method, path: target, headers, body }: Call): Promise<Answer> {
  // One handler behind every export, so a method Vercel would answer itself can be asked too.
  const res = await vercel.GET(
    new Request(`https://sync.example.test${target}`, { method, headers, body }),
  );
  return {
    status: res.status,
    headers: contractHeaders(res.headers),
    body: method === 'HEAD' ? '' : await res.text(),
  };
}

async function viaRailway(port: number, call: Call, host = '127.0.0.1'): Promise<Answer> {
  const req = http.request({
    host,
    port,
    method: call.method,
    path: call.path,
    agent: false,
    headers: {
      ...call.headers,
      ...(call.body === undefined
        ? {}
        : { 'Content-Length': String(Buffer.byteLength(call.body)) }),
    },
  });
  req.end(call.body);
  const [res] = (await once(req, 'response')) as [http.IncomingMessage];
  let body = '';
  for await (const chunk of res) {
    body += chunk;
  }
  return {
    status: res.statusCode ?? 0,
    headers: contractHeaders(Object.entries(res.headers)),
    body,
  };
}

/** A connection that has sent `head`, and everything it gets back until it closes. */
async function rawConnection(port: number, head: string) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (data: Buffer) => (received += data));
  socket.on('error', () => {}); // a reset is one way for the server to close
  const closed = new Promise<string>((resolve) => socket.on('close', () => resolve(received)));
  await once(socket, 'connect');
  socket.write(head);
  return { socket, closed, received: () => received };
}

const signedIn = { Authorization: `Bearer ${FAKE_TOKEN}`, Origin: ORIGIN };
const withKey = { ...signedIn, 'Tabinet-Key-Id': FAKE_KEY_ID };
const SIGN_IN = 'POST /v2/auth/google HTTP/1.1\r\nHost: x.test\r\n';
const PUSH = `POST /v2/records HTTP/1.1\r\nHost: x.test\r\nAuthorization: Bearer ${FAKE_TOKEN}\r\nTabinet-Key-Id: ${FAKE_KEY_ID}\r\n`;
const SMALL = POLICY.request.maxSmallBodyBytes;
const LARGE = POLICY.request.maxBodyBytes;

describe('the Railway adaptor and the Vercel adaptor', () => {
  let server: Running;
  beforeAll(async () => {
    for (const [name, value] of Object.entries(FAKE_ENV)) {
      vi.stubEnv(name, value);
    }
    server = await start();
  });
  afterAll(() => {
    stopAll();
    vi.unstubAllEnvs();
  });

  it.each<[string, Call]>([
    ['no token', { method: 'GET', path: '/v2/me' }],
    ['no token, with CORS', { method: 'GET', path: '/v2/me', headers: { Origin: ORIGIN } }],
    ['another origin', { method: 'GET', path: '/v2/me', headers: { Origin: 'https://evil.test' } }],
    ['signed in', { method: 'GET', path: '/v2/me', headers: signedIn }],
    ['no content', { method: 'POST', path: '/v2/auth/logout', headers: signedIn }],
    ['a bad query', { method: 'GET', path: '/v2/records?since=x', headers: withKey }],
    ['no key header', { method: 'GET', path: '/v2/records', headers: signedIn }],
    [
      'another key',
      {
        method: 'GET',
        path: '/v2/records',
        headers: { ...signedIn, 'Tabinet-Key-Id': 'BBBBBBBBBBBBBBBBBBBBBA' },
      },
    ],
    ['a preflight', { method: 'OPTIONS', path: '/v2/records', headers: { Origin: ORIGIN } }],
    ['HEAD', { method: 'HEAD', path: '/v2/me', headers: { Origin: ORIGIN } }],
    ['PATCH', { method: 'PATCH', path: '/v2/records', headers: { Origin: ORIGIN } }],
    ['an unknown path', { method: 'GET', path: '/v2/nowhere' }],
    ['a trailing slash', { method: 'GET', path: '/v2/me/' }],
    ['an encoded path', { method: 'GET', path: '/v2/%6De', headers: signedIn }],
    ['dot segments', { method: 'GET', path: '/v2/x/../me', headers: signedIn }],
    ['v1', { method: 'GET', path: '/v1/me', headers: signedIn }],
    ['v1, HEAD', { method: 'HEAD', path: '/v1/records', headers: signedIn }],
    ['v1, a body', { method: 'POST', path: '/v1/records', headers: signedIn, body: '{}' }],
    ['not JSON', { method: 'POST', path: '/v2/auth/google', body: '{' }],
    ['a refused token', { method: 'POST', path: '/v2/auth/google', body: '{"accessToken":"x"}' }],
    ['a bad key body', { method: 'PUT', path: '/v2/keys', headers: signedIn, body: '{}' }],
    [
      'a refused open',
      { method: 'POST', path: '/v2/keys/open', headers: signedIn, body: '{"accessToken":"x"}' },
    ],
    ['bad records', { method: 'POST', path: '/v2/records', headers: withKey, body: '[]' }],
    ['a pull', { method: 'GET', path: '/v2/records?since=24&path=records', headers: withKey }],
    [
      'the largest small body',
      { method: 'POST', path: '/v2/auth/google', body: '{}'.padEnd(SMALL) },
    ],
    [
      'a small body too large',
      { method: 'POST', path: '/v2/auth/google', body: '{}'.padEnd(SMALL + 1) },
    ],
    [
      'the largest records body',
      { method: 'POST', path: '/v2/records', headers: withKey, body: '{}'.padEnd(LARGE) },
    ],
  ])('answer %s the same', async (_name, call) => {
    // Not the same 500 twice: both pass the production check with the fake pinned key encryption key.
    expect((await viaVercel({ method: 'GET', path: '/v2/me', headers: signedIn })).status).toBe(
      200,
    );
    expect(await viaRailway(server.port, call)).toEqual(await viaVercel(call));
  });

  it('answers a body over the limit the same', async () => {
    // Only the head goes out: the answer must not wait for the body.
    const { socket, closed } = await rawConnection(
      server.port,
      `${SIGN_IN}Content-Length: ${SMALL + 1}\r\n\r\n`,
    );
    const received = await closed;
    expect(received).toMatch(/^HTTP\/1\.1 413 /);
    expect(received).toContain('{"error":"payload_too_large"}');
    socket.destroy();
    const overLimit = await viaVercel({
      method: 'POST',
      path: '/v2/auth/google',
      body: ' '.repeat(SMALL + 1),
    });
    expect(overLimit.status).toBe(413);
    expect(overLimit.body).toBe('{"error":"payload_too_large"}');
  });

  it.each([
    ['a small body', SIGN_IN, SMALL],
    ['a records body', PUSH, LARGE],
  ])('answers 413 to %s over the limit that gives no length', async (_name, head, limit) => {
    const { socket, closed } = await rawConnection(
      server.port,
      `${head}Transfer-Encoding: chunked\r\n\r\n`,
    );
    // One byte past what is read, and no end.
    socket.write(`${(limit + 4).toString(16)}\r\n${' '.repeat(limit + 4)}`);
    expect(await closed).toMatch(/^HTTP\/1\.1 413 /);
  });

  it.each([
    ['a small body', SIGN_IN, SMALL],
    ['a records body', PUSH, LARGE],
  ])(
    'answers 413 to %s in small chunks under a lying Content-Length',
    async (_name, head, limit) => {
      // Content-Length says 2; the body arrives chunked anyway (a proxy that rewrote it), in pieces.
      const { socket, closed } = await rawConnection(
        server.port,
        `${head}Transfer-Encoding: chunked\r\n\r\n`,
      );
      const piece = 4096;
      for (let sent = 0; sent <= limit + piece; sent += piece) {
        socket.write(`${piece.toString(16)}\r\n${' '.repeat(piece)}\r\n`);
      }
      expect(await closed).toMatch(/^HTTP\/1\.1 413 /);
    },
  );

  it('serves the next request on a connection that sent too large a body', async () => {
    const { socket, received } = await rawConnection(
      server.port,
      `${SIGN_IN}Transfer-Encoding: chunked\r\n\r\n`,
    );
    // Whole, and far enough over the limit that a stream's own buffer cannot hold the rest.
    const size = SMALL + 400_000;
    socket.write(`${size.toString(16)}\r\n${' '.repeat(size)}\r\n0\r\n\r\n`);
    await vi.waitFor(() => expect(received()).toContain('{"error":"payload_too_large"}'));
    // A proxy reuses the connection, perhaps for another person's request.
    socket.write('GET /v2/me HTTP/1.1\r\nHost: x.test\r\n\r\n');
    await vi.waitFor(() => expect(received()).toContain('{"error":"unauthorized"}'));
    socket.destroy();
  });

  it('cuts off a body that never ends', async () => {
    const { socket, closed } = await rawConnection(
      server.port,
      `${SIGN_IN}Transfer-Encoding: chunked\r\n\r\n`,
    );
    const chunk = `10000\r\n${' '.repeat(0x10000)}\r\n`;
    const write = () => {
      while (!socket.destroyed && socket.write(chunk)) {
        // until the socket is full
      }
    };
    socket.on('drain', write);
    write();
    // It resolves only because the server closes the connection; the writer never stops by itself.
    const received = await closed;
    // The reset can overtake the answer, so the status is checked only when one arrived.
    if (received !== '') {
      expect(received).toMatch(/^HTTP\/1\.1 413 /);
    }
    expect((await viaRailway(server.port, { method: 'GET', path: '/v2/me' })).status).toBe(401);
  });

  it('survives a client that leaves during its upload', async () => {
    const { socket, closed } = await rawConnection(
      server.port,
      `${SIGN_IN}Content-Length: 100\r\n\r\n{"accessToken":`,
    );
    socket.destroy();
    await closed;
    expect((await viaRailway(server.port, { method: 'GET', path: '/v2/me' })).status).toBe(401);
  });

  it.each(['127.0.0.1', '::1'])('listens on every interface, %s too', async (host) => {
    expect((await viaRailway(server.port, { method: 'GET', path: '/v2/me' }, host)).status).toBe(
      401,
    );
  });

  it('logs no secret', () => {
    expect(server.output()).not.toMatch(/hunter2-password|AAAAAAAAAA|accessToken/);
  });
});

describe('the Railway adaptor', () => {
  afterEach(stopAll);

  it.each([
    ['no environment', { ALLOWED_ORIGINS: ORIGIN }],
    ['no VERCEL_ENV, as on Railway', { ...FAKE_ENV, VERCEL_ENV: '' }],
    ['VERCEL_ENV=preview', { ...FAKE_ENV, VERCEL_ENV: 'preview' }],
  ])('refuses to run with %s: the same 500 as Vercel', async (_name, env) => {
    const { port, output } = await start(env);
    const res = await viaRailway(port, {
      method: 'GET',
      path: '/v2/me',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(500);
    expect(res.body).toBe('{"error":"internal"}');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    await vi.waitFor(() => {
      expect(output()).toContain('tabinet-server: configuration failed Error');
    });
  });

  it('does not start without a usable PORT', async () => {
    expect(() => readPort({})).toThrow('Missing environment variable PORT');
    for (const PORT of ['-1', '80a', '1.5', '65536']) {
      expect(() => readPort({ PORT })).toThrow('Environment variable PORT is not a port');
    }
    expect(readPort({ PORT: '8080' })).toBe(8080);
    await expect(start({ ...FAKE_ENV, PORT: 'x' })).rejects.toThrow('PORT is not a port');
  });

  it('on SIGTERM closes idle connections and exits', async () => {
    const { child, port, exited } = await start();
    const idle = await rawConnection(port, 'GET /v2/me HTTP/1.1\r\nHost: x.test\r\n\r\n');
    await vi.waitFor(() => expect(idle.received()).toContain('{"error":"unauthorized"}'));
    const unused = await rawConnection(port, '');
    child.kill('SIGTERM');
    await Promise.all([idle.closed, unused.closed]);
    expect(await exited).toBe(0);
  });

  it('on SIGTERM takes nothing new and finishes the request it is reading', async () => {
    const { child, port, exited } = await start();
    const upload = await rawConnection(
      port,
      `${SIGN_IN}Expect: 100-continue\r\nContent-Length: 2\r\n\r\n`,
    );
    // The 100 says the request has reached the server.
    await vi.waitFor(() => expect(upload.received()).toContain('100 Continue'));
    child.kill('SIGTERM');
    await vi.waitFor(async () => {
      await expect(viaRailway(port, { method: 'GET', path: '/v2/me' })).rejects.toThrow();
    });
    upload.socket.write('{}');
    const received = await upload.closed;
    expect(received).toContain('HTTP/1.1 400 ');
    expect(received).toContain('{"error":"bad_request"}');
    expect(received).toMatch(/connection: close/i);
    expect(await exited).toBe(0);
  });

  it('on SIGTERM sends the rest of an answer it has already written', async () => {
    const { child, port, exited } = await start();
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v2/records',
      agent: new http.Agent({ keepAlive: true }),
      headers: withKey,
    });
    req.end();
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    res.pause();
    child.kill('SIGTERM');
    // Long enough for the signal to be handled while most of the answer is still unread.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      chunks.push(chunk);
    }
    const lines = Buffer.concat(chunks)
      .toString()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; record?: { ciphertext: string } });
    const records = lines.filter((line) => line.type === 'record');
    expect(records).toHaveLength(RECORD_COUNT);
    expect(records.at(-1)?.record?.ciphertext).toHaveLength(RECORD_BYTES);
    expect(lines.at(-1)).toEqual({ type: 'end', cursor: RECORD_COUNT, complete: true });
    expect(await exited).toBe(0);
  });
});
