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

// Categories follow the published type list. The language server reads only type.name,
// so a category is descriptive rather than load bearing.
const TYPE_CATEGORIES: Record<string, string> = {
  single_line_text_field: 'TEXT',
  multi_line_text_field: 'TEXT',
  rich_text_field: 'TEXT',
  number_integer: 'NUMBER',
  number_decimal: 'NUMBER',
  boolean: 'TRUE_FALSE',
  url: 'URL',
  json: 'JSON',
  product_reference: 'REFERENCE',
  variant_reference: 'REFERENCE',
  collection_reference: 'REFERENCE',
  file_reference: 'REFERENCE',
  metaobject_reference: 'REFERENCE',
  mixed_reference: 'REFERENCE',
};

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

function categoryOf(type: string): string {
  const base = type.startsWith('list.') ? type.slice('list.'.length) : type;
  return TYPE_CATEGORIES[base] ?? 'UNKNOWN';
}

export function isLiquidMetafieldsFile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => Array.isArray(entry));
}
