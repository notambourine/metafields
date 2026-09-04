import assert from 'node:assert/strict';
import test from 'node:test';
import { METAFIELD_OWNER_TYPES, METAFIELD_TYPES, compileSchema, defineSchema, field, metaobject } from '../dist/index.js';
import {
  baseType,
  BUILDERS,
  DECLINED,
  DECLINED_VALIDATIONS,
  REFERENCE_VALIDATIONS,
  VALIDATION_OPTIONS,
  declarability,
} from '../dist/declarable.js';
import { OWNER_TYPES } from '../dist/schema.js';

type Factory = (...args: never[]) => { type: string };

function sample(name: string): { type: string } {
  if (name === 'metaobject') return field.metaobject('faq');
  if (name === 'mixedMetaobject') return field.mixedMetaobject(['faq']);
  if (name === 'rating') return field.rating({ scaleMin: 1, scaleMax: 5 });
  if (name === 'measurement') return field.measurement('weight');
  return (field as unknown as Record<string, Factory>)[name]!();
}

const NOT_LISTABLE = ['boolean', 'id', 'json', 'language', 'money', 'multi_line_text_field', 'rich_text_field'];

test('registered builders produce their assigned types', () => {
  for (const [type, name] of Object.entries(BUILDERS)) {
    const factory = (field as unknown as Record<string, unknown>)[name];
    assert.equal(typeof factory, 'function', `missing builder: field.${name}()`);
    assert.equal(sample(name).type, type, `field.${name}() must build ${type}`);
    assert.ok(type in METAFIELD_TYPES, `field.${name}() builds unknown type ${type}`);
  }
  assert.equal(field.measurement('weight').type, 'weight');
});

test('every Shopify type is supported or explicitly omitted', () => {
  const unaccounted = [...new Set(Object.keys(METAFIELD_TYPES).map(baseType))]
    .filter((type) => declarability(type) === undefined)
    .sort();
  assert.deepEqual(
    unaccounted,
    [],
    'add a builder for these in src/builders.ts and src/declarable.ts, or decline them in DECLINED with a reason',
  );
});

test('every validation is supported or explicitly omitted', () => {
  const carriers = new Map<string, string[]>();
  for (const [type, info] of Object.entries(METAFIELD_TYPES)) {
    const declares = declarability(type);
    if (!declares || 'declined' in declares) continue;
    for (const validation of info.validations.map(baseType)) {
      if (validation in VALIDATION_OPTIONS || REFERENCE_VALIDATIONS.has(validation)) continue;
      if (validation in DECLINED_VALIDATIONS) continue;
      carriers.set(validation, [...carriers.get(validation) ?? [], type]);
    }
  }
  assert.deepEqual(
    [...carriers].map(([validation, types]) => `${validation} (on ${types.join(', ')})`).sort(),
    [],
    'add an option for these in src/builders.ts and VALIDATION_OPTIONS, or decline them in DECLINED_VALIDATIONS with a reason',
  );
  for (const validation of Object.keys(DECLINED_VALIDATIONS)) {
    const published = Object.values(METAFIELD_TYPES)
      .some((info) => info.validations.map(baseType).includes(validation));
    assert.ok(published, `${validation} is omitted but absent from Shopify`);
    assert.equal(VALIDATION_OPTIONS[validation], undefined, `${validation} is both declined and an option`);
  }
});

test('omitted types exist in Shopify and have no builders', () => {
  for (const type of Object.keys(DECLINED)) {
    assert.ok(type in METAFIELD_TYPES, `${type} is omitted but absent from Shopify`);
    assert.equal(BUILDERS[type], undefined, `${type} is both declined and built by field.${BUILDERS[type]}()`);
  }
});

test('list builders exist only for Shopify list types', () => {
  const missing = Object.keys(BUILDERS)
    .filter((type) => !(`list.${type}` in METAFIELD_TYPES))
    .sort();
  assert.deepEqual(missing, NOT_LISTABLE);
});

test('declared owners are a subset of the MetafieldOwnerType enum', () => {
  for (const [handle, ownerType] of Object.entries(OWNER_TYPES)) {
    assert.ok(
      (METAFIELD_OWNER_TYPES as readonly string[]).includes(ownerType),
      `owner ${handle} maps to missing enum value ${ownerType}`,
    );
  }
});

test('builders emit only supported validations', () => {
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
          manual: field.link({ allowedDomains: ['example.com'] }),
          site: field.url({ allowedDomains: ['example.com'] }),
          sheet: field.file({ fileTypes: ['Image'] }),
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
