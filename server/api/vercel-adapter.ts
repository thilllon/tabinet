// Production entry point: Vercel builds this file into the function /api/vercel-adapter.
// vercel.json rewrites /v1/* to it, and it hands each request, original url intact, to src/app.ts.
import { createServer } from '../src/production.js';

const serve = createServer();

// Vercel itself answers a method that is not exported here, so this list is part of the contract.
export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const DELETE = serve;
export const OPTIONS = serve;
