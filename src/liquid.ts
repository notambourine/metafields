import { baseType } from './declarable.js';
import { METAFIELD_TYPES } from './metafield-types.js';
import type { CompiledSchema, Owner } from './schema.js';

// The Liquid language server has no groups for customer or draft_order metafields.
const LIQUID_OWNERS = {
  article: 'article',
  blog: 'blog',
  collection: 'collection',
  company: 'company',
  company_location: 'company_location',
  location: 'location',
  order: 'order',
  page: 'page',
  product: 'product',
  product_variant: 'variant',
  shop: 'shop',
} as const satisfies Partial<Record<Owner, string>>;

export interface LiquidMetafield {
  key: string;
  name: string;
  namespace: string;
  description: string;
  type: { category: string; name: string };
}

export type LiquidMetafields = Record<string, LiquidMetafield[]>;

export interface LiquidEmit {
  definitions: LiquidMetafields;
  skipped: string[];
}

export function emitLiquidMetafields(schema: CompiledSchema): LiquidEmit {
  const definitions: LiquidMetafields = {};
  const skipped: string[] = [];
  for (const metafield of schema.metafields) {
    const owner = (LIQUID_OWNERS as Partial<Record<Owner, string>>)[metafield.owner];
    if (!owner) {
      skipped.push(`${metafield.owner}:${metafield.namespace}.${metafield.key}`);
      continue;
    }
    (definitions[owner] ??= []).push({
      key: metafield.key,
      name: metafield.name,
      namespace: metafield.namespace,
      description: metafield.description ?? '',
      type: { category: categoryOf(metafield.type), name: metafield.type },
    });
  }
  return { definitions, skipped };
}

// UNKNOWN exposes types missing from Shopify's supported list.
function categoryOf(type: string): string {
  const types: Record<string, { category: string } | undefined> = METAFIELD_TYPES;
  return (types[type] ?? types[baseType(type)])?.category ?? 'UNKNOWN';
}

export function isLiquidMetafieldsFile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => Array.isArray(entry));
}
