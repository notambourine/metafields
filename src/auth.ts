import { AdminError, backoff, delay, normalizeStore, redactSecrets } from './admin.js';

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
  /** Extra tries after a timeout, a dropped connection, HTTP 429, or HTTP 5xx. Defaults to 3. */
  retries?: number;
  fetch?: typeof globalThis.fetch;
}

export async function mintAccessToken(options: MintOptions): Promise<string> {
  const store = normalizeStore(options.store);
  if (options.clientId.length === 0 || options.clientSecret.length === 0) {
    throw new GrantError(store, 'invalid_client', 'an app client id and secret are required');
  }
  const retries = options.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new GrantError(store, 'invalid_options', 'retries must be a whole number, 0 or more');
  }
  const send = options.fetch ?? globalThis.fetch;
  const attempts = retries + 1;
  // Asking again is safe because each request only mints another short-lived token.
  // Without retries, one brief Shopify outage fails every store in a fleet run.
  for (let attempt = 0; ; attempt += 1) {
    const lastAttempt = attempt + 1 >= attempts;
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
      if (!lastAttempt) {
        await delay(backoff(attempt));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GrantError(store, 'unreachable', redactSecrets(message));
    }
    if ((response.status === 429 || response.status >= 500) && !lastAttempt) {
      await response.body?.cancel();
      await delay(backoff(attempt, response.headers.get('retry-after')));
      continue;
    }
    const payload = await grantPayload(response);
    if (response.ok && typeof payload.access_token === 'string' && payload.access_token.length > 0) {
      return payload.access_token;
    }
    const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`;
    const detail = typeof payload.error_description === 'string' ? payload.error_description : undefined;
    throw new GrantError(store, code, detail ?? `token grant returned HTTP ${response.status}`);
  }
}

// Surface only the error string so unexpected response fields cannot leak tokens.
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
