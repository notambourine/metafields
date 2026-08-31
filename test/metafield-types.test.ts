import assert from 'node:assert/strict';
import test from 'node:test';
import { METAFIELD_OWNER_TYPES, METAFIELD_TYPES, compileSchema, defineSchema, field, metaobject } from '../dist/index.js';
import { OWNER_TYPES } from '../dist/schema.js';

// Every type string the builders can produce, paired with the factory that produces it. Adding a
// factory without adding it here is the transcription this file exists to catch.
const FACTORY_TYPES: Record<string, string> = {
  string: 'single_line_text_field',
  text: 'multi_line_text_field',
  richText: 'rich_text_field',
  integer: 'number_integer',
  decimal: 'number_decimal',
  boolean: 'boolean',
  url: 'url',
  json: 'json',
  product: 'product_reference',
  variant: 'variant_reference',
  collection: 'collection_reference',
  file: 'file_reference',
  metaobject: 'metaobject_reference',
  mixedMetaobject: 'mixed_reference',
};

// Shopify publishes no list.* counterpart for these, so field.list() around one of them builds a
// type the Admin API will reject. Documented rather than fixed: narrowing field.list() means
// threading the type string through FieldDefinition, which is a breaking type change.
const NOT_LISTABLE = ['boolean', 'json', 'multi_line_text_field', 'rich_text_field'];

function typeOf(name: string): string {
  const factory = (field as Record<string, (...args: never[]) => { type: string }>)[name]!;
  return name === 'metaobject'
    ? field.metaobject('faq').type
    : name === 'mixedMetaobject'
      ? field.mixedMetaobject(['faq']).type
      : factory().type;
}

test('every builder produces a type Shopify publishes', () => {
  for (const [name, expected] of Object.entries(FACTORY_TYPES)) {
    assert.equal(typeOf(name), expected, `field.${name}() changed type`);
    assert.ok(expected in METAFIELD_TYPES, `field.${name}() builds unknown type ${expected}`);
  }
});

test('the builders that cannot be wrapped in field.list() are the ones Shopify has no list type for', () => {
  const missing = Object.values(FACTORY_TYPES)
    .filter((type) => !(`list.${type}` in METAFIELD_TYPES))
    .sort();
  assert.deepEqual(missing, NOT_LISTABLE);
});

test('declared owners are a subset of the MetafieldOwnerType enum', () => {
  for (const [handle, ownerType] of Object.entries(OWNER_TYPES)) {
    assert.ok(
      (METAFIELD_OWNER_TYPES as readonly string[]).includes(ownerType),
      `owner ${handle} maps to ${ownerType}, which the enum no longer has`,
    );
  }
});

test('the validations the builders emit are supported by the types that carry them', () => {
  const compiled = compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({ name: 'FAQ', fields: { question: field.string({ max: 100 }) } }),
    },
    metafields: {
      product: {
        custom: {
          sku: field.string({ regex: '^[A-Z]+$' }),
          rank: field.integer({ min: 1, max: 10 }),
          spec: field.json({ schema: { type: 'object' } }),
          related: field.list(field.product(), { min: 1, max: 3 }),
          faq: field.metaobject('faq'),
        },
      },
    },
  }));
  const supported: Record<string, { validations: readonly string[] } | undefined> = METAFIELD_TYPES;
  for (const metafield of compiled.metafields) {
    const known = supported[metafield.type]?.validations ?? [];
    for (const validation of metafield.validations) {
      assert.ok(
        known.includes(validation.name),
        `${metafield.type} does not support the validation ${validation.name}`,
      );
    }
  }
});
