// What the DSL can say about a Shopify type, in one table. The builders emit validations through
// it, pull chooses what it can write from it, and a test compares it against the generated
// registry, so a type Shopify adds surfaces as a failing check rather than a customer-side abort.

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

// Types this release will not declare, and why. Each names something Shopify owns on the store
// itself, so a schema that travels between stores cannot carry it.
export const DECLINED: Record<string, string> = {
  disclosure_reference: 'points at Shopify-owned metaobject definitions no schema can create',
  product_taxonomy_disclosure_reference: 'points at Shopify-owned disclosure definitions',
  product_taxonomy_value_reference: "names a handle from Shopify's product taxonomy",
};

// Shopify validation name to the builder option that declares it. A validation absent here is one
// no schema can state, which is why pull reports the field instead of writing a definition that
// says less than the store does.
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

// Validations a builder argument carries instead of an option, because they name the definition a
// reference points at rather than bound its value.
export const REFERENCE_VALIDATIONS = new Set([
  'metaobject_definition_id',
  'metaobject_definition_ids',
  'metaobject_definition_type',
  'metaobject_definition_types',
]);

// Validations this release will not state, and why, for types it otherwise declares. Empty is the
// healthy state: the coverage test routes a validation Shopify adds through here or an option.
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

// Every type the table accounts for, paired with how. The coverage test walks the registry against
// this, so a new type is either declarable or a deliberate omission with a reason.
export function declarability(type: string): { builder: BuilderCall } | { declined: string } | undefined {
  const base = baseType(type);
  const builder = builderFor(base);
  if (builder) return { builder };
  const declined = DECLINED[base];
  return declined === undefined ? undefined : { declined };
}
