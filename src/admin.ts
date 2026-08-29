import type { CanonicalMetafield, CanonicalMetaobject, CompiledSchema } from './schema.js';
import type { ExistingMetafield, ExistingMetaobject, ExistingSchema, Plan } from './planner.js';
import { exitCodeForPlan, planSchema } from './planner.js';

export const DEFAULT_API_VERSION = '2026-07';

export class AdminError extends Error {
  readonly requestId?: string;

  constructor(message: string, requestId?: string) {
    super(message);
    this.name = 'AdminError';
    if (requestId !== undefined) this.requestId = requestId;
  }
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}

export interface AdminClientOptions {
  store: string;
  token: string;
  apiVersion?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
}

export class AdminClient {
  readonly store: string;
  readonly apiVersion: string;
  readonly endpoint: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AdminClientOptions) {
    const store = options.store.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) {
      throw new AdminError('store must be a *.myshopify.com host');
    }
    const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    if (!/^20\d{2}-(01|04|07|10)$/.test(apiVersion)) {
      throw new AdminError('API version must use YYYY-01, YYYY-04, YYYY-07, or YYYY-10');
    }
    if (options.token.length === 0) throw new AdminError('SHOPIFY_ADMIN_ACCESS_TOKEN is required');
    this.store = store;
    this.apiVersion = apiVersion;
    this.endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#retries = options.retries ?? 3;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}, mutation = false): Promise<T> {
    const attempts = mutation ? 1 : this.#retries + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.#fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-access-token': this.#token,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        const requestId = response.headers.get('x-request-id') ?? undefined;
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt + 1 < attempts) {
            await delay(backoff(attempt, response.headers.get('retry-after')));
            continue;
          }
          throw new AdminError(`Shopify Admin API returned HTTP ${response.status}`, requestId);
        }
        const envelope = await response.json() as GraphqlEnvelope<T>;
        if (envelope.errors?.length) {
          const throttled = envelope.errors.some((error) => /throttled/i.test(error.message));
          if (throttled && attempt + 1 < attempts) {
            await delay(backoff(attempt));
            continue;
          }
          throw new AdminError(`Shopify GraphQL error: ${envelope.errors.map((error) => error.message).join('; ')}`, requestId);
        }
        if (envelope.data === undefined) throw new AdminError('Shopify response contained no data', requestId);
        return envelope.data;
      } catch (error) {
        lastError = error;
        if (error instanceof AdminError || attempt + 1 >= attempts) throw redactError(error);
        await delay(backoff(attempt));
      }
    }
    throw redactError(lastError);
  }

  async readSchema(schema: CompiledSchema): Promise<ExistingSchema> {
    const metaobjects: ExistingMetaobject[] = [];
    const metafields: ExistingMetafield[] = [];
    for (const definition of schema.metaobjects) {
      const result = await this.readMetaobject(definition.type);
      if (result) metaobjects.push(result);
    }
    for (const definition of schema.metafields) {
      const result = await this.readMetafield(definition);
      if (result) metafields.push(result);
    }
    return { metaobjects, metafields };
  }

  async readMetaobject(type: string): Promise<ExistingMetaobject | null> {
    const data = await this.request<{ metaobjectDefinitionByType: RawMetaobject | null }>(
      METAOBJECT_QUERY,
      { type },
    );
    return data.metaobjectDefinitionByType ? mapMetaobject(data.metaobjectDefinitionByType) : null;
  }

  async readMetafield(definition: Pick<CanonicalMetafield, 'ownerType' | 'namespace' | 'key'>): Promise<ExistingMetafield | null> {
    const data = await this.request<{ metafieldDefinition: RawMetafield | null }>(METAFIELD_QUERY, {
      ownerType: definition.ownerType,
      namespace: definition.namespace,
      key: definition.key,
    });
    return data.metafieldDefinition ? mapMetafield(data.metafieldDefinition) : null;
  }

  async createMetaobject(definition: CanonicalMetaobject): Promise<void> {
    const data = await this.request<{
      metaobjectDefinitionCreate: { metaobjectDefinition: { id: string } | null; userErrors: UserError[] };
    }>(METAOBJECT_CREATE, { definition: metaobjectCreateInput(definition) }, true);
    assertMutation(data.metaobjectDefinitionCreate, `metaobject:${definition.type}`);
  }

  async createMetafield(definition: CanonicalMetafield): Promise<void> {
    const data = await this.request<{
      metafieldDefinitionCreate: { createdDefinition: { id: string } | null; userErrors: UserError[] };
    }>(METAFIELD_CREATE, { definition: metafieldCreateInput(definition) }, true);
    assertMutation({
      created: data.metafieldDefinitionCreate.createdDefinition,
      userErrors: data.metafieldDefinitionCreate.userErrors,
    }, `metafield:${definition.ownerType}:${definition.namespace}.${definition.key}`);
  }
}

export interface ApplyResult {
  plan: Plan;
  applied: string[];
}

export async function synchronize(
  client: AdminClient,
  schema: CompiledSchema,
  mode: 'dry-run' | 'check' | 'apply',
): Promise<ApplyResult> {
  const before = planSchema(schema, await client.readSchema(schema));
  if (mode !== 'apply' || exitCodeForPlan(before, mode) !== 0) return { plan: before, applied: [] };
  const applied: string[] = [];
  try {
    for (const item of before.items.filter((value) => value.kind === 'metaobject' && value.status === 'CREATE')) {
      await client.createMetaobject(item.desired as CanonicalMetaobject);
      applied.push(item.identity);
    }
    for (const item of before.items.filter((value) => value.kind === 'metafield' && value.status === 'CREATE')) {
      await client.createMetafield(item.desired as CanonicalMetafield);
      applied.push(item.identity);
    }
  } catch (error) {
    const landed = applied.length > 0 ? `; created before failure: ${applied.join(', ')}` : '';
    throw new AdminError(`${error instanceof Error ? error.message : String(error)}${landed}`);
  }
  const after = planSchema(schema, await client.readSchema(schema));
  if (exitCodeForPlan(after, 'check') !== 0) {
    throw new AdminError(`post-apply verification failed; created: ${applied.join(', ') || 'none'}`);
  }
  return { plan: after, applied };
}

interface UserError { field?: string[]; message: string; code?: string }

function assertMutation(
  payload: { metaobjectDefinition?: unknown; created?: unknown; userErrors: UserError[] },
  identity: string,
): void {
  if (payload.userErrors.length > 0) {
    throw new AdminError(`${identity}: ${payload.userErrors.map((error) => error.message).join('; ')}`);
  }
  if (payload.metaobjectDefinition == null && payload.created == null) {
    throw new AdminError(`${identity}: Shopify returned no created definition`);
  }
}

function metafieldCreateInput(definition: CanonicalMetafield): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: definition.name,
    namespace: definition.namespace,
    key: definition.key,
    ownerType: definition.ownerType,
    type: definition.type,
  };
  if (definition.description !== undefined) input.description = definition.description;
  if (definition.validations.length > 0) input.validations = definition.validations;
  if (definition.access) input.access = definition.access;
  if (definition.capabilities) input.capabilities = capabilityInput(definition.capabilities);
  if (definition.constraints) input.constraints = definition.constraints;
  return input;
}

function metaobjectCreateInput(definition: CanonicalMetaobject): Record<string, unknown> {
  const input: Record<string, unknown> = {
    type: definition.type,
    name: definition.name,
    fieldDefinitions: definition.fields.map((field) => {
      const result: Record<string, unknown> = { key: field.key, name: field.name, type: field.type };
      if (field.description !== undefined) result.description = field.description;
      if (field.required !== undefined) result.required = field.required;
      if (field.validations.length > 0) result.validations = field.validations;
      return result;
    }),
  };
  if (definition.description !== undefined) input.description = definition.description;
  if (definition.displayNameKey !== undefined) input.displayNameKey = definition.displayNameKey;
  if (definition.access) input.access = definition.access;
  if (definition.capabilities) input.capabilities = capabilityInput(definition.capabilities);
  return input;
}

function capabilityInput(capabilities: Record<string, boolean>): Record<string, { enabled: boolean }> {
  return Object.fromEntries(Object.entries(capabilities).map(([key, enabled]) => [key, { enabled }]));
}

interface RawField {
  key: string;
  name: string;
  description?: string | null;
  type: { name: string };
  required?: boolean;
  validations: { name: string; value: string }[];
}
interface RawMetaobject {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  displayNameKey?: string | null;
  access: Record<string, string | null>;
  capabilities: { publishable: { enabled: boolean }; translatable: { enabled: boolean } };
  fieldDefinitions: RawField[];
}
interface RawMetafield extends RawField {
  id: string;
  namespace: string;
  ownerType: string;
  access: Record<string, string | null>;
  capabilities: Record<string, { enabled: boolean }>;
  constraints?: { key: string | null; values: { nodes: { value: string }[] } } | null;
  validationStatus: ExistingMetafield['validationStatus'];
  invalidCount: number;
}

function mapField(field: RawField) {
  return {
    key: field.key,
    name: field.name,
    description: field.description,
    type: field.type,
    required: field.required,
    validations: field.validations,
  };
}

function mapMetaobject(value: RawMetaobject): ExistingMetaobject {
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    description: value.description,
    displayNameKey: value.displayNameKey,
    access: value.access,
    capabilities: {
      publishable: value.capabilities.publishable.enabled,
      translatable: value.capabilities.translatable.enabled,
    },
    fields: value.fieldDefinitions.map(mapField),
  };
}

function mapMetafield(value: RawMetafield): ExistingMetafield {
  return {
    ...mapField(value),
    id: value.id,
    namespace: value.namespace,
    ownerType: value.ownerType,
    access: value.access,
    capabilities: Object.fromEntries(Object.entries(value.capabilities).map(([key, item]) => [key, item.enabled])),
    constraints: value.constraints
      ? { key: value.constraints.key, values: value.constraints.values.nodes.map((item) => item.value) }
      : null,
    validationStatus: value.validationStatus,
    invalidCount: value.invalidCount,
  };
}

function redactError(error: unknown): Error {
  if (error instanceof AdminError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AdminError(message.replace(/shpat_[A-Za-z0-9_-]+/g, '[REDACTED]'));
}

function backoff(attempt: number, retryAfter?: string | null): number {
  const seconds = retryAfter === undefined || retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10_000);
  return Math.min(250 * 2 ** attempt, 4_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const FIELD_SELECTION = `
  key name description type { name } required validations { name value }
`;

const METAOBJECT_QUERY = `
query MetaobjectDefinition($type: String!) {
  metaobjectDefinitionByType(type: $type) {
    id type name description displayNameKey
    access { admin storefront }
    capabilities { publishable { enabled } translatable { enabled } }
    fieldDefinitions { ${FIELD_SELECTION} }
  }
}`;

const METAFIELD_QUERY = `
query MetafieldDefinition($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
  metafieldDefinition(ownerType: $ownerType, namespace: $namespace, key: $key) {
    id namespace key ownerType name description type { name }
    validations { name value }
    access { admin storefront customerAccount }
    capabilities {
      adminFilterable { enabled }
      analyticsQueryable { enabled }
      cartToOrderCopyable { enabled }
      smartCollectionCondition { enabled }
      uniqueValues { enabled }
    }
    constraints { key values(first: 250) { nodes { value } } }
    validationStatus
    invalidCount: metafieldsCount(validationStatus: INVALID)
  }
}`;

const METAOBJECT_CREATE = `
mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
  metaobjectDefinitionCreate(definition: $definition) {
    metaobjectDefinition { id }
    userErrors { field message code }
  }
}`;

const METAFIELD_CREATE = `
mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message code }
  }
}`;
