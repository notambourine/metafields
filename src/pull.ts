import type { AdminClient } from './admin.js';
import type { PulledSchema } from './generator.js';
import type { ExistingField, ExistingMetafield, ExistingMetaobject } from './planner.js';
import { isReservedNamespace, OWNER_TYPES, type Owner } from './schema.js';

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RawField {
  key: string;
  name: string;
  description?: string | null;
  type: { name: string };
  required?: boolean;
  validations: { name: string; value: string }[];
}

interface RawMetafield extends RawField {
  namespace: string;
  ownerType: string;
  access: Record<string, string | null>;
  capabilities: Record<string, { enabled: boolean }>;
  constraints?: { key: string | null; values: { nodes: { value: string }[] } } | null;
  validationStatus: ExistingMetafield['validationStatus'];
  invalidCount: number;
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

export interface PullOptions {
  owners: Owner[];
  namespaces: string[];
  allNamespaces: boolean;
  metaobjects: boolean;
}

export async function pullSchema(client: AdminClient, options: PullOptions): Promise<PulledSchema> {
  const metafields: PulledSchema['metafields'] = [];
  const excluded: string[] = [];
  const seen = new Set<string>();
  for (const owner of options.owners) {
    const namespaces: (string | undefined)[] = options.allNamespaces ? [undefined] : options.namespaces;
    for (const namespace of namespaces) {
      let after: string | null = null;
      do {
        const data: { metafieldDefinitions: Connection<RawMetafield> } = await client.request(
          METAFIELD_DEFINITIONS_QUERY,
          { ownerType: OWNER_TYPES[owner], namespace: namespace ?? null, after },
        );
        for (const raw of data.metafieldDefinitions.nodes) {
          const identity = `${owner}:${raw.namespace}.${raw.key}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          if (isReservedNamespace(raw.namespace)) {
            excluded.push(identity);
            continue;
          }
          metafields.push({ owner, ...mapMetafield(raw) });
        }
        after = data.metafieldDefinitions.pageInfo.hasNextPage
          ? data.metafieldDefinitions.pageInfo.endCursor
          : null;
      } while (after);
    }
  }

  const hasMetaobjectReferences = metafields.some((field) => {
    const type = typeof field.type === 'string' ? field.type : field.type.name;
    return type.endsWith('metaobject_reference') || type.endsWith('mixed_reference');
  });
  if (hasMetaobjectReferences && !options.metaobjects) {
    throw new Error('selected metafields contain metaobject references; rerun pull with --metaobjects');
  }

  const metaobjects: ExistingMetaobject[] = [];
  if (options.metaobjects) {
    let after: string | null = null;
    do {
      const data: { metaobjectDefinitions: Connection<RawMetaobject> } = await client.request(
        METAOBJECT_DEFINITIONS_QUERY,
        { after },
      );
      for (const raw of data.metaobjectDefinitions.nodes) {
        if (/^(app|shopify)--/i.test(raw.type)) {
          excluded.push(`metaobject:${raw.type}`);
          continue;
        }
        metaobjects.push(mapMetaobject(raw));
      }
      after = data.metaobjectDefinitions.pageInfo.hasNextPage
        ? data.metaobjectDefinitions.pageInfo.endCursor
        : null;
    } while (after);
  }
  return { metaobjects, metafields, excluded };
}

function mapField(value: RawField): ExistingField {
  return {
    key: value.key,
    name: value.name,
    description: value.description,
    type: value.type,
    required: value.required,
    validations: value.validations,
  };
}

function mapMetafield(value: RawMetafield): ExistingMetafield {
  return {
    ...mapField(value),
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

const METAFIELD_DEFINITIONS_QUERY = `
query PullMetafieldDefinitions(
  $ownerType: MetafieldOwnerType!
  $namespace: String
  $after: String
) {
  metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, first: 100, after: $after) {
    nodes {
      namespace key ownerType name description type { name }
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
    pageInfo { hasNextPage endCursor }
  }
}`;

const METAOBJECT_DEFINITIONS_QUERY = `
query PullMetaobjectDefinitions($after: String) {
  metaobjectDefinitions(first: 100, after: $after) {
    nodes {
      id type name description displayNameKey
      access { admin storefront }
      capabilities { publishable { enabled } translatable { enabled } }
      fieldDefinitions {
        key name description type { name } required validations { name value }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
