import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  compileMigration,
  compileSchema,
  defineMigration,
  defineSchema,
  exitCodeForPlan,
  field,
  metaobject,
  planSchema,
  transforms,
} from '../dist/index.js';
import { generateSchemaModule } from '../dist/generator.js';
import { loadSchema } from '../dist/loader.js';

const execFileAsync = promisify(execFile);

function schema() {
  return defineSchema({
    metaobjects: {
      faq: metaobject({
        name: 'FAQ',
        displayNameKey: 'question',
        access: { storefront: 'public_read' },
        fields: {
          question: field.string({ name: 'Question', required: true, max: 100 }),
          answer: field.richText({ name: 'Answer' }),
        },
      }),
    },
    metafields: {
      product: {
        custom: {
          promo_text: field.string({ name: 'Promo text', adminFilterable: true }),
          faq_ref: field.metaobject('faq', { name: 'FAQ' }),
        },
      },
    },
  });
}

test('compiles builders to stable Shopify identities and validations', () => {
  const compiled = compileSchema(schema());
  assert.deepEqual(compiled.metaobjects.map((item) => item.type), ['faq']);
  assert.equal(compiled.metafields[0].key, 'faq_ref');
  assert.deepEqual(compiled.metafields[0].validations, [
    { name: 'metaobject_definition_type', value: 'faq' },
  ]);
  assert.equal(compiled.metafields[1].capabilities?.adminFilterable, true);
});

test('orders referenced metaobjects first and emits list validations once', () => {
  const compiled = compileSchema(defineSchema({
    metaobjects: {
      article_card: metaobject({
        name: 'Article card',
        fields: { author: field.metaobject('author') },
      }),
      author: metaobject({ name: 'Author', fields: { name: field.string() } }),
    },
    metafields: {
      product: { custom: { related: field.list(field.product(), { min: 1, max: 3 }) } },
    },
  }));
  assert.deepEqual(compiled.metaobjects.map((item) => item.type), ['author', 'article_card']);
  assert.deepEqual(compiled.metafields[0].validations, [
    { name: 'list.min', value: '1' },
    { name: 'list.max', value: '3' },
  ]);
});

test('runtime validation rejects reserved namespaces and undeclared references', () => {
  assert.throws(() => compileSchema(defineSchema({
    metaobjects: {},
    metafields: { product: { 'app--owned': { key: field.string() } } },
  })), /reserved namespace/);
  const invalid = defineSchema({
    metaobjects: {},
    metafields: { product: { custom: { key: field.metaobject('missing') as never } } },
  });
  assert.throws(() => compileSchema(invalid), /undeclared metaobject/);
});

test('planner creates missing definitions and detects operational and cosmetic drift', () => {
  const desired = compileSchema(schema());
  const absent = planSchema(desired, { metaobjects: [], metafields: [] });
  assert.equal(absent.creates, 3);
  assert.equal(exitCodeForPlan(absent, 'dry-run'), 0);
  assert.equal(exitCodeForPlan(absent, 'check'), 1);

  const existing = {
    metaobjects: [{
      type: 'faq', name: 'Renamed', displayNameKey: 'question',
      access: { storefront: 'PUBLIC_READ' }, capabilities: {},
      fields: [
        { key: 'question', name: 'Question', type: 'single_line_text_field', required: true, validations: [{ name: 'max', value: '100' }] },
        { key: 'answer', name: 'Answer', type: 'rich_text_field', required: false, validations: [] },
      ],
    }],
    metafields: desired.metafields.map((item) => ({
      ...item,
      type: item.key === 'promo_text' ? 'url' : item.type,
      validationStatus: 'ALL_VALID' as const,
      invalidCount: 0,
    })),
  };
  const drift = planSchema(desired, existing);
  assert.equal(drift.conflicts, 1);
  assert.equal(drift.notices, 1);
  assert.match(drift.items.find((item) => item.identity.includes('promo_text'))?.reasons[0] ?? '', /expected single_line_text_field, found url/);
});

test('planner treats stored-value validation states as conflict and indeterminate', () => {
  const desired = compileSchema(defineSchema({
    metaobjects: {},
    metafields: { product: { custom: { key: field.string() } } },
  }));
  const base = { ...desired.metafields[0], validations: [], type: 'single_line_text_field' };
  const invalid = planSchema(desired, { metaobjects: [], metafields: [{ ...base, validationStatus: 'SOME_INVALID', invalidCount: 2 }] });
  assert.equal(invalid.conflicts, 1);
  const pending = planSchema(desired, { metaobjects: [], metafields: [{ ...base, validationStatus: 'IN_PROGRESS' }] });
  assert.equal(pending.indeterminate, 1);
  assert.equal(exitCodeForPlan(pending, 'check'), 2);
});

test('loads a TypeScript schema module with Node type stripping', async () => {
  const loaded = await loadSchema('./test/fixture-schema.ts');
  assert.equal(loaded.metaobjects[0].type, 'faq');
});

test('generated pull output is deterministic and uses json unknown', () => {
  const output = generateSchemaModule({
    excluded: [],
    metaobjects: [],
    metafields: [{
      owner: 'product', ownerType: 'PRODUCT', namespace: 'custom', key: 'payload', name: 'Payload',
      type: 'json', validations: [], validationStatus: 'ALL_VALID', invalidCount: 0,
    }],
  });
  assert.match(output, /payload: field\.json<unknown>\(\{ name: "Payload" \}\)/);
});

test('migration artifacts are copy-only and checksum protected', () => {
  const expanded = defineSchema({
    metaobjects: {},
    metafields: { product: { custom: { old_url: field.string(), new_url: field.url() } } },
  });
  const compiled = compileMigration(defineMigration({
    id: 'product-url-v1',
    from: expanded.metafields.product.custom.old_url,
    to: expanded.metafields.product.custom.new_url,
    mode: 'copy',
    transform: transforms.url({ allowedSchemes: ['http', 'https'], bareHost: 'reject', trim: true }),
    onInvalid: 'fail',
    onTargetConflict: 'fail',
  }));
  assert.equal(compiled.source.key, 'old_url');
  assert.equal(compiled.target.type, 'url');
  assert.match(compiled.checksum, /^[a-f0-9]{64}$/);
});

test('CLI validates without store credentials and emits one JSON result', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    './dist/cli.js', './test/fixture-schema.ts', '--validate', '--json',
  ]);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { status: 'valid', metaobjects: 1, metafields: 1 });
});
