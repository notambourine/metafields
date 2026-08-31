import { AdminError, normalizeStore, redactSecrets } from './admin.js';

// The two codes a fleet caller treats differently: `app_not_installed` means the store has
// not enrolled yet, `shop_not_permitted` means the app and the store are in different orgs.
export class GrantError extends AdminError {
  readonly store: string;
  readonly code: string;

  constructor(store: string, code: string, message: string) {
    super(message);
    this.name = 'GrantError';
    this.store = store;
    this.code = code;
  }
}

export interface MintOptions {
  store: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export async function mintAccessToken(options: MintOptions): Promise<string> {
  const store = normalizeStore(options.store);
  if (options.clientId.length === 0 || options.clientSecret.length === 0) {
    throw new GrantError(store, 'invalid_client', 'an app client id and secret are required');
  }
  const send = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await send(`https://${store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: 'client_credentials',
      }).toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GrantError(store, 'unreachable', redactSecrets(message));
  }
  const payload = await grantPayload(response);
  if (response.ok && typeof payload.access_token === 'string' && payload.access_token.length > 0) {
    return payload.access_token;
  }
  const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`;
  const detail = typeof payload.error_description === 'string' ? payload.error_description : undefined;
  throw new GrantError(store, code, detail ?? `token grant returned HTTP ${response.status}`);
}

// Nothing from the body other than an error string is ever surfaced, so a token in an
// unexpected shape cannot reach a message.
async function grantPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json() as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
