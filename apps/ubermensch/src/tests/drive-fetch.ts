import type { DriveFile } from '@/types';

/**
 * A fake Drive API v3 for the tests: files and shared drives by id, the token it accepts, and a
 * record of every request. Unknown ids answer 404, ids in `forbidden` 403, any other token 401.
 */
export interface FakeDrive {
  files: Map<string, DriveFile>;
  drives: Map<string, string>;
  forbidden: Set<string>;
  rootId: string;
  token: string;
  email: string;
  requests: string[];
  failNetwork: boolean;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFakeDrive(
  files: DriveFile[] = [],
  options: Partial<Pick<FakeDrive, 'rootId' | 'token' | 'email'>> = {},
): FakeDrive {
  const drive: FakeDrive = {
    files: new Map(files.map((file) => [file.id, file])),
    drives: new Map(),
    forbidden: new Set(),
    rootId: options.rootId ?? 'root-id',
    token: options.token ?? 'token-1',
    email: options.email ?? 'person@example.com',
    requests: [],
    failNetwork: false,
    fetch: async (input, init) => {
      drive.requests.push(input);
      if (drive.failNetwork) {
        throw new TypeError('Failed to fetch');
      }
      const headers = new Headers(init?.headers);
      if (headers.get('Authorization') !== `Bearer ${drive.token}`) {
        return json(401, { error: { code: 401 } });
      }
      const url = new URL(input);
      const about = url.pathname === '/drive/v3/about';
      if (about) {
        return json(200, { user: { emailAddress: drive.email } });
      }
      const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (fileMatch?.[1] !== undefined) {
        const id = decodeURIComponent(fileMatch[1]);
        const realId = id === 'root' ? drive.rootId : id;
        if (drive.forbidden.has(realId)) {
          return json(403, { error: { code: 403 } });
        }
        const file = drive.files.get(realId);
        return file === undefined ? json(404, { error: { code: 404 } }) : json(200, file);
      }
      const driveMatch = /^\/drive\/v3\/drives\/([^/]+)$/.exec(url.pathname);
      if (driveMatch?.[1] !== undefined) {
        const name = drive.drives.get(decodeURIComponent(driveMatch[1]));
        return name === undefined ? json(404, { error: { code: 404 } }) : json(200, { name });
      }
      return json(400, {});
    },
  };
  return drive;
}
