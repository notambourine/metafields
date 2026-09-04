import {
  mapMetafield, mapMetaobject, METAFIELD_SELECTION, METAOBJECT_SELECTION,
  type RawMetafield, type RawMetaobject,
} from './admin-shapes.js';
import { assertDescriptionLengths } from './limits.js';
import type { CanonicalField, CanonicalMetafield, CanonicalMetaobject, CompiledSchema } from './schema.js';
import type {
  ExistingField, ExistingMetafield, ExistingMetaobject, ExistingSchema, Plan, SyncMode,
} from './planner.js';
import { exitCodeForPlan, planFrom, planSchema } from './planner.js';
import {
  changedPaths, classifyDrift, deferred, written, type DriftItem, type DriftPlan,
} from './changes.js';
import { toPortableField, toStoreField, toStoreMetaobject } from './references.js';

export const DEFAULT_API_VERSION = '2026-07';

export class AdminError extends Error {
  readonly requestId?: string;

  constructor(message: string, requestId?: string) {
    super(redactSecrets(message));
    this.name = 'AdminError';
    if (requestId !== undefined) this.requestId = requestId;
  }
}

export function normalizeStore(store: string): string {
  const value = store.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) {
    throw new AdminError('store must be a *.myshopify.com host');
  }
  return value;
}

// Every Shopify credential prefix, not just the legacy shpat_ one, because a minted
// client-credentials token is the value most likely to reach a fleet CI log.
export function redactSecrets(message: string): string {
  return message.replace(/shp(at|ca|pa|ss|us)_[A-Za-z0-9_-]+/g, '[REDACTED]');
}

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}

// A rate limit arrives as HTTP 200 carrying this code, so it never reaches the status checks.
// MAX_COST_EXCEEDED is deliberately not throttling: that query costs too much every time.
function isThrottled(errors: readonly GraphqlError[]): boolean {
  return errors.some((error) => error.extensions?.code === 'THROTTLED' || /^throttled$/i.test(error.message.trim()));
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
  // Every metaobject definition this client has read or created, both ways round: writes need the
  // id a schema names by type, reads need the type behind the id Shopify returns.
  readonly #idByType = new Map<string, string>();
  readonly #typeById = new Map<string, string>();

  constructor(options: AdminClientOptions) {
    const store = normalizeStore(options.store);
    const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    if (!/^20\d{2}-(01|04|07|10)$/.test(apiVersion)) {
      throw new AdminError('API version must use YYYY-01, YYYY-04, YYYY-07, or YYYY-10');
    }
    if (options.token.length === 0) throw new AdminError('an Admin access token is required');
    this.store = store;
    this.apiVersion = apiVersion;
    this.endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#retries = options.retries ?? 3;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}, mutation = false): Promise<T> {
    // A timeout or 5xx may have landed, but Shopify rejects THROTTLED before execution.
    // Retry only the latter to avoid duplicate creates.
    const attempts = this.#retries + 1;
    const retriesTransient = !mutation;
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
          const retryable = retriesTransient && (response.status === 429 || response.status >= 500);
          if (retryable && attempt + 1 < attempts) {
            await delay(backoff(attempt, response.headers.get('retry-after')));
            continue;
          }
          throw new AdminError(`Shopify Admin API returned HTTP ${response.status}`, requestId);
        }
        const envelope = await response.json() as GraphqlEnvelope<T>;
        if (envelope.errors?.length) {
          if (isThrottled(envelope.errors) && attempt + 1 < attempts) {
            await delay(backoff(attempt));
            continue;
          }
          throw new AdminError(`Shopify GraphQL error: ${envelope.errors.map((error) => error.message).join('; ')}`, requestId);
        }
        if (envelope.data === undefined) throw new AdminError('Shopify response contained no data', requestId);
        return envelope.data;
      } catch (error) {
        lastError = error;
        if (error instanceof AdminError || !retriesTransient || attempt + 1 >= attempts) throw redactError(error);
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
    if (!data.metaobjectDefinitionByType) return null;
    const definition = mapMetaobject(data.metaobjectDefinitionByType);
    this.#remember(definition.type, definition.id);
    return { ...definition, fields: definition.fields.map((field) => this.#portable(field)) };
  }

  async readMetafield(definition: Pick<CanonicalMetafield, 'ownerType' | 'namespace' | 'key'>): Promise<ExistingMetafield | null> {
    const data = await this.request<{ metafieldDefinition: RawMetafield | null }>(METAFIELD_QUERY, {
      identifier: {
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
      },
    });
    return data.metafieldDefinition ? this.#portable(mapMetafield(data.metafieldDefinition)) : null;
  }

  #remember(type: string, id: string | undefined): void {
    if (id === undefined) return;
    this.#idByType.set(type, id);
    this.#typeById.set(id, type);
  }

  // A stored reference names an id, a schema names a type. Comparing and regenerating both happen
  // against the schema's vocabulary, so a read answers in it.
  #portable<T extends ExistingField>(field: T): T {
    return toPortableField(field, this.#typeById);
  }

  // References are resolved before the input builders run, so those stay a plain projection.
  // Every referenced metaobject was read or created by now: creates precede updates.
  #resolved(entry: DriftItem): DriftItem {
    const desired = entry.item.kind === 'metaobject'
      ? toStoreMetaobject(entry.item.desired as CanonicalMetaobject, this.#idByType)
      : toStoreField(entry.item.desired as CanonicalMetafield, this.#idByType);
    return { ...entry, item: { ...entry.item, desired } };
  }

  async createMetaobject(definition: CanonicalMetaobject): Promise<void> {
    const data = await this.request<{
      metaobjectDefinitionCreate: {
        metaobjectDefinition: { id: string; type: string } | null;
        userErrors: UserError[];
      };
    }>(METAOBJECT_CREATE, { definition: metaobjectCreateInput(toStoreMetaobject(definition, this.#idByType)) }, true);
    const payload = data.metaobjectDefinitionCreate;
    assertMutation(payload.metaobjectDefinition, payload.userErrors, `metaobject:${definition.type}`);
    // Metafields referencing this metaobject are created later in the same run, by type.
    this.#remember(definition.type, payload.metaobjectDefinition?.id);
  }

  async createMetafield(definition: CanonicalMetafield): Promise<void> {
    const data = await this.request<{
      metafieldDefinitionCreate: { createdDefinition: { id: string } | null; userErrors: UserError[] };
    }>(METAFIELD_CREATE, { definition: metafieldCreateInput(toStoreField(definition, this.#idByType)) }, true);
    const payload = data.metafieldDefinitionCreate;
    assertMutation(payload.createdDefinition, payload.userErrors,
      `metafield:${definition.ownerType}:${definition.namespace}.${definition.key}`);
  }

  async updateMetaobject(entry: DriftItem, force = false): Promise<void> {
    const data = await this.request<{
      metaobjectDefinitionUpdate: { metaobjectDefinition: { id: string } | null; userErrors: UserError[] };
    }>(METAOBJECT_UPDATE, {
      id: entry.item.existing?.id,
      definition: metaobjectUpdateInput(this.#resolved(entry), force),
    }, true);
    const payload = data.metaobjectDefinitionUpdate;
    assertMutation(payload.metaobjectDefinition, payload.userErrors, entry.item.identity);
  }

  async updateMetafield(entry: DriftItem, force = false): Promise<void> {
    const data = await this.request<{
      metafieldDefinitionUpdate: { updatedDefinition: { id: string } | null; userErrors: UserError[] };
    }>(METAFIELD_UPDATE, { definition: metafieldUpdateInput(this.#resolved(entry), force) }, true);
    const payload = data.metafieldDefinitionUpdate;
    assertMutation(payload.updatedDefinition, payload.userErrors, entry.item.identity);
  }
}

export interface ApplyResult {
  plan: Plan;
  created: string[];
  updated: string[];
  // Definitions this run deliberately left alone, whole: they need `--force`, or nothing reaches
  // them. Skipping some does not stop the rest, which is what keeps a fleet uniform.
  skipped: string[];
}

export async function planStore(client: AdminClient, schema: CompiledSchema): Promise<Plan> {
  return planSchema(schema, await client.readSchema(schema));
}

export async function applyPlan(
  client: AdminClient,
  schema: CompiledSchema,
  plan: Plan,
  drift: DriftPlan,
  force = false,
): Promise<ApplyResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const skipped = deferred(drift, force).map((entry) => entry.item.identity);
  try {
    // Metaobject creates run first so an update can reference a metaobject born this run; updates
    // still precede metafield creates so a new metafield lands against already-corrected shape.
    for (const item of plan.items.filter((value) => value.kind === 'metaobject' && value.status === 'CREATE')) {
      await client.createMetaobject(item.desired as CanonicalMetaobject);
      created.push(item.identity);
    }
    for (const entry of written(drift, force)) {
      if (entry.item.kind === 'metaobject') await client.updateMetaobject(entry, force);
      else await client.updateMetafield(entry, force);
      updated.push(entry.item.identity);
    }
    for (const item of plan.items.filter((value) => value.kind === 'metafield' && value.status === 'CREATE')) {
      await client.createMetafield(item.desired as CanonicalMetafield);
      created.push(item.identity);
    }
  } catch (error) {
    const landed = [
      ...updated.map((identity) => `updated ${identity}`),
      ...created.map((identity) => `created ${identity}`),
    ];
    const trail = landed.length > 0 ? `; before failure: ${landed.join(', ')}` : '';
    throw new AdminError(`${error instanceof Error ? error.message : String(error)}${trail}`);
  }
  const after = planSchema(schema, await client.readSchema(schema));
  // Only the writes this run made have to have landed. Drift it chose to skip is expected to
  // still be there, and reporting it as a failed verification would hide a real one.
  const attempted = planFrom(after.items.filter((item) => !skipped.includes(item.identity)));
  if (exitCodeForPlan(attempted) !== 0) {
    throw new AdminError(`post-apply verification failed; created: ${created.join(', ') || 'none'}`);
  }
  return { plan: after, created, updated, skipped };
}

export async function synchronize(
  client: AdminClient,
  schema: CompiledSchema,
  mode: SyncMode,
  force = false,
): Promise<ApplyResult> {
  assertDescriptionLengths(schema);
  const before = await planStore(client, schema);
  const drift = classifyDrift(before);
  if (mode !== 'apply') {
    return { plan: before, created: [], updated: [], skipped: deferred(drift, force).map((entry) => entry.item.identity) };
  }
  return applyPlan(client, schema, before, drift, force);
}

interface UserError { field?: string[]; message: string; code?: string }

// Each mutation names its payload field differently, so the caller passes the definition it
// found rather than a shape this has to know about.
function assertMutation(definition: unknown, userErrors: UserError[], identity: string): void {
  if (userErrors.length > 0) {
    throw new AdminError(`${identity}: ${userErrors.map((error) => error.message).join('; ')}`);
  }
  if (definition == null) {
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

// An update only ever sends the attributes the plan reported as drifted, so it never carries an
// opinion about something the operator did not declare.
function metafieldUpdateInput(entry: DriftItem, force: boolean): Record<string, unknown> {
  const definition = entry.item.desired as CanonicalMetafield;
  const paths = changedPaths(entry, force);
  const input: Record<string, unknown> = {
    ownerType: definition.ownerType,
    namespace: definition.namespace,
    key: definition.key,
  };
  addLabels(input, paths, definition);
  if (paths.includes('validations differ')) input.validations = definition.validations;
  if (paths.some((path) => path.startsWith('access.')) && definition.access) input.access = definition.access;
  if (paths.some((path) => path.startsWith('capabilities.')) && definition.capabilities) {
    input.capabilities = capabilityInput(definition.capabilities);
  }
  if (paths.includes('constraints differ')) {
    input.constraintsUpdates = constraintsUpdateInput(definition, entry.item.existing as ExistingMetafield);
  }
  return input;
}

// Constraint values are created and deleted one by one, so the stored set has to be diffed
// against the declared one rather than replaced.
function constraintsUpdateInput(
  definition: CanonicalMetafield,
  existing: ExistingField | undefined,
): Record<string, unknown> {
  const stored = new Set(existing?.constraints?.values ?? []);
  const declared = new Set(definition.constraints?.values ?? []);
  const values = [
    ...[...declared].filter((value) => !stored.has(value)).sort().map((value) => ({ create: value })),
    ...[...stored].filter((value) => !declared.has(value)).sort().map((value) => ({ delete: value })),
  ];
  return definition.constraints ? { key: definition.constraints.key, values } : { key: null, values };
}

function metaobjectUpdateInput(entry: DriftItem, force: boolean): Record<string, unknown> {
  const definition = entry.item.desired as CanonicalMetaobject;
  const paths = changedPaths(entry, force);
  const input: Record<string, unknown> = {};
  addLabels(input, paths, definition);
  if (paths.some((path) => path.startsWith('displayNameKey')) && definition.displayNameKey !== undefined) {
    input.displayNameKey = definition.displayNameKey;
  }
  if (paths.some((path) => path.startsWith('access.')) && definition.access) input.access = definition.access;
  if (paths.some((path) => path.startsWith('capabilities.')) && definition.capabilities) {
    input.capabilities = capabilityInput(definition.capabilities);
  }
  const missing = new Set<string>();
  const drifted = new Map<string, string[]>();
  for (const path of paths) {
    const added = /^fields\.([^.]+): missing$/.exec(path);
    if (added?.[1] !== undefined) missing.add(added[1]);
    else {
      const changed = /^fields\.([^.]+)\.(.+)$/.exec(path);
      if (changed?.[1] !== undefined && changed[2] !== undefined) {
        drifted.set(changed[1], [...drifted.get(changed[1]) ?? [], changed[2]]);
      }
    }
  }
  const declared = new Map(definition.fields.map((field) => [field.key, field]));
  const operations: Record<string, unknown>[] = [];
  for (const key of [...missing].sort()) {
    const field = declared.get(key);
    if (field) operations.push({ create: fieldCreateInput(field) });
  }
  for (const [key, changed] of [...drifted].sort(([a], [b]) => a.localeCompare(b))) {
    const field = missing.has(key) ? undefined : declared.get(key);
    if (!field) continue;
    const update = fieldUpdateInput(field, changed);
    // `key` alone identifies the field, so an input holding nothing else is a write with no
    // opinion; Shopify would accept it and the operator would read it as a change.
    if (Object.keys(update).length > 1) operations.push({ update });
  }
  if (operations.length > 0) input.fieldDefinitions = operations;
  return input;
}

// Both are labels, so both are sent only when the plan reported them drifted; an unchanged name
// is the same no-op either way, and an update to something else never rewrites one silently.
function addLabels(
  input: Record<string, unknown>,
  paths: readonly string[],
  definition: { name: string; description?: string },
): void {
  if (paths.includes('name differs')) input.name = definition.name;
  if (paths.includes('description differs') && definition.description !== undefined) {
    input.description = definition.description;
  }
}

// No access or constraints here or below: compile refuses them on a metaobject field because
// Shopify's field definition input has nowhere to put them. Capabilities it does take, but only
// the ones compile allows, so this projects whatever survived it.
function fieldCreateInput(field: CanonicalField): Record<string, unknown> {
  const input: Record<string, unknown> = { key: field.key, type: field.type, name: field.name };
  if (field.description !== undefined) input.description = field.description;
  if (field.required !== undefined) input.required = field.required;
  if (field.validations.length > 0) input.validations = field.validations;
  if (field.capabilities) input.capabilities = capabilityInput(field.capabilities);
  return input;
}

// Scoped the same way a definition update is: only the attributes the plan reported drifted, so
// relabelling a field never restates its validations or required flag. No `type` (Shopify will
// not retype a field) and no `delete` operation is ever emitted.
function fieldUpdateInput(field: CanonicalField, paths: readonly string[]): Record<string, unknown> {
  const input: Record<string, unknown> = { key: field.key };
  addLabels(input, paths, field);
  if (paths.some((path) => path.startsWith('required:')) && field.required !== undefined) {
    input.required = field.required;
  }
  if (paths.includes('validations differ')) input.validations = field.validations;
  if (paths.some((path) => path.startsWith('capabilities.')) && field.capabilities) {
    input.capabilities = capabilityInput(field.capabilities);
  }
  return input;
}

function metaobjectCreateInput(definition: CanonicalMetaobject): Record<string, unknown> {
  const input: Record<string, unknown> = {
    type: definition.type,
    name: definition.name,
    fieldDefinitions: definition.fields.map(fieldCreateInput),
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

function redactError(error: unknown): Error {
  if (error instanceof AdminError) return error;
  return new AdminError(error instanceof Error ? error.message : String(error));
}

function backoff(attempt: number, retryAfter?: string | null): number {
  const seconds = retryAfter === undefined || retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10_000);
  return Math.min(250 * 2 ** attempt, 4_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const METAOBJECT_QUERY = `
query MetaobjectDefinition($type: String!) {
  metaobjectDefinitionByType(type: $type) { ${METAOBJECT_SELECTION} }
}`;

// Owner, namespace and key travel in `identifier`, never as top-level arguments: the only other
// selector is `id`, which is deprecated and which a schema-first tool has no way to know.
const METAFIELD_QUERY = `
query MetafieldDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
  metafieldDefinition(identifier: $identifier) { ${METAFIELD_SELECTION} }
}`;

const METAOBJECT_CREATE = `
mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
  metaobjectDefinitionCreate(definition: $definition) {
    metaobjectDefinition { id type }
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

// Neither update carries a `delete` field operation or a `type`: an update rewrites shape the
// operator declared and nothing else.
const METAOBJECT_UPDATE = `
mutation UpdateMetaobjectDefinition($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
  metaobjectDefinitionUpdate(id: $id, definition: $definition) {
    metaobjectDefinition { id }
    userErrors { field message code }
  }
}`;

const METAFIELD_UPDATE = `
mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
  metafieldDefinitionUpdate(definition: $definition) {
    updatedDefinition { id }
    userErrors { field message code }
  }
}`;
