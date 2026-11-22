import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as adaptor from '../../api/vercel.adaptor.js';

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

function readPackage(): { scripts: Record<string, string>; dependencies: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

describe('the Vercel adaptor', () => {
  it('exports exactly the methods Vercel hands over, all one handler', () => {
    expect(Object.keys(adaptor).sort()).toEqual(['DELETE', 'GET', 'OPTIONS', 'POST', 'PUT']);
    expect(new Set(Object.values(adaptor)).size).toBe(1);
  });

  it('is where vercel.json rewrites /v1/*', () => {
    expect(JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).rewrites).toEqual([
      { source: '/v1/:path*', destination: '/api/vercel.adaptor' },
    ]);
  });

  it('never pulls in dev, Railway or a Node server', () => {
    const { files, packages } = importsOf('api/vercel.adaptor.ts');
    expect(files).toContain('src/app.ts');
    expect(files).not.toContain('src/dev.ts');
    expect(files).not.toContain('src/railway.adaptor.ts');
    expect([...packages].sort()).toEqual(['@neondatabase/serverless', 'hono', 'node:crypto']);
  });
});

describe('the Railway adaptor', () => {
  it('runs the same server as Vercel', () => {
    const { files, packages } = importsOf('src/railway.adaptor.ts');
    const vercel = importsOf('api/vercel.adaptor.ts');
    expect([...files].sort()).toEqual(
      [...vercel.files]
        .filter((file) => !file.startsWith('api/'))
        .concat('src/railway.adaptor.ts')
        .sort(),
    );
    expect([...packages].sort()).toEqual(
      [...vercel.packages, '@hono/node-server', 'node:net'].sort(),
    );
  });

  it('never migrates, when it starts or before', () => {
    expect(importsOf('src/railway.adaptor.ts').files).not.toContain('src/db/migrations.ts');
    const { scripts } = readPackage();
    expect(scripts.start).toBe('node --import tsx src/railway.adaptor.ts');
    for (const hook of ['prestart', 'poststart', 'preinstall', 'postinstall', 'prepare']) {
      expect(scripts).not.toHaveProperty(hook);
    }
  });

  it('has the start script as the documented Railway start command', () => {
    // Not the script itself there: pnpm ends a clean SIGTERM with exit code 1.
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(`cd server && exec ${readPackage().scripts.start}`);
  });

  it('needs production dependencies only', () => {
    const { dependencies } = readPackage();
    const { packages } = importsOf('src/railway.adaptor.ts');
    // tsx too: the start script loads it.
    for (const name of [...packages, 'tsx'].filter((name) => !name.startsWith('node:'))) {
      expect(dependencies).toHaveProperty([name]);
    }
  });

  it('is imported by nothing', () => {
    const sources = ['api', 'src', 'scripts'].flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && !file.startsWith('tests'))
        .map((file) => path.join(dir, file)),
    );
    for (const source of sources.filter((file) => file !== 'src/railway.adaptor.ts')) {
      expect(importsOf(source).files).not.toContain('src/railway.adaptor.ts');
    }
  });
});

describe('what Vercel builds', () => {
  it('finds one function in api/', () => {
    expect(readdirSync(path.join(ROOT, 'api'), { recursive: true })).toEqual(['vercel.adaptor.ts']);
  });

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
