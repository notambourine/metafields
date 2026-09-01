import type { AdminClient } from './admin.js';
import {
  mapMetafield, mapMetaobject, METAFIELD_SELECTION, METAOBJECT_SELECTION,
  type RawMetafield, type RawMetaobject,
} from './admin-shapes.js';
import type { PulledSchema } from './generator.js';
import type { ExistingMetaobject } from './planner.js';
import { toPortableField } from './references.js';
import { isReservedNamespace, OWNER_TYPES, type Owner } from './schema.js';

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
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
  // Reserved definitions are excluded from the schema but stay in the index: a kept metafield may
  // still reference one, and naming its type beats emitting an id no other store shares.
  const typeById = new Map<string, string>();
  if (options.metaobjects) {
    let after: string | null = null;
    do {
      const data: { metaobjectDefinitions: Connection<RawMetaobject> } = await client.request(
        METAOBJECT_DEFINITIONS_QUERY,
        { after },
      );
      for (const raw of data.metaobjectDefinitions.nodes) {
        typeById.set(raw.id, raw.type);
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
  return {
    metaobjects: metaobjects.map((definition) => ({
      ...definition,
      fields: definition.fields.map((field) => toPortableField(field, typeById)),
    })),
    metafields: metafields.map((definition) => toPortableField(definition, typeById)),
    excluded,
  };
}

const METAFIELD_DEFINITIONS_QUERY = `
query PullMetafieldDefinitions(
  $ownerType: MetafieldOwnerType!
  $namespace: String
  $after: String
) {
  metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, first: 100, after: $after) {
    nodes { ${METAFIELD_SELECTION} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const METAOBJECT_DEFINITIONS_QUERY = `
query PullMetaobjectDefinitions($after: String) {
  metaobjectDefinitions(first: 100, after: $after) {
    nodes { ${METAOBJECT_SELECTION} }
    pageInfo { hasNextPage endCursor }
  }
}`;
