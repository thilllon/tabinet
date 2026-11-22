import type { AppHandler, Deps } from '../context.js';
import { error, noContent } from '../responses.js';
import { parseKeySetup } from '../validation.js';

export function putKeys(deps: Deps): AppHandler {
  return async (c) => {
    const keySetup = parseKeySetup(c.get('body'));
    if (keySetup === null) {
      return error(400, 'bad_request');
    }
    // Set once: a second setup would make every record encrypted under the first key unreadable.
    return (await deps.store.setKeySetup(c.get('user').id, keySetup))
      ? noContent(201)
      : error(409, 'key_exists');
  };
}
