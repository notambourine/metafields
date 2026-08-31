import { METAFIELD_TYPES } from './metafield-types.js';
import type { CompiledSchema, Owner } from './schema.js';

// The Liquid language server groups definitions by these handles and has none for
// customer or draft_order, so metafields on those owners cannot be represented.
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

// Categories come from Shopify's own type list. The language server reads only type.name, so a
// category is descriptive rather than load bearing; a type Shopify does not publish is the
// interesting case, and UNKNOWN is how it shows up in the emitted file.
function categoryOf(type: string): string {
  const base = type.startsWith('list.') ? type.slice('list.'.length) : type;
  const types: Record<string, { category: string } | undefined> = METAFIELD_TYPES;
  return (types[type] ?? types[base])?.category ?? 'UNKNOWN';
}

export function isLiquidMetafieldsFile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => Array.isArray(entry));
}
