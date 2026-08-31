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

// The same schema, plus the one attribute whose change can stop a live storefront reading a field.
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

test('classifyDrift sorts drift into applied, needs-force, and nothing-reaches-it', () => {
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

test('IN_PROGRESS validation is never written, not even a label', () => {
  const existing = drifted();
  const promo = existing.metafields[0];
  if (promo) promo.validationStatus = 'IN_PROGRESS';
  const drift = classifyDrift(planSchema(schema(), existing));
  const metafield = drift.items.find((entry) => entry.item.kind === 'metafield');
  assert.deepEqual([metafield?.applies, metafield?.needsForce], [[], []]);
  assert.match(metafield?.blocked.join() ?? '', /validation is in progress/);
});

test('a definition needing force is skipped whole, so its safe drift waits with it', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, restricted(), 'apply', connectTo(fake.client),
  );
  assert.deepEqual(fake.sent, ['metaobject:faq']);
  assert.deepEqual(result.stores[0]?.updated, ['metaobject:faq']);
  assert.deepEqual(result.stores[0]?.skipped, ['metafield:PRODUCT:custom.promo_text']);
  assert.equal(fleetExitCode(result), 1);
});

test('--force writes the skipped definition, drift and all', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, restricted(), 'apply', connectTo(fake.client), { force: true },
  );
  assert.deepEqual(fake.sent, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.deepEqual(result.stores[0]?.skipped, []);
  assert.equal(fleetExitCode(result), 0);
});

test('--apply updates metaobjects before metafields and verifies afterward', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(targets, schema(), 'apply', connectTo(fake.client));
  assert.deepEqual(fake.sent, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.deepEqual(result.stores[0]?.updated, ['metaobject:faq', 'metafield:PRODUCT:custom.promo_text']);
  assert.equal(fleetExitCode(result), 0);
});

test('--dry-run cancels the write and still reports the drift that remains', async () => {
  const fake = store(drifted());
  const result = await synchronizeFleet(
    targets, restricted(), 'dry-run', connectTo(fake.client), { force: true },
  );
  assert.deepEqual(fake.sent, []);
  assert.equal(result.stores[0]?.updated, undefined);
  assert.equal(fleetExitCode(result), 1);
});

test('a store that needs force does not stop the applied set reaching the rest of the fleet', async () => {
  // Store a has only drift --apply resolves; store b also narrows storefront access.
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

test('an update adds a field and never deletes or retypes one', async () => {
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

test('a metafield update diffs constraint values instead of replacing them', async () => {
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
  // Constraints need force, so the update only carries them when it is passed.
  const entry = classifyDrift(planSchema(constrained, existing)).items[0];
  await client.updateMetafield(entry!, true);
  const definition = variables.definition as Record<string, unknown>;
  assert.deepEqual(definition.constraintsUpdates, {
    key: 'type', values: [{ create: 'hat' }, { delete: 'mug' }],
  });
  assert.equal('type' in definition, false);
});

// A store where only the labels drift: every operational attribute already matches.
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

test('cosmetic drift is applied by default and still leaves the plan PRESENT', () => {
  const plan = planSchema(schema(), relabelled());
  assert.deepEqual(plan.items.map((item) => item.status), ['PRESENT', 'PRESENT']);
  assert.equal(exitCodeForPlan(plan), 0);
  const drift = classifyDrift(plan);
  assert.deepEqual(drift.items.map((entry) => entry.applies), [
    ['metaobject:faq.name differs'], ['metafield:PRODUCT:custom.promo_text.name differs'],
  ]);
  assert.equal(drift.applies, 2);
});

test('a definition still validating is never relabelled either', () => {
  const existing = relabelled();
  const promo = existing.metafields[0];
  if (promo) promo.validationStatus = 'IN_PROGRESS';
  const drift = classifyDrift(planSchema(schema(), existing));
  const metafield = drift.items.find((entry) => entry.item.kind === 'metafield');
  assert.deepEqual(metafield?.applies, []);
  assert.equal(metafield?.blocked.length, 2);
});

test('a relabel sends the name and nothing else the operator did not declare drifted', async () => {
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

test('an update of operational drift leaves an undrifted name alone', async () => {
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

test('a userErrors refusal reaches the operator intact', async () => {
  const fake = store(drifted());
  fake.client.updateMetaobject = async () => {
    throw new Error('metaobject:faq: Cannot set required on field answer: 4 entries have no value');
  };
  const result = await synchronizeFleet(targets, schema(), 'apply', connectTo(fake.client));
  assert.match(result.stores[0]?.refused ?? '', /4 entries have no value/);
  assert.equal(fleetExitCode(result), 2);
});

// The one failure mode a generic flag name creates is someone hitting an unrelated refusal and
// reaching for --force, so every blocker says that it cannot.
test('a blocked definition is told what --force will not do for it', () => {
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
    'Shopify will not retype a definition that holds values. --force cannot do this; use a migration.',
    'Invalid stored values are data, not shape. --force cannot do this; correct the values.',
  ]);
});

const execFileAsync = promisify(execFile);

test('--force alone is an error; with --apply it survives flag validation', async () => {
  const run = (args: string[]) => execFileAsync(process.execPath, ['./dist/cli.js', ...args], {
    env: { ...process.env, SHOPIFY_ADMIN_ACCESS_TOKEN: '', SHOPIFY_APP_CLIENT_ID: '', SHOPIFY_APP_SECRET: '' },
  }).then(() => '', (error: { stderr?: string }) => error.stderr ?? '');
  const base = ['./test/fixture-schema.ts', '--store', 'a.myshopify.com'];
  assert.match(await run([...base, '--force']), /--force requires --apply/);
  assert.match(await run([...base, '--apply', '--force', '--dry-run']), /SHOPIFY_ADMIN_ACCESS_TOKEN/);
});
