import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  AdminClient,
  blockedAdvice,
  classifyDrift,
  compileSchema,
  defineSchema,
  exitCodeForPlan,
  field,
  fleetExitCode,
  metaobject,
  planSchema,
  synchronizeFleet,
  type CompiledSchema,
  type Connect,
  type ExistingSchema,
} from '../dist/index.js';

function schema(): CompiledSchema {
  return compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({
        name: 'FAQ',
        displayNameKey: 'question',
        fields: {
          question: field.string({ name: 'Question', required: true }),
          answer: field.richText({ name: 'Answer' }),
        },
      }),
    },
    metafields: {
      product: {
        custom: { promo_text: field.string({ name: 'Promo text', adminFilterable: true }) },
      },
    },
  }));
}

function restricted(): CompiledSchema {
  return compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({
        name: 'FAQ',
        displayNameKey: 'question',
        fields: {
          question: field.string({ name: 'Question', required: true }),
          answer: field.richText({ name: 'Answer' }),
        },
      }),
    },
    metafields: {
      product: {
        custom: {
          promo_text: field.string({
            name: 'Promo text', adminFilterable: true, access: { storefront: 'none' },
          }),
        },
      },
    },
  }));
}

function drifted(): ExistingSchema {
  return {
    metaobjects: [{
      id: 'gid://shopify/MetaobjectDefinition/1', type: 'faq', name: 'FAQ', displayNameKey: 'question',
      access: {}, capabilities: {},
      fields: [{ key: 'question', name: 'Question', type: 'single_line_text_field', required: true, validations: [] }],
    }],
    metafields: [{
      id: 'gid://shopify/MetafieldDefinition/2', ownerType: 'PRODUCT', namespace: 'custom', key: 'promo_text',
      name: 'Promo text', type: 'single_line_text_field', validations: [],
      access: { storefront: 'PUBLIC_READ' },
      capabilities: { adminFilterable: false }, validationStatus: 'ALL_VALID', invalidCount: 0,
    }],
  };
}

function store(existing: ExistingSchema, sent: string[] = []) {
  const state = existing;
  return {
    sent,
    client: {
      async readSchema() { return state; },
      async updateMetaobject(entry: { item: { identity: string } }) {
        sent.push(entry.item.identity);
        const faq = state.metaobjects[0];
        if (faq) faq.fields.push({ key: 'answer', name: 'Answer', type: 'rich_text_field', validations: [] });
      },
      async updateMetafield(entry: { item: { identity: string } }, force: boolean) {
        sent.push(entry.item.identity);
        const promo = state.metafields[0];
        if (promo) {
          promo.capabilities = { adminFilterable: true };
          if (force) promo.access = { storefront: 'NONE' };
        }
      },
      async createMetaobject() { throw new Error('unexpected create'); },
      async createMetafield() { throw new Error('unexpected create'); },
    },
  };
}

const targets = [{ store: 'a.myshopify.com', explicit: true }];
const connectTo = (client: unknown) => (async () => client) as unknown as Connect;

test('enabling a metaobject field capability is safe; disabling requires force', () => {
  const desired = (adminFilterable: boolean) => compileSchema(defineSchema({
    metaobjects: { faq: metaobject({ name: 'FAQ', fields: { question: field.string({ adminFilterable }) } }) },
    metafields: {},
  }));
  const stored = (adminFilterable: boolean): ExistingSchema => ({
    metaobjects: [{
      id: 'gid://shopify/MetaobjectDefinition/1', type: 'faq', name: 'FAQ',
      fields: [{
        key: 'question', name: 'Question', type: 'single_line_text_field',
        validations: [], capabilities: { adminFilterable },
      }],
    }],
    metafields: [],
  });
  const enabling = classifyDrift(planSchema(desired(true), stored(false))).items[0];
  assert.deepEqual(enabling?.applies, ['fields.question.capabilities.adminFilterable: expected true, found false']);
  assert.deepEqual(enabling?.needsForce, []);
  const disabling = classifyDrift(planSchema(desired(false), stored(true))).items[0];
  assert.deepEqual(disabling?.applies, []);
  assert.deepEqual(disabling?.needsForce, ['fields.question.capabilities.adminFilterable: expected false, found true']);
});

test('classifyDrift separates applicable, forced, and blocked drift', () => {
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) {
    promo.type = 'url';
    promo.validationStatus = 'SOME_INVALID';
    promo.invalidCount = 3;
  }
  const drift = classifyDrift(planSchema(restricted(), existing));
  const faq = drift.items.find((entry) => entry.item.kind === 'metaobject');
  assert.deepEqual(faq?.applies, ['fields.answer: missing']);
  assert.deepEqual(faq?.needsForce, []);
  const metafield = drift.items.find((entry) => entry.item.kind === 'metafield');
  assert.deepEqual(metafield?.applies, ['capabilities.adminFilterable: expected true, found false']
    .map((reason) => `metafield:PRODUCT:custom.promo_text.${reason}`));
  assert.deepEqual(metafield?.needsForce.map((reason) => reason.split(': ')[0]), [
    'metafield:PRODUCT:custom.promo_text.access.storefront',
  ]);
  assert.deepEqual(metafield?.blocked.map((reason) => reason.includes('url') ? 'type' : 'values'), [
    'type', 'values',
  ]);
  assert.deepEqual([drift.applies, drift.needsForce, drift.blocked], [1, 0, 1]);
});

test('IN_PROGRESS validation blocks all writes', () => {
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) promo.validationStatus = 'IN_PROGRESS';
  const drift = classifyDrift(planSchema(schema(), existing));
  const metafield = drift.items.find((entry) => entry.item.kind === 'metafield');
  assert.deepEqual([metafield?.applies, metafield?.needsForce], [[], []]);
  assert.match(metafield?.blocked.join() ?? '', /validation is in progress/);
});

test('force-required drift defers its entire definition', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, restricted(), 'apply', connectTo(fake.client),
  );
  assert.deepEqual(fake.sent, ['metaobject:faq']);
  assert.deepEqual(result.stores[0]?.updated, ['metaobject:faq']);
  assert.deepEqual(result.stores[0]?.skipped, ['metafield:PRODUCT:custom.promo_text']);
  assert.equal(fleetExitCode(result), 1);
});

test('--force applies all deferred drift', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, restricted(), 'apply', connectTo(fake.client), { force: true },
  );
  assert.deepEqual(fake.sent, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.deepEqual(result.stores[0]?.skipped, []);
  assert.equal(fleetExitCode(result), 0);
});

test('--apply updates metaobjects before metafields and then verifies', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(targets, schema(), 'apply', connectTo(fake.client));
  assert.deepEqual(fake.sent, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.deepEqual(result.stores[0]?.updated, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.equal(fleetExitCode(result), 0);
});

test('--dry-run skips writes and reports remaining drift', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, restricted(), 'dry-run', connectTo(fake.client), { force: true },
  );
  assert.deepEqual(fake.sent, []);
  assert.equal(result.stores[0]?.updated, undefined);
  assert.equal(fleetExitCode(result), 1);
});

test('force-required drift does not block other fleet stores', async () => {
  const permitted = drifted();
  const promo = permitted.metafields[0];
  if (promo) promo.access = { storefront: 'NONE' };
  const clean = store(permitted);
  const needsForce = store(drifted(), clean.sent);
  const connect = (async (name: string) =>
    name === 'a.myshopify.com' ? clean.client : needsForce.client) as unknown as Connect;
  const result = await synchronizeFleet(
    [{ store: 'a.myshopify.com', explicit: true }, { store: 'b.myshopify.com', explicit: true }],
    restricted(), 'apply', connect,
  );
  assert.deepEqual(clean.sent, [
    'metaobject:faq', 'metafield:PRODUCT:custom.promo_text', 'metaobject:faq',
  ]);
  assert.deepEqual(result.stores.map((outcome) => outcome.skipped), [
    [], ['metafield:PRODUCT:custom.promo_text'],
  ]);
  assert.equal(fleetExitCode(result), 1);
});

test('updates add fields without deleting or retyping fields', async () => {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return Response.json({ data: { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: '1' }, userErrors: [] } } });
    },
  });
  const entry = classifyDrift(planSchema(schema(), drifted())).items
    .find((item) => item.item.kind === 'metaobject');
  await client.updateMetaobject(entry!);
  const definition = sent[0]?.variables.definition as { fieldDefinitions: Record<string, unknown>[] };
  assert.equal(sent[0]?.variables.id, 'gid://shopify/MetaobjectDefinition/1');
  assert.deepEqual(definition.fieldDefinitions, [
    { create: { key: 'answer', type: 'rich_text_field', name: 'Answer' } },
  ]);
  assert.equal(JSON.stringify(sent).includes('"delete"'), false);
  assert.match(sent[0]?.query ?? '', /metaobjectDefinitionUpdate/);
});

test('metafield updates diff constraint values', async () => {
  const constrained = compileSchema(defineSchema({
    metaobjects: {},
    metafields: {
      product: {
        custom: {
          promo_text: field.string({ name: 'Promo text', constraints: { key: 'type', values: ['shirt', 'hat'] } }),
        },
      },
    },
  }));
  let variables: Record<string, unknown> = {};
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
      return Response.json({ data: { metafieldDefinitionUpdate: { updatedDefinition: { id: '2' }, userErrors: [] } } });
    },
  });
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) {
    promo.access = {};
    promo.constraints = { key: 'type', values: ['shirt', 'mug'] };
  }
  const entry = classifyDrift(planSchema(constrained, existing)).items[0];
  await client.updateMetafield(entry!, true);
  const definition = variables.definition as Record<string, unknown>;
  assert.deepEqual(definition.constraintsUpdates, {
    key: 'type', values: [{ create: 'hat' }, { delete: 'mug' }],
  });
  assert.equal('type' in definition, false);
});

function relabelled(): ExistingSchema {
  const existing = drifted();
  const faq = existing.metaobjects[0];
  if (faq) {
    faq.name = 'Frequently asked';
    faq.fields.push({ key: 'answer', name: 'Answer', type: 'rich_text_field', validations: [] });
  }
  const promo = existing.metafields[0];
  if (promo) {
    promo.name = 'Promotional text';
    promo.access = {};
    promo.capabilities = { adminFilterable: true };
  }
  return existing;
}

test('cosmetic drift applies by default and leaves the plan PRESENT', () => {
  const plan = planSchema(schema(), relabelled());
  assert.deepEqual(plan.items.map((item) => item.status), ['PRESENT', 'PRESENT']);
  assert.equal(exitCodeForPlan(plan), 0);
  const drift = classifyDrift(plan);
  assert.deepEqual(drift.items.map((entry) => entry.applies), [
    ['metaobject:faq.name differs'], ['metafield:PRODUCT:custom.promo_text.name differs'],
  ]);
  assert.equal(drift.applies, 2);
});

test('validation in progress blocks label updates', () => {
  const existing = relabelled();
  const promo = existing.metafields[0];
  if (promo) promo.validationStatus = 'IN_PROGRESS';
  const drift = classifyDrift(planSchema(schema(), existing));
  const metafield = drift.items.find((entry) => entry.item.kind === 'metafield');
  assert.deepEqual(metafield?.applies, []);
  assert.equal(metafield?.blocked.length, 2);
});

test('definition relabels send only the drifted name', async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      sent.push((JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables);
      return Response.json({
        data: {
          metaobjectDefinitionUpdate: { metaobjectDefinition: { id: '1' }, userErrors: [] },
          metafieldDefinitionUpdate: { updatedDefinition: { id: '2' }, userErrors: [] },
        },
      });
    },
  });
  const drift = classifyDrift(planSchema(schema(), relabelled()));
  await client.updateMetaobject(drift.items[0]!);
  await client.updateMetafield(drift.items[1]!);
  assert.deepEqual(sent[0]?.definition, { name: 'FAQ' });
  assert.deepEqual(sent[1]?.definition, {
    ownerType: 'PRODUCT', namespace: 'custom', key: 'promo_text', name: 'Promo text',
  });
});

function described(): CompiledSchema {
  return compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({
        name: 'FAQ',
        displayNameKey: 'question',
        fields: {
          question: field.string({ name: 'Question', description: 'Shown on the card', required: true }),
          answer: field.richText({ name: 'Answer' }),
        },
      }),
    },
    metafields: {
      product: {
        custom: { promo_text: field.string({ name: 'Promo text', adminFilterable: true }) },
      },
    },
  }));
}

function fieldRelabelled(): ExistingSchema {
  const existing = drifted();
  const question = existing.metaobjects[0]?.fields[0];
  if (question) question.description = 'Admin label only';
  existing.metaobjects[0]?.fields.push({
    key: 'answer', name: 'The answer', type: 'rich_text_field', validations: [],
  });
  const promo = existing.metafields[0];
  if (promo) promo.capabilities = { adminFilterable: true };
  return existing;
}

test('field relabels send only the drifted label', async () => {
  const plan = planSchema(described(), fieldRelabelled());
  assert.deepEqual(plan.items.map((item) => item.status), ['PRESENT', 'PRESENT']);
  assert.equal(exitCodeForPlan(plan), 0);
  const drift = classifyDrift(plan);
  assert.deepEqual(drift.items.map((entry) => entry.applies), [
    ['fields.answer.name differs', 'fields.question.description differs'],
  ]);
  let variables: Record<string, unknown> = {};
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
      return Response.json({ data: { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: '1' }, userErrors: [] } } });
    },
  });
  await client.updateMetaobject(drift.items[0]!);
  assert.deepEqual(variables.definition, {
    fieldDefinitions: [
      { update: { key: 'answer', name: 'Answer' } },
      { update: { key: 'question', description: 'Shown on the card' } },
    ],
  });
});

test('operational updates include drifted labels only', async () => {
  const existing = fieldRelabelled();
  const question = existing.metaobjects[0]?.fields[0];
  if (question) question.required = false;
  const drift = classifyDrift(planSchema(described(), existing));
  assert.deepEqual(drift.items[0]?.needsForce, ['fields.question.required: expected true, found false']);
  let variables: Record<string, unknown> = {};
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
      return Response.json({ data: { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: '1' }, userErrors: [] } } });
    },
  });
  await client.updateMetaobject(drift.items[0]!, true);
  assert.deepEqual(variables.definition, {
    fieldDefinitions: [
      { update: { key: 'answer', name: 'Answer' } },
      { update: { key: 'question', description: 'Shown on the card', required: true } },
    ],
  });
});

test('operational updates omit unchanged names', async () => {
  let variables: Record<string, unknown> = {};
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
      return Response.json({ data: { metafieldDefinitionUpdate: { updatedDefinition: { id: '2' }, userErrors: [] } } });
    },
  });
  const entry = classifyDrift(planSchema(schema(), drifted())).items
    .find((item) => item.item.kind === 'metafield');
  await client.updateMetafield(entry!);
  assert.equal('name' in (variables.definition as Record<string, unknown>), false);
});

test('userErrors reach the operator unchanged', async () => {
  const fake = store(drifted());
  fake.client.updateMetaobject = async () => {
    throw new Error('metaobject:faq: Cannot set required on field answer: 4 entries have no value');
  };
  const result = await synchronizeFleet(targets, schema(), 'apply', connectTo(fake.client));
  assert.match(result.stores[0]?.refused ?? '', /4 entries have no value/);
  assert.equal(fleetExitCode(result), 2);
});

test('blocked definitions explain why --force cannot help', () => {
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) {
    promo.type = 'url';
    promo.validationStatus = 'SOME_INVALID';
    promo.invalidCount = 3;
  }
  const entry = classifyDrift(planSchema(schema(), existing)).items
    .find((item) => item.item.kind === 'metafield');
  const advice = entry!.blocked.map((reason) => blockedAdvice(entry!.item, reason));
  assert.deepEqual(advice, [
    'Retyping definitions with stored values is unsupported. Use a migration.',
    'Invalid stored values block schema updates. Correct the values.',
  ]);
});

const execFileAsync = promisify(execFile);

test('--force requires --apply', async () => {
  const run = (args: string[]) => execFileAsync(process.execPath, ['./dist/cli.js', ...args], {
    env: { ...process.env, SHOPIFY_ADMIN_ACCESS_TOKEN: '', SHOPIFY_APP_CLIENT_ID: '', SHOPIFY_APP_SECRET: '' },
  }).then(() => '', (error: { stderr?: string }) => error.stderr ?? '');
  const base = ['./test/fixture-schema.ts', '--store', 'a.myshopify.com'];
  assert.match(await run([...base, '--force']), /--force requires --apply/);
  assert.match(await run([...base, '--apply', '--force', '--dry-run']), /SHOPIFY_ADMIN_ACCESS_TOKEN/);
});
