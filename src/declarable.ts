
import { METAFIELD_TYPES } from './metafield-types.js';

export const BUILDERS: Record<string, string> = {
  article_reference: 'article',
  boolean: 'boolean',
  collection_reference: 'collection',
  color: 'color',
  company_reference: 'company',
  customer_reference: 'customer',
  date: 'date',
  date_time: 'dateTime',
  file_reference: 'file',
  id: 'id',
  json: 'json',
  jurisdiction: 'jurisdiction',
  language: 'language',
  link: 'link',
  metaobject_reference: 'metaobject',
  mixed_reference: 'mixedMetaobject',
  money: 'money',
  multi_line_text_field: 'text',
  number_decimal: 'decimal',
  number_integer: 'integer',
  order_reference: 'order',
  page_reference: 'page',
  product_reference: 'product',
  rating: 'rating',
  rich_text_field: 'richText',
  single_line_text_field: 'string',
  url: 'url',
  variant_reference: 'variant',
};

// Store-owned types cannot be represented in a portable schema.
export const DECLINED: Record<string, string> = {
  disclosure_reference: 'points at Shopify-owned metaobject definitions no schema can create',
  product_taxonomy_disclosure_reference: 'points at Shopify-owned disclosure definitions',
  product_taxonomy_value_reference: "names a handle from Shopify's product taxonomy",
};

// Map Shopify validation names to builder options. Pull skips unrepresentable validations.
export const VALIDATION_OPTIONS: Record<string, string> = {
  min: 'min',
  max: 'max',
  regex: 'regex',
  choices: 'choices',
  schema: 'schema',
  max_precision: 'maxPrecision',
  scale_min: 'scaleMin',
  scale_max: 'scaleMax',
  file_type_options: 'fileTypes',
  allowed_domains: 'allowedDomains',
};

export const REFERENCE_VALIDATIONS = new Set([
  'metaobject_definition_id',
  'metaobject_definition_ids',
  'metaobject_definition_type',
  'metaobject_definition_types',
]);

export const DECLINED_VALIDATIONS: Record<string, string> = {};

export interface BuilderCall {
  readonly name: string;
  readonly args: readonly string[];
}

export function baseType(type: string): string {
  return type.startsWith('list.') ? type.slice('list.'.length) : type;
}

export function builderFor(type: string): BuilderCall | undefined {
  const base = baseType(type);
  const name = BUILDERS[base];
  if (name !== undefined) return { name, args: [] };
  const types: Record<string, { category: string } | undefined> = METAFIELD_TYPES;
  return types[base]?.category === 'MEASUREMENT'
    ? { name: 'measurement', args: [JSON.stringify(base)] }
    : undefined;
}

export function declarability(type: string): { builder: BuilderCall } | { declined: string } | undefined {
  const base = baseType(type);
  const builder = builderFor(base);
  if (builder) return { builder };
  const declined = DECLINED[base];
  return declined === undefined ? undefined : { declined };
}
