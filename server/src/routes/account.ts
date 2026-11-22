import type { AppHandler, Deps } from '../context.js';
import { json, noContent } from '../responses.js';

export const me: AppHandler = (c) => {
  const { email, keySetup } = c.get('user');
  return json(200, { email, keySetup });
};

export function deleteAccount(deps: Deps): AppHandler {
  return async (c) => {
    await deps.store.deleteUser(c.get('user').id);
    return noContent();
  };
}
