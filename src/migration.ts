import { createHash } from 'node:crypto';
import type { AdminClient } from './admin.js';
import type { SyncMode } from './planner.js';
import { OWNER_TYPES, stringifyCanonical, type Owner } from './schema.js';
import { FIELD_MARKER, type FieldDefinition } from './types.js';

export const MIGRATION_MARKER = '@notambourine/metafields/migration' as const;

export interface UrlTransform {
  readonly kind: 'url';
  readonly allowedSchemes: readonly ('http' | 'https' | 'mailto' | 'sms' | 'tel')[];
  readonly bareHost: 'reject';
  readonly trim: boolean;
}

export interface MigrationDefinition {
  readonly __kind: typeof MIGRATION_MARKER;
  readonly id: string;
  readonly from: FieldDefinition;
  readonly to: FieldDefinition;
  readonly mode: 'copy';
  readonly transform: UrlTransform;
  readonly onInvalid: 'fail';
  readonly onTargetConflict: 'fail';
}

export interface CompiledMigration {
  format: '@notambourine/metafields/migration-v1';
  id: string;
  source: FieldIdentity & { type: string };
  target: FieldIdentity & { type: string };
  mode: 'copy';
  transform: UrlTransform;
  onInvalid: 'fail';
  onTargetConflict: 'fail';
  checksum: string;
}

interface FieldIdentity { owner: Owner; namespace: string; key: string }

export const transforms = {
  url(options: Omit<UrlTransform, 'kind'>): UrlTransform {
    return { kind: 'url', ...options };
  },
};

export function defineMigration<const M extends Omit<MigrationDefinition, '__kind'>>(
  definition: M,
): M & { readonly __kind: typeof MIGRATION_MARKER } {
  return { __kind: MIGRATION_MARKER, ...definition };
}

export function compileMigration(value: unknown): CompiledMigration {
  if (!isRecord(value) || value.__kind !== MIGRATION_MARKER) {
    throw new Error('default export must be created with defineMigration()');
  }
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(value.id)) {
    throw new Error('migration id must contain lowercase alphanumeric, hyphen, or underscore characters');
  }
  const source = compileEndpoint(value.from, 'source');
  const target = compileEndpoint(value.to, 'target');
  if (source.owner !== target.owner) throw new Error('migration source and target must have the same owner type');
  if (source.namespace === target.namespace && source.key === target.key) {
    throw new Error('migration source and target must be different keys');
  }
  if (value.mode !== 'copy' || value.onInvalid !== 'fail' || value.onTargetConflict !== 'fail') {
    throw new Error('migrations must be copy-only and fail on invalid values or target conflicts');
  }
  if (!isUrlTransform(value.transform)) throw new Error('migration must use a package-supplied transform');
  if (source.type !== 'single_line_text_field' || target.type !== 'url') {
    throw new Error(`url transform requires single_line_text_field -> url, found ${source.type} -> ${target.type}`);
  }
  const unsigned = {
    format: '@notambourine/metafields/migration-v1' as const,
    id: value.id,
    source,
    target,
    mode: 'copy' as const,
    transform: value.transform,
    onInvalid: 'fail' as const,
    onTargetConflict: 'fail' as const,
  };
  const checksum = createHash('sha256').update(stringifyCanonical(unsigned)).digest('hex');
  return { ...unsigned, checksum };
}

export function assertCompiledMigration(value: unknown): asserts value is CompiledMigration {
  if (!isRecord(value) || value.format !== '@notambourine/metafields/migration-v1' ||
      typeof value.checksum !== 'string') {
    throw new Error('compiled input is not a @notambourine/metafields migration-v1 artifact');
  }
  const { checksum, ...unsigned } = value;
  const actual = createHash('sha256').update(stringifyCanonical(unsigned)).digest('hex');
  if (actual !== checksum) throw new Error('compiled migration checksum does not match its contents');
}

function compileEndpoint(value: unknown, label: string): FieldIdentity & { type: string } {
  if (!isRecord(value) || value.__kind !== FIELD_MARKER || typeof value.type !== 'string' || !isRecord(value.identity)) {
    throw new Error(`${label} must reference a field from a defined schema`);
  }
  const { owner, namespace, key } = value.identity;
  if (typeof owner !== 'string' || !(owner in OWNER_TYPES) || typeof namespace !== 'string' || typeof key !== 'string') {
    throw new Error(`${label} has no valid schema identity`);
  }
  return { owner: owner as Owner, namespace, key, type: value.type };
}

function isUrlTransform(value: unknown): value is UrlTransform {
  if (!isRecord(value) || value.kind !== 'url' || value.bareHost !== 'reject' ||
      typeof value.trim !== 'boolean' || !Array.isArray(value.allowedSchemes) || value.allowedSchemes.length === 0) {
    return false;
  }
  const allowed = new Set(['http', 'https', 'mailto', 'sms', 'tel']);
  return value.allowedSchemes.every((scheme) => typeof scheme === 'string' && allowed.has(scheme));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface MigrationRow {
  id: string;
  source: { value: string; compareDigest: string } | null;
  target: { value: string; compareDigest: string } | null;
}

export interface MigrationResult {
  id: string;
  checksum: string;
  source: number;
  pending: number;
  equal: number;
  invalid: number;
  conflicts: number;
  applied: number;
}

const ownerConnections: Partial<Record<Owner, { connection: string; graphType: string }>> = {
  article: { connection: 'articles', graphType: 'Article' },
  blog: { connection: 'blogs', graphType: 'Blog' },
  collection: { connection: 'collections', graphType: 'Collection' },
  customer: { connection: 'customers', graphType: 'Customer' },
  draft_order: { connection: 'draftOrders', graphType: 'DraftOrder' },
  location: { connection: 'locations', graphType: 'Location' },
  order: { connection: 'orders', graphType: 'Order' },
  page: { connection: 'pages', graphType: 'Page' },
  product: { connection: 'products', graphType: 'Product' },
  product_variant: { connection: 'productVariants', graphType: 'ProductVariant' },
};

export async function runMigration(
  client: AdminClient,
  migration: CompiledMigration,
  mode: SyncMode,
): Promise<MigrationResult> {
  assertCompiledMigration(migration);
  await verifyDefinitions(client, migration);
  const rows = await readRows(client, migration);
  const writes: { ownerId: string; namespace: string; key: string; type: string; value: string; compareDigest: string | null }[] = [];
  let equal = 0;
  let invalid = 0;
  let conflicts = 0;
  for (const row of rows) {
    if (!row.source || row.source.value.length === 0) continue;
    const transformed = transformValue(row.source.value, migration.transform);
    if (transformed === null) {
      invalid += 1;
      continue;
    }
    if (row.target?.value === transformed) {
      equal += 1;
      continue;
    }
    if (row.target !== null) {
      conflicts += 1;
      continue;
    }
    writes.push({
      ownerId: row.id,
      namespace: migration.target.namespace,
      key: migration.target.key,
      type: migration.target.type,
      value: transformed,
      compareDigest: null,
    });
  }
  const result: MigrationResult = {
    id: migration.id,
    checksum: migration.checksum,
    source: rows.filter((row) => row.source?.value).length,
    pending: writes.length,
    equal,
    invalid,
    conflicts,
    applied: 0,
  };
  if (invalid > 0 || conflicts > 0 || mode !== 'apply') return result;

  for (let index = 0; index < writes.length; index += 25) {
    const batch = writes.slice(index, index + 25);
    const data = await client.request<{
      metafieldsSet: { metafields: { ownerType: string }[] | null; userErrors: { message: string }[] };
    }>(METAFIELDS_SET_MUTATION, { metafields: batch }, true);
    if (data.metafieldsSet.userErrors.length > 0 || !data.metafieldsSet.metafields) {
      throw new Error(`migration write failed: ${data.metafieldsSet.userErrors.map((error) => error.message).join('; ')}`);
    }
    const verified = await readNodes(client, migration, batch.map((write) => write.ownerId));
    for (const row of verified) {
      const original = rows.find((item) => item.id === row.id);
      const expected = batch.find((item) => item.ownerId === row.id);
      if (!original?.source || row.source?.compareDigest !== original.source.compareDigest) {
        throw new Error(`source changed during migration for owner ${row.id}`);
      }
      if (!expected || row.target?.value !== expected.value) {
        throw new Error(`target verification failed for owner ${row.id}`);
      }
    }
    result.applied += batch.length;
  }
  result.pending = 0;
  return result;
}

// Return nonzero while rows remain pending, including in dry-run mode.
export function migrationExitCode(result: MigrationResult): number {
  return result.invalid > 0 || result.conflicts > 0 || result.pending > 0 ? 1 : 0;
}

async function verifyDefinitions(client: AdminClient, migration: CompiledMigration): Promise<void> {
  const source = await client.readMetafield({
    ownerType: OWNER_TYPES[migration.source.owner],
    namespace: migration.source.namespace,
    key: migration.source.key,
  });
  const target = await client.readMetafield({
    ownerType: OWNER_TYPES[migration.target.owner],
    namespace: migration.target.namespace,
    key: migration.target.key,
  });
  const sourceType = source && (typeof source.type === 'string' ? source.type : source.type.name);
  const targetType = target && (typeof target.type === 'string' ? target.type : target.type.name);
  if (sourceType !== migration.source.type) throw new Error('migration source definition is missing or has the wrong type');
  if (targetType !== migration.target.type) throw new Error('migration target definition is missing or has the wrong type');
}

async function readRows(client: AdminClient, migration: CompiledMigration): Promise<MigrationRow[]> {
  if (migration.source.owner === 'shop') {
    const data = await client.request<{ shop: MigrationRow }>(ownerQuery('shop', 'Shop'), variables(migration));
    return [data.shop];
  }
  const config = ownerConnections[migration.source.owner];
  if (!config) throw new Error(`migrations do not yet support ${migration.source.owner} owners`);
  const rows: MigrationRow[] = [];
  let after: string | null = null;
  do {
    const data: Record<string, MigrationConnection> = await client.request<Record<string, MigrationConnection>>(
      ownerQuery(config.connection, config.graphType), { ...variables(migration), after });
    const connection: MigrationConnection | undefined = data[config.connection];
    if (!connection) throw new Error(`Shopify returned no ${config.connection} connection`);
    rows.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return rows;
}

interface MigrationConnection {
  nodes: MigrationRow[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function readNodes(client: AdminClient, migration: CompiledMigration, ids: string[]): Promise<MigrationRow[]> {
  const graphType = migration.source.owner === 'shop'
    ? 'Shop'
    : ownerConnections[migration.source.owner]?.graphType;
  if (!graphType) throw new Error(`migrations do not support ${migration.source.owner} owners`);
  const data = await client.request<{ nodes: (MigrationRow | null)[] }>(`
    query VerifyMigration($ids: [ID!]!, $sourceNamespace: String!, $sourceKey: String!, $targetNamespace: String!, $targetKey: String!) {
      nodes(ids: $ids) {
        ... on ${graphType} {
          id
          source: metafield(namespace: $sourceNamespace, key: $sourceKey) { value compareDigest }
          target: metafield(namespace: $targetNamespace, key: $targetKey) { value compareDigest }
        }
      }
    }
  `, { ...variables(migration), ids });
  return data.nodes.filter((row): row is MigrationRow => row !== null);
}

function ownerQuery(connection: string, graphType: string): string {
  const selection = `
    id
    source: metafield(namespace: $sourceNamespace, key: $sourceKey) { value compareDigest }
    target: metafield(namespace: $targetNamespace, key: $targetKey) { value compareDigest }
  `;
  if (connection === 'shop') {
    return `query MigrationRows($sourceNamespace: String!, $sourceKey: String!, $targetNamespace: String!, $targetKey: String!) { shop { ${selection} } }`;
  }
  return `query MigrationRows($after: String, $sourceNamespace: String!, $sourceKey: String!, $targetNamespace: String!, $targetKey: String!) {
    ${connection}(first: 100, after: $after) {
      nodes { ... on ${graphType} { ${selection} } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

function variables(migration: CompiledMigration): Record<string, string> {
  return {
    sourceNamespace: migration.source.namespace,
    sourceKey: migration.source.key,
    targetNamespace: migration.target.namespace,
    targetKey: migration.target.key,
  };
}

function transformValue(value: string, transform: UrlTransform): string | null {
  const candidate = transform.trim ? value.trim() : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1);
  return transform.allowedSchemes.includes(scheme as UrlTransform['allowedSchemes'][number]) ? candidate : null;
}

const METAFIELDS_SET_MUTATION = `
mutation ApplyMigration($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { ownerType }
    userErrors { field message code }
  }
}`;
