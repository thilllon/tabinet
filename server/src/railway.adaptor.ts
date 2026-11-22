/**
 * Production entry point on Railway (the start script; README.md has the settings): the handler the
 * Vercel adaptor exports, on a Node server. It is in src/ and not api/, where Vercel would deploy
 * it, and nothing imports it. It never runs migrations.
 */
import type { Server, ServerResponse } from 'node:http';
import { Server as NetServer, type Socket } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';

import { readPort } from './env.js';
import { createServer } from './production.js';

/** How long requests in flight may take after SIGTERM. Railway's draining time must be longer. */
const SHUTDOWN_MS = 10_000;
/** Longer than a proxy keeps an idle connection (60 s), so it never reuses one closing under it. */
const KEEP_ALIVE_MS = 65_000;

const port = readPort(process.env);
// With no createServer option this is always a node:http server.
const server = createAdaptorServer({ fetch: createServer() }) as Server;
server.keepAliveTimeout = KEEP_ALIVE_MS;

/** Every open connection, with the answers it still has to send in full. */
const connections = new Map<Socket, Set<ServerResponse>>();
let stopping = false;

server.on('connection', (socket: Socket) => {
  connections.set(socket, new Set());
  socket.on('close', () => connections.delete(socket));
});
// Before Hono's listener, so that it runs before any answer is written.
server.prependListener('request', ({ socket }, response) => {
  const unsent = connections.get(socket);
  unsent?.add(response);
  response.shouldKeepAlive &&= !stopping;
  response.on('close', () => {
    unsent?.delete(response);
    if (stopping && unsent?.size === 0) {
      socket.destroySoon();
    }
  });
});

function stop(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  // Not server.close() of node:http: it destroys a connection whose answer is written but not yet
  // sent, which cuts a large pull short. node:net's only stops accepting.
  NetServer.prototype.close.call(server, () => process.exit(0));
  for (const [socket, unsent] of connections) {
    if (unsent.size === 0) {
      socket.destroy();
    }
    for (const response of unsent) {
      // Sends Connection: close, so the proxy does not reuse the connection.
      response.shouldKeepAlive = false;
    }
  }
  setTimeout(() => process.exit(0), SHUTDOWN_MS).unref();
}

process.on('SIGTERM', stop);

// No host: every interface, IPv6 and IPv4.
server.listen(port, () => {
  const address = server.address();
  const listeningOn = typeof address === 'object' ? address?.port : address;
  console.log(`tabinet-server railway: listening on port ${listeningOn}`);
});
