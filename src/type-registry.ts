
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

// Distinguish invalid API versions from registry request failures.
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
  // Invalid-version responses use HTTP 400 with a structured error body.
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
