import assert from 'node:assert/strict';
import test from 'node:test';
import { METAFIELD_OWNER_TYPES, METAFIELD_TYPES, compileSchema, defineSchema, field, metaobject } from '../dist/index.js';
import { baseType, BUILDERS, DECLINED, declarability } from '../dist/declarable.js';
import { OWNER_TYPES } from '../dist/schema.js';

type Factory = (...args: never[]) => { type: string };

// The arguments each builder needs before it can name its type. Everything else takes none.
function sample(name: string): { type: string } {
  if (name === 'metaobject') return field.metaobject('faq');
  if (name === 'mixedMetaobject') return field.mixedMetaobject(['faq']);
  if (name === 'rating') return field.rating({ scaleMin: 1, scaleMax: 5 });
  if (name === 'measurement') return field.measurement('weight');
  return (field as unknown as Record<string, Factory>)[name]!();
}

// Shopify publishes no list counterpart for these; fixing field.list() requires a breaking
// FieldDefinition type change.
const NOT_LISTABLE = ['boolean', 'id', 'json', 'language', 'money', 'multi_line_text_field', 'rich_text_field'];

test('every builder the table names produces the type it is filed under', () => {
  for (const [type, name] of Object.entries(BUILDERS)) {
    const factory = (field as unknown as Record<string, unknown>)[name];
    assert.equal(typeof factory, 'function', `the table names field.${name}(), which does not exist`);
    assert.equal(sample(name).type, type, `field.${name}() no longer builds ${type}`);
    assert.ok(type in METAFIELD_TYPES, `field.${name}() builds unknown type ${type}`);
  }
  assert.equal(field.measurement('weight').type, 'weight');
});

// The bug this guards: pull reads every type Shopify serves, but can only write the ones a schema
// can declare. A type that is neither declarable nor deliberately declined reaches an operator as
// a definition their pulled schema silently lacks.
test('every Shopify type is either declarable or declined on purpose', () => {
  const unaccounted = [...new Set(Object.keys(METAFIELD_TYPES).map(baseType))]
    .filter((type) => declarability(type) === undefined)
    .sort();
  assert.deepEqual(
    unaccounted,
    [],
    'add a builder for these in src/builders.ts and src/declarable.ts, or decline them in DECLINED with a reason',
  );
});

test('the declined types are ones Shopify still publishes and no builder claims', () => {
  for (const type of Object.keys(DECLINED)) {
    assert.ok(type in METAFIELD_TYPES, `${type} is declined but Shopify no longer publishes it`);
    assert.equal(BUILDERS[type], undefined, `${type} is both declined and built by field.${BUILDERS[type]}()`);
  }
});

test('the builders that cannot be wrapped in field.list() are the ones Shopify has no list type for', () => {
  const missing = Object.keys(BUILDERS)
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
          weight: field.decimal({ min: 0, maxPrecision: 2 }),
          spec: field.json({ schema: { type: 'object' } }),
          price: field.money(),
          stars: field.rating({ scaleMin: 1, scaleMax: 5 }),
          launch: field.date({ min: '2020-01-01' }),
          seen_at: field.dateTime({ max: '2030-01-01T00:00:00Z' }),
          shade: field.color(),
          shipping_weight: field.measurement('weight', { min: { value: 1, unit: 'kg' } }),
          external_id: field.id({ regex: '^[0-9]+$' }),
          manual: field.link(),
          locale: field.language(),
          region: field.jurisdiction(),
          related: field.list(field.product(), { min: 1, max: 3 }),
          sizes: field.list(field.string({ max: 8 })),
          author: field.article(),
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
