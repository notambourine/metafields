import type { MetafieldOwnerType } from './metafield-types.js';
import {
  FIELD_MARKER,
  METAOBJECT_MARKER,
  SCHEMA_MARKER,
  type FieldDefinition,
  type SchemaDefinition,
  type Validation,
} from './types.js';

export { SCHEMA_MARKER } from './types.js';

// Accept only merchant-owned custom-data handles while checking them against Shopify's enum.
export const OWNER_TYPES = {
  article: 'ARTICLE',
  blog: 'BLOG',
  collection: 'COLLECTION',
  company: 'COMPANY',
  company_location: 'COMPANY_LOCATION',
  customer: 'CUSTOMER',
  draft_order: 'DRAFTORDER',
  location: 'LOCATION',
  order: 'ORDER',
  page: 'PAGE',
  product: 'PRODUCT',
  product_variant: 'PRODUCTVARIANT',
  shop: 'SHOP',
} as const satisfies Record<string, MetafieldOwnerType>;

export type Owner = keyof typeof OWNER_TYPES;

export interface CanonicalField {
  key: string;
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  validations: Validation[];
  access?: Record<string, string>;
  capabilities?: Record<string, boolean>;
  constraints?: { key: string; values: string[] };
}

export interface CanonicalMetaobject {
  kind: 'metaobject';
  type: string;
  name: string;
  description?: string;
  displayNameKey?: string;
  access?: Record<string, string>;
  capabilities?: Record<string, boolean>;
  fields: CanonicalField[];
}

export interface CanonicalMetafield extends CanonicalField {
  kind: 'metafield';
  owner: Owner;
  ownerType: string;
  namespace: string;
}

export interface CompiledSchema {
  format: '@notambourine/metafields/schema-v1';
  metaobjects: CanonicalMetaobject[];
  metafields: CanonicalMetafield[];
}

const keyPattern = /^[A-Za-z0-9_-]+$/;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function humanize(key: string): string {
  return key.replaceAll('_', ' ').replaceAll('-', ' ').replace(/^./, (value) => value.toUpperCase());
}

function validateKey(key: string, path: string, min: number, max: number): void {
  if (key.length < min || key.length > max || !keyPattern.test(key)) {
    fail(path, `must be ${min}-${max} alphanumeric, hyphen, or underscore characters`);
  }
}

export function isReservedNamespace(namespace: string): boolean {
  const value = namespace.toLowerCase();
  return value === 'app' || value === '$app' || value.startsWith('app--') ||
    value === 'shopify' || value.startsWith('shopify--');
}

function normalizeAccess(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) fail(path, 'must be an object');
  const result: Record<string, string> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (typeof setting !== 'string') fail(`${path}.${key}`, 'must be a string');
    result[key] = setting.toUpperCase();
  }
  return result;
}

function normalizeCapabilities(value: unknown, path: string): Record<string, boolean> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) fail(path, 'must be an object');
  const result: Record<string, boolean> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (typeof setting !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
    result[key] = setting;
  }
  return result;
}

function normalizeField(field: unknown, key: string, path: string): CanonicalField {
  if (!record(field) || field.__kind !== FIELD_MARKER) fail(path, 'must be created with field.*()');
  if (typeof field.type !== 'string') fail(`${path}.type`, 'must be a string');
  if (!record(field.options)) fail(`${path}.options`, 'must be an object');
  if (!Array.isArray(field.validations)) fail(`${path}.validations`, 'must be an array');
  validateKey(key, path, 2, 64);
  const options = field.options;
  const normalized: CanonicalField = {
    key,
    name: typeof options.name === 'string' ? options.name : humanize(key),
    type: field.type,
    validations: field.validations.map((item, index) => {
      if (!record(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
        fail(`${path}.validations[${index}]`, 'must contain string name and value');
      }
      return { name: item.name, value: item.value };
    }),
  };
  if (typeof options.description === 'string') normalized.description = options.description;
  if (options.required === true) normalized.required = true;
  const access = normalizeAccess(options.access, `${path}.access`);
  if (access) normalized.access = access;
  const capabilities: Record<string, boolean> = {};
  for (const key of [
    'adminFilterable', 'analyticsQueryable', 'cartToOrderCopyable', 'smartCollectionCondition', 'uniqueValues',
  ] as const) {
    if (typeof options[key] === 'boolean') capabilities[key] = options[key];
  }
  if (Object.keys(capabilities).length > 0) normalized.capabilities = capabilities;
  if (options.constraints !== undefined) {
    if (!record(options.constraints) || typeof options.constraints.key !== 'string' ||
        !Array.isArray(options.constraints.values) ||
        !options.constraints.values.every((item) => typeof item === 'string')) {
      fail(`${path}.constraints`, 'must contain a string key and string values');
    }
    normalized.constraints = {
      key: options.constraints.key,
      values: [...options.constraints.values].sort(),
    };
  }
  return normalized;
}

export function compileSchema(value: unknown): CompiledSchema {
  if (!record(value) || value.__kind !== SCHEMA_MARKER) {
    fail('default export', 'must be a schema created with defineSchema()');
  }
  if (!record(value.metaobjects)) fail('schema.metaobjects', 'must be an object');
  if (!record(value.metafields)) fail('schema.metafields', 'must be an object');

  const metaobjectKeys = new Set(Object.keys(value.metaobjects));
  const metaobjects: CanonicalMetaobject[] = [];
  const metaobjectDependencies = new Map<string, Set<string>>();
  for (const [type, rawDefinition] of Object.entries(value.metaobjects).sort(([a], [b]) => a.localeCompare(b))) {
    const path = `schema.metaobjects.${type}`;
    validateKey(type, path, 3, 255);
    if (!record(rawDefinition) || rawDefinition.__kind !== METAOBJECT_MARKER) {
      fail(path, 'must be created with metaobject()');
    }
    if (typeof rawDefinition.name !== 'string' || rawDefinition.name.length === 0) {
      fail(`${path}.name`, 'must be a non-empty string');
    }
    if (!record(rawDefinition.fields) || Object.keys(rawDefinition.fields).length === 0) {
      fail(`${path}.fields`, 'must contain at least one field');
    }
    if (rawDefinition.displayNameKey !== undefined &&
        (typeof rawDefinition.displayNameKey !== 'string' || !(rawDefinition.displayNameKey in rawDefinition.fields))) {
      fail(`${path}.displayNameKey`, 'must name a declared field');
    }
    const dependencies = new Set<string>();
    for (const [fieldKey, rawField] of Object.entries(rawDefinition.fields)) {
      if (record(rawField) && Array.isArray(rawField.targets)) {
        for (const target of rawField.targets) {
          if (typeof target !== 'string' || !metaobjectKeys.has(target)) {
            fail(`${path}.fields.${fieldKey}`, `references undeclared metaobject ${String(target)}`);
          }
          dependencies.add(target);
        }
      }
    }
    metaobjectDependencies.set(type, dependencies);
    const definition: CanonicalMetaobject = {
      kind: 'metaobject',
      type,
      name: rawDefinition.name,
      fields: Object.entries(rawDefinition.fields)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => normalizeField(field, key, `${path}.fields.${key}`)),
    };
    if (typeof rawDefinition.description === 'string') definition.description = rawDefinition.description;
    if (typeof rawDefinition.displayNameKey === 'string') definition.displayNameKey = rawDefinition.displayNameKey;
    const access = normalizeAccess(rawDefinition.access, `${path}.access`);
    if (access) definition.access = access;
    const capabilities = normalizeCapabilities(rawDefinition.capabilities, `${path}.capabilities`);
    if (capabilities) definition.capabilities = capabilities;
    metaobjects.push(definition);
  }
  const orderedMetaobjects = dependencyOrder(metaobjects, metaobjectDependencies);

  const metafields: CanonicalMetafield[] = [];
  for (const [owner, rawNamespaces] of Object.entries(value.metafields).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(owner in OWNER_TYPES)) fail(`schema.metafields.${owner}`, 'uses an unsupported owner type');
    if (!record(rawNamespaces)) fail(`schema.metafields.${owner}`, 'must be an object');
    for (const [namespace, rawFields] of Object.entries(rawNamespaces).sort(([a], [b]) => a.localeCompare(b))) {
      const namespacePath = `schema.metafields.${owner}.${namespace}`;
      validateKey(namespace, namespacePath, 3, 255);
      if (isReservedNamespace(namespace)) fail(namespacePath, 'uses a reserved namespace');
      if (!record(rawFields)) fail(namespacePath, 'must be an object');
      for (const [key, field] of Object.entries(rawFields).sort(([a], [b]) => a.localeCompare(b))) {
        const normalized = normalizeField(field, key, `${namespacePath}.${key}`);
        const targets = record(field) && Array.isArray(field.targets) ? field.targets : [];
        for (const target of targets) {
          if (typeof target !== 'string' || !metaobjectKeys.has(target)) {
            fail(`${namespacePath}.${key}`, `references undeclared metaobject ${String(target)}`);
          }
        }
        metafields.push({
          kind: 'metafield',
          owner: owner as Owner,
          ownerType: OWNER_TYPES[owner as Owner],
          namespace,
          ...normalized,
        });
      }
    }
  }

  return { format: '@notambourine/metafields/schema-v1', metaobjects: orderedMetaobjects, metafields };
}

function dependencyOrder(
  definitions: CanonicalMetaobject[],
  dependencies: Map<string, Set<string>>,
): CanonicalMetaobject[] {
  const remaining = new Map(definitions.map((definition) => [definition.type, definition]));
  const result: CanonicalMetaobject[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((type) =>
      [...(dependencies.get(type) ?? [])].every((target) => !remaining.has(target)),
    ).sort();
    if (ready.length === 0) {
      throw new Error(`metaobject references contain a creation cycle: ${[...remaining.keys()].sort().join(', ')}`);
    }
    for (const type of ready) {
      result.push(remaining.get(type) as CanonicalMetaobject);
      remaining.delete(type);
    }
  }
  return result;
}

export function assertCompiledSchema(value: unknown): asserts value is CompiledSchema {
  if (!record(value) || value.format !== '@notambourine/metafields/schema-v1' ||
      !Array.isArray(value.metaobjects) || !Array.isArray(value.metafields)) {
    throw new Error('compiled input is not a @notambourine/metafields schema-v1 artifact');
  }
}

export function stringifyCanonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
