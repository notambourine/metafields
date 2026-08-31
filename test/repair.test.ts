import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminClient,
  compileSchema,
  defineSchema,
  field,
  fleetExitCode,
  metaobject,
  planRepair,
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

// A store whose faq is missing the `answer` field and whose promo_text capability is off.
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
      capabilities: { adminFilterable: false }, validationStatus: 'ALL_VALID', invalidCount: 0,
    }],
  };
}

function store(existing: ExistingSchema, sent: unknown[] = []) {
  let state = existing;
  return {
    sent,
    client: {
      async readSchema() { return state; },
      async repairMetaobject(entry: { item: { identity: string } }) {
        sent.push(entry.item.identity);
        const faq = state.metaobjects[0];
        if (faq) {
          faq.fields.push({ key: 'answer', name: 'Answer', type: 'rich_text_field', validations: [] });
        }
      },
      async repairMetafield(entry: { item: { identity: string } }) {
        sent.push(entry.item.identity);
        const promo = state.metafields[0];
        if (promo) promo.capabilities = { adminFilterable: true };
      },
      async createMetaobject() { throw new Error('unexpected create'); },
      async createMetafield() { throw new Error('unexpected create'); },
    },
    reset(next: ExistingSchema) { state = next; },
  };
}

const targets = [{ store: 'a.myshopify.com', explicit: true }];

test('planRepair separates the drift an update resolves from the drift it cannot', () => {
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) {
    promo.type = 'url';
    promo.validationStatus = 'SOME_INVALID';
    promo.invalidCount = 3;
  }
  const repair = planRepair(planSchema(schema(), existing));
  const faq = repair.items.find((entry) => entry.item.kind === 'metaobject');
  assert.deepEqual(faq?.repairs, ['fields.answer: missing']);
  assert.deepEqual(faq?.blockers, []);
  const metafield = repair.items.find((entry) => entry.item.kind === 'metafield');
  assert.deepEqual(metafield?.blockers.map((reason) => reason.includes('url') ? 'type' : 'values'), [
    'type', 'values',
  ]);
  assert.equal(repair.repairable, 1);
  assert.equal(repair.blocked, 1);
});

test('IN_PROGRESS validation is never repaired', () => {
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) promo.validationStatus = 'IN_PROGRESS';
  const repair = planRepair(planSchema(schema(), existing));
  const metafield = repair.items.find((entry) => entry.item.kind === 'metafield');
  assert.equal(metafield?.repairs.length, 0);
  assert.match(metafield?.blockers.join() ?? '', /validation is in progress/);
});

test('--repair without --apply reports what it would change and writes nothing', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, schema(), 'dry-run', (async () => fake.client) as unknown as Connect, { repair: true },
  );
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(result.stores[0]?.repair?.items.map((entry) => entry.item.identity).sort(), [
    'metafield:PRODUCT:custom.promo_text', 'metaobject:faq',
  ]);
  assert.equal(result.stores[0]?.repaired, undefined);
  assert.equal(fleetExitCode(result, 'dry-run'), 1);
});

test('--apply alone never repairs; the flag is the only way a definition is rewritten', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, schema(), 'apply', (async () => fake.client) as unknown as Connect,
  );
  assert.deepEqual(fake.sent, []);
  assert.equal(fleetExitCode(result, 'apply'), 1);
});

test('--repair --apply updates metaobjects before metafields and verifies afterward', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, schema(), 'apply', (async () => fake.client) as unknown as Connect, { repair: true },
  );
  assert.deepEqual(fake.sent, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.deepEqual(result.stores[0]?.repaired, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.equal(fleetExitCode(result, 'apply'), 0);
});

test('an unrepairable store blocks every write in the fleet', async () => {
  const broken = drifted();
  const promo = broken.metafields[0];
  if (promo) promo.type = 'url';
  const first = store(drifted());
  const second = store(broken, first.sent);
  const connect = (async (name: string) =>
    name === 'a.myshopify.com' ? first.client : second.client) as unknown as Connect;
  const result = await synchronizeFleet(
    [{ store: 'a.myshopify.com', explicit: true }, { store: 'b.myshopify.com', explicit: true }],
    schema(), 'apply', connect, { repair: true },
  );
  assert.deepEqual(first.sent, []);
  assert.equal(fleetExitCode(result, 'apply'), 1);
});

test('a repair mutation adds a field and never deletes or retypes one', async () => {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const client = new AdminClient({
    store: 'a.myshopify.com', token: 'shpca_x',
    fetch: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return Response.json({ data: { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: '1' }, userErrors: [] } } });
    },
  });
  const entry = planRepair(planSchema(schema(), drifted())).items
    .find((item) => item.item.kind === 'metaobject');
  await client.repairMetaobject(entry!);
  const definition = sent[0]?.variables.definition as { fieldDefinitions: Record<string, unknown>[] };
  assert.equal(sent[0]?.variables.id, 'gid://shopify/MetaobjectDefinition/1');
  assert.deepEqual(definition.fieldDefinitions, [
    { create: { key: 'answer', type: 'rich_text_field', name: 'Answer' } },
  ]);
  assert.equal(JSON.stringify(sent).includes('"delete"'), false);
  assert.match(sent[0]?.query ?? '', /metaobjectDefinitionUpdate/);
});

test('a metafield repair diffs constraint values instead of replacing them', async () => {
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
  if (promo) promo.constraints = { key: 'type', values: ['shirt', 'mug'] };
  const entry = planRepair(planSchema(constrained, existing)).items[0];
  await client.repairMetafield(entry!);
  const definition = variables.definition as Record<string, unknown>;
  assert.deepEqual(definition.constraintsUpdates, {
    key: 'type', values: [{ create: 'hat' }, { delete: 'mug' }],
  });
  assert.equal('type' in definition, false);
});

test('a userErrors refusal reaches the operator intact', async () => {
  const fake = store(drifted());
  fake.client.repairMetaobject = async () => {
    throw new Error('metaobject:faq: Cannot set required on field answer: 4 entries have no value');
  };
  const result = await synchronizeFleet(
    targets, schema(), 'apply', (async () => fake.client) as unknown as Connect, { repair: true },
  );
  assert.match(result.stores[0]?.refused ?? '', /4 entries have no value/);
  assert.equal(fleetExitCode(result, 'apply'), 2);
});
