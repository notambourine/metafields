// Shopify's own metafield type list, read without a store, a token, or an app: shopify.dev
// proxies the Admin API, the same endpoint @shopify/api-codegen-preset points codegen at.
// src/metafield-types.ts is generated from this; `metafields check-types` compares the two.
//
// The proxy serves only the versions Shopify currently supports and answers
// {"error":"Invalid API version"} for the rest, so reaching it is also the check that the
// version being asked about has not aged out.

export interface RegistryType {
  readonly name: string;
  readonly category: string;
  readonly supportsDefinitionMigrations: boolean;
  readonly supportedValidations: readonly { readonly name: string; readonly type: string }[];
}

export interface Registry {
  readonly version: string;
  readonly types: readonly RegistryType[];
  readonly owners: readonly string[];
}

const PROXY = 'https://shopify.dev/admin-graphql-direct-proxy';

const TYPES_QUERY =
  '{ metafieldDefinitionTypes { name category supportsDefinitionMigrations supportedValidations { name type } } }';
const OWNERS_QUERY = '{ __type(name: "MetafieldOwnerType") { enumValues { name } } }';

// A version the proxy refuses is a finding about the caller's pin; anything else is the check
// failing to run. Only the first is something a person can act on, so they are not one error.
export type RegistryFailure = 'unsupported-version' | 'unavailable';

export class RegistryError extends Error {
  readonly kind: RegistryFailure;

  constructor(kind: RegistryFailure, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.kind = kind;
  }
}

async function query<T>(version: string, document: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${PROXY}/${version}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: document }),
    });
  } catch (error) {
    throw new RegistryError('unavailable', `cannot reach shopify.dev: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => undefined) as
    { data?: T; error?: string; errors?: unknown } | undefined;
  // Read before the status: the refusal arrives as a 400 carrying {"error":"Invalid API version"}.
  if (body?.error) throw new RegistryError('unsupported-version', body.error);
  if (!response.ok) throw new RegistryError('unavailable', `proxy answered HTTP ${response.status}`);
  if (!body?.data) {
    throw new RegistryError('unavailable', `proxy returned no data: ${JSON.stringify(body?.errors)}`);
  }
  return body.data;
}

export async function fetchRegistry(version: string): Promise<Registry> {
  const { metafieldDefinitionTypes } = await query<{ metafieldDefinitionTypes: RegistryType[] }>(
    version,
    TYPES_QUERY,
  );
  const { __type: ownerEnum } = await query<{ __type: { enumValues: { name: string }[] } | null }>(
    version,
    OWNERS_QUERY,
  );
  if (!ownerEnum) throw new RegistryError('unavailable', 'MetafieldOwnerType is missing from the schema');
  return {
    version,
    types: metafieldDefinitionTypes,
    owners: ownerEnum.enumValues.map((value) => value.name),
  };
}
