import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as adapter from '../../api/vercel-adapter.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Every file and package an entry point pulls in, following relative imports. */
function importsOf(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  function visit(file: string): void {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    // `import type` is erased, so it is not followed.
    const imports = source.matchAll(
      /^(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm,
    );
    for (const [, name] of imports) {
      if (name.startsWith('.')) {
        visit(path.join(path.dirname(file), name).replace(/\.js$/, '.ts'));
      } else {
        packages.add(name);
      }
    }
  }
  visit(entry);
  return { files, packages };
}

describe('the Vercel adapter', () => {
  it('exports exactly the methods Vercel hands over, all one handler', () => {
    expect(Object.keys(adapter).sort()).toEqual(['DELETE', 'GET', 'OPTIONS', 'POST', 'PUT']);
    expect(new Set(Object.values(adapter)).size).toBe(1);
  });

  it('is where vercel.json rewrites /v1/*', () => {
    expect(JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).rewrites).toEqual([
      { source: '/v1/:path*', destination: '/api/vercel-adapter' },
    ]);
  });

  it('never pulls in dev or what only dev uses', () => {
    const { files, packages } = importsOf('api/vercel-adapter.ts');
    expect(files).toContain('src/app.ts');
    expect(files).not.toContain('src/dev.ts');
    expect([...packages].sort()).toEqual(['@neondatabase/serverless', 'hono', 'node:crypto']);
  });
});

describe('what Vercel builds', () => {
  it('pins the preset "Other", so Hono is never detected in its place', () => {
    // Absent is not the same as null: on a project's first deployment Vercel then detects Hono from
    // the dependency and builds src/app.ts instead of api/, which fails.
    expect(JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))).toHaveProperty(
      'framework',
      null,
    );
  });

  it('serves robots.txt as the only static file', () => {
    // Without public/, Vercel serves the whole package, src/dev.ts included.
    expect(readdirSync(path.join(ROOT, 'public'), { recursive: true })).toEqual(['robots.txt']);
  });
});

describe('dev', () => {
  it('cannot reach a real database', () => {
    const { files, packages } = importsOf('src/dev.ts');
    expect(files).not.toContain('src/db/client.ts');
    expect(files).not.toContain('src/production.ts');
    expect(packages).not.toContain('@neondatabase/serverless');
    const source = readFileSync(path.join(ROOT, 'src/dev.ts'), 'utf8');
    expect(source).toContain("new PGlite('memory://')");
    expect(source).toContain("const HOST = '127.0.0.1'");
    expect(source).not.toMatch(/DATABASE_URL|loadEnvFile|dotenv|readEnv/);
  });
});
