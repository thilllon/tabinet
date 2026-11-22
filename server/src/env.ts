// Environment parsing. An error names the variable and never quotes its value.

/** A comma-separated environment variable as a list, blanks dropped. */
export function listFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

// neon() puts the whole connection string, password included, into the message of the error it
// throws for one it cannot parse. Check it here first and name only the variable.
function requireUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);
  if (!URL.canParse(value)) {
    throw new Error(`Environment variable ${name} is not a valid URL`);
  }
  return value;
}

/** What production needs from the environment. Throws when a required variable is unusable. */
export function readEnv(env: NodeJS.ProcessEnv): {
  databaseUrl: string;
  googleClientIds: string[];
  allowedOrigins: string[];
} {
  return {
    databaseUrl: requireUrl(env, 'DATABASE_URL'),
    googleClientIds: listFromEnv(requireEnv(env, 'GOOGLE_CLIENT_IDS')),
    allowedOrigins: listFromEnv(env.ALLOWED_ORIGINS),
  };
}

/** The port Railway gives the server in PORT. Vercel has none, so `readEnv()` does not ask for it. */
export function readPort(env: NodeJS.ProcessEnv): number {
  const value = requireEnv(env, 'PORT');
  if (!/^\d+$/.test(value) || Number(value) > 65_535) {
    throw new Error('Environment variable PORT is not a port');
  }
  return Number(value);
}
