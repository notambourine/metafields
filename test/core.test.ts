import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  AdminClient,
  compileMigration,
  compileSchema,
  defineMigration,
  defineSchema,
  emitLiquidMetafields,
  exitCodeForPlan,
  field,
  metaobject,
  planSchema,
  transforms,
} from '../dist/index.js';
import { generateSchemaModule } from '../dist/generator.js';
import { pullSchema } from '../dist/pull.js';
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
  assert.equal(exitCodeForPlan(absent), 1);

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
  assert.equal(exitCodeForPlan(pending), 2);
});

function pulled(fields: Record<string, unknown>[], metaobjects: Record<string, unknown>[] = []) {
  return {
    excluded: [],
    metaobjects: metaobjects as never,
    metafields: fields.map((raw) => ({
      owner: 'product', ownerType: 'PRODUCT', namespace: 'custom', name: 'Field',
      validations: [], validationStatus: 'ALL_VALID' as const, invalidCount: 0, ...raw,
    })) as never,
  };
}

// Pull is only as good as what it writes: a module that cannot be compiled is the same failure as
// the abort it replaced, one file later.
test('what pull writes compiles, including the types the DSL learned to declare', async () => {
  const { module } = generateSchemaModule(pulled(
    [
      { key: 'price', name: 'Price', type: 'money', access: { admin: 'MERCHANT_READ_WRITE' } },
      { key: 'sizes', type: 'list.single_line_text_field', validations: [
        { name: 'list.max', value: '5' }, { name: 'choices', value: '["S","M"]' },
      ] },
      { key: 'span', type: 'dimension', validations: [{ name: 'max', value: '{"value":2.5,"unit":"in"}' }] },
      { key: 'stars', type: 'rating', required: true, validations: [
        { name: 'scale_min', value: '1' }, { name: 'scale_max', value: '5' },
      ] },
      { key: 'faq_ref', type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_type', value: 'faq' }] },
    ],
    [{ type: 'faq', name: 'FAQ', displayNameKey: 'question', fields: [
      { key: 'question', name: 'Question', type: { name: 'single_line_text_field' }, required: true, validations: [] },
      { key: 'asked_on', name: 'Asked on', type: { name: 'date' }, validations: [{ name: 'min', value: '2020-01-01' }] },
    ] }],
  ));
  const directory = await mkdtemp(join(tmpdir(), 'metafields-pull-'));
  const target = join(directory, 'schema.ts');
  await writeFile(target, module.replace(
    "'@notambourine/metafields'",
    JSON.stringify(new URL('../dist/index.js', import.meta.url).href),
  ));
  const compiled = await loadSchema(target);
  assert.deepEqual(compiled.metafields.map((item) => item.type).sort(), [
    'dimension', 'list.single_line_text_field', 'metaobject_reference', 'money', 'rating',
  ]);
  assert.deepEqual(compiled.metafields.find((item) => item.key === 'stars')?.validations, [
    { name: 'scale_min', value: '1' }, { name: 'scale_max', value: '5' },
  ]);
  assert.deepEqual(compiled.metafields.find((item) => item.key === 'span')?.validations, [
    { name: 'max', value: '{"value":2.5,"unit":"in"}' },
  ]);
  assert.equal(compiled.metaobjects[0].displayNameKey, 'question');
});

test('loads a TypeScript schema module with Node type stripping', async () => {
  const loaded = await loadSchema('./test/fixture-schema.ts');
  assert.equal(loaded.metaobjects[0].type, 'faq');
});

test('generated pull output is deterministic and uses json unknown', () => {
  const { module, skipped } = generateSchemaModule(pulled([
    { key: 'payload', name: 'Payload', type: 'json' },
    { key: 'price', name: 'Price', type: 'money' },
    { key: 'shipping', name: 'Shipping', type: 'weight', validations: [{ name: 'min', value: '{"value":1.0,"unit":"kg"}' }] },
    { key: 'stars', type: 'rating', validations: [{ name: 'scale_min', value: '1' }, { name: 'scale_max', value: '5' }] },
  ]));
  assert.deepEqual(skipped, []);
  assert.match(module, /payload: field\.json<unknown>\(\{ name: "Payload" \}\)/);
  assert.match(module, /price: field\.money\(\{ name: "Price" \}\)/);
  assert.match(module, /shipping: field\.measurement\("weight", \{ name: "Shipping", min: \{"value":1.0,"unit":"kg"\} \}\)/);
  assert.match(module, /stars: field\.rating\(\{ name: "Field", scaleMin: 1, scaleMax: 5 \}\)/);
});

// The catch-22 this replaces: one undeclarable type aborted the read, and the only way around it
// aborted the read the other way.
test('pull writes what it can declare and reports the rest as skipped', () => {
  const { module, skipped } = generateSchemaModule(pulled([
    { key: 'promo_text', name: 'Promo text', type: 'single_line_text_field' },
    { key: 'catalog', type: 'product_taxonomy_value_reference' },
    { key: 'sheet', type: 'file_reference', validations: [{ name: 'file_type_options', value: '["Image"]' }] },
    // Nothing named the metaobject, because this pull did not ask for metaobjects.
    { key: 'faq_ref', type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_type', value: 'faq' }] },
  ]));
  assert.match(module, /promo_text: field\.string\(\{ name: "Promo text" \}\)/);
  assert.deepEqual(skipped.map((entry) => entry.identity), [
    'product:custom.catalog', 'product:custom.faq_ref', 'product:custom.sheet',
  ]);
  assert.match(skipped[0].reason, /cannot declare product_taxonomy_value_reference/);
  assert.match(skipped[1].reason, /references faq, which this pull did not write/);
  // A definition quieter than the store is not a schema anyone can apply, so the validation the
  // DSL cannot state takes the field with it.
  assert.match(skipped[2].reason, /no option declares the file_type_options validation/);
  assert.match(module, /^\/\/ Pulled without 3 definition\(s\) this release cannot declare:\n/);
});

test('a metaobject left with no declarable field is dropped, and so is what referenced it', () => {
  const { module, skipped } = generateSchemaModule(pulled(
    [
      { key: 'faq_ref', type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_type', value: 'faq' }] },
      { key: 'card_ref', type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_type', value: 'card' }] },
    ],
    [
      { type: 'faq', name: 'FAQ', displayNameKey: 'legal', fields: [
        { key: 'legal', name: 'Legal', type: { name: 'disclosure_reference' }, validations: [] },
        { key: 'answer', name: 'Answer', type: { name: 'rich_text_field' }, validations: [] },
      ] },
      { type: 'card', name: 'Card', fields: [
        { key: 'faq', name: 'FAQ', type: { name: 'metaobject_reference' }, validations: [{ name: 'metaobject_definition_type', value: 'gone' }] },
      ] },
    ],
  ));
  assert.deepEqual(skipped.map((entry) => entry.identity), [
    'metaobject:card', 'metaobject:faq.legal', 'product:custom.card_ref',
  ]);
  assert.match(module, /answer: field\.richText\(\{ name: "Answer" \}\)/);
  // Options follow the referenced type instead of being dropped for want of an empty pair of parens.
  assert.match(module, /faq_ref: field\.metaobject\("faq", \{ name: "Field" \}\)/);
  // The display key named the field this file could not declare, so keeping it would not compile.
  assert.doesNotMatch(module, /displayNameKey/);
});

// The reported repro: a live store whose metaobject fields are money-typed. 0.2.0 aborted with
// --metaobjects on the type and aborted without it on the reference, leaving no way to read it.
test('pull reads a store with a money-typed metaobject field, in either direction', async () => {
  const definitions = {
    metafieldDefinitions: {
      nodes: [{
        id: 'gid://shopify/MetafieldDefinition/1', namespace: 'custom', key: 'chain', name: 'Chain',
        ownerType: 'PRODUCT', type: { name: 'metaobject_reference' },
        validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/9' }],
        access: { admin: null, storefront: 'PUBLIC_READ', customerAccount: null },
        capabilities: {
          adminFilterable: { enabled: false }, analyticsQueryable: { enabled: false },
          cartToOrderCopyable: { enabled: false }, smartCollectionCondition: { enabled: false },
          uniqueValues: { enabled: false },
        },
        constraints: null, validationStatus: 'ALL_VALID', invalidCount: 0,
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    metaobjectDefinitions: {
      nodes: [{
        id: 'gid://shopify/MetaobjectDefinition/9', type: 'chain_length', name: 'Chain length',
        description: null, displayNameKey: 'label',
        access: { admin: null, storefront: 'PUBLIC_READ' },
        capabilities: { publishable: { enabled: false }, translatable: { enabled: false } },
        fieldDefinitions: [
          { key: 'label', name: 'Label', type: { name: 'single_line_text_field' }, required: true, validations: [] },
          { key: 'price', name: 'Price', type: { name: 'money' }, required: false, validations: [] },
        ],
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  const client = new AdminClient({
    store: 'example.myshopify.com',
    token: 'shpat_x',
    fetch: async (_input, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      return new Response(JSON.stringify({
        data: query.includes('PullMetaobjectDefinitions')
          ? { metaobjectDefinitions: definitions.metaobjectDefinitions }
          : { metafieldDefinitions: definitions.metafieldDefinitions },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const options = { owners: ['product' as const], namespaces: ['custom'], allNamespaces: false };

  const full = generateSchemaModule(await pullSchema(client, { ...options, metaobjects: true }));
  assert.deepEqual(full.skipped, []);
  assert.match(full.module, /price: field\.money\(\{ name: "Price" \}\)/);
  assert.match(full.module, /chain: field\.metaobject\("chain_length", \{ name: "Chain", access: \{ storefront: "public_read" \}/);

  // Without --metaobjects the reference has nothing to name, so the definition carries the advice
  // that used to be an abort.
  const partial = generateSchemaModule(await pullSchema(client, { ...options, metaobjects: false }));
  assert.deepEqual(partial.skipped, [{
    identity: 'product:custom.chain',
    reason: 'metaobject_reference names a definition id this store owns; rerun pull with --metaobjects to resolve it',
  }]);
  assert.match(partial.module, /export default defineSchema\(\{/);
});

test('liquid emit maps owner handles and drops owners the language server cannot group', () => {
  const { definitions, skipped } = emitLiquidMetafields(compileSchema(defineSchema({
    metaobjects: {},
    metafields: {
      product: { custom: { promo_text: field.string({ name: 'Promo text' }), prices: field.list(field.decimal()) } },
      product_variant: { custom: { swatch: field.file() } },
      customer: { custom: { tier: field.string() } },
    },
  })));
  assert.deepEqual(Object.keys(definitions).sort(), ['product', 'variant']);
  assert.deepEqual(definitions.product.map((item) => item.key), ['prices', 'promo_text']);
  assert.deepEqual(definitions.product[0], {
    key: 'prices', name: 'Prices', namespace: 'custom', description: '',
    type: { category: 'NUMBER', name: 'list.number_decimal' },
  });
  assert.deepEqual(definitions.product[1].type, { category: 'TEXT', name: 'single_line_text_field' });
  assert.equal(definitions.variant[0].type.name, 'file_reference');
  assert.deepEqual(skipped, ['customer:custom.tier']);
});

test('CLI emit writes a metafields file and refuses to clobber unrelated content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'metafields-emit-'));
  const target = join(directory, '.shopify', 'metafields.json');
  const run = (...extra: string[]) => execFileAsync(process.execPath, [
    './dist/cli.js', 'emit', './test/fixture-schema.ts', '--liquid', '--out', target, ...extra,
  ]);
  await run();
  const written = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown[]>;
  assert.equal((written.product[0] as { key: string }).key, 'faq_ref');
  await run();
  await writeFile(target, 'theme source, not generated\n');
  await assert.rejects(run(), /is not a generated metafields file/);
  // --force overrides the tool's own judgment here too, and needs no --apply to do it.
  await run('--force');
  assert.match(await readFile(target, 'utf8'), /faq_ref/);
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

test('CLI compile answers with one JSON object and refuses to clobber --out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'metafields-compile-'));
  const run = (...extra: string[]) => execFileAsync(process.execPath, [
    './dist/cli.js', 'compile', './test/fixture-schema.ts', ...extra,
  ]);
  const format = '@notambourine/metafields/schema-v1';

  const streamed = await run('--json');
  assert.equal(streamed.stderr, '');
  assert.equal((JSON.parse(streamed.stdout) as { compiled: { format: string } }).compiled.format, format);

  const target = join(directory, 'compiled.json');
  const written = await run('--out', target, '--json');
  assert.deepEqual(JSON.parse(written.stdout), { status: 'written', out: target });
  assert.equal((JSON.parse(await readFile(target, 'utf8')) as { format: string }).format, format);

  const plain = join(directory, 'plain.json');
  assert.equal((await run('--out', plain)).stdout, `WROTE ${plain}\n`);
  await assert.rejects(run('--out', plain), /EEXIST/);
});

test('CLI emit puts left-out identities in the object under --json and on stderr without it', async () => {
  const run = (...extra: string[]) => execFileAsync(process.execPath, [
    './dist/cli.js', 'emit', './test/fixture-skipped.ts', '--liquid', ...extra,
  ]);

  const { stdout, stderr } = await run('--json');
  assert.equal(stderr, '');
  const envelope = JSON.parse(stdout) as { definitions: Record<string, { key: string }[]>; skipped: string[] };
  assert.deepEqual(envelope.skipped, ['customer:custom.tier']);
  assert.equal(envelope.definitions.product?.[0]?.key, 'blurb');

  // Without --json the same identities leave stdout holding only the document.
  const streamed = await run();
  assert.equal(streamed.stderr, 'SKIPPED customer:custom.tier\n');
  assert.deepEqual(Object.keys(JSON.parse(streamed.stdout) as object), ['product']);
});

test('CLI reports the package version', async () => {
  const packageJson = JSON.parse(await readFile('./package.json', 'utf8')) as { version: string };
  const { stdout, stderr } = await execFileAsync(process.execPath, ['./dist/cli.js', '--version']);
  assert.equal(stderr, '');
  assert.equal(stdout, `${packageJson.version}\n`);
});
