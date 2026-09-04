import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminClient, synchronize } from '../dist/index.js';
import { compileSchema, defineSchema, field, metaobject } from '../dist/index.js';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('Admin client validates stores before building URLs', () => {
  assert.throws(() => new AdminClient({ store: 'evil.example.com', token: 'secret' }), /myshopify/);
});

test('reads retry transient HTTP errors and redact tokens', async () => {
  let attempts = 0;
  const client = new AdminClient({
    store: 'example.myshopify.com', token: 'shpat_supersecret', retries: 1,
    fetch: async () => {
      attempts += 1;
      return attempts === 1 ? response({}, 500) : response({ data: { shop: { id: 'gid://shopify/Shop/1' } } });
    },
  });
  const data = await client.request<{ shop: { id: string } }>('query { shop { id } }');
  assert.equal(data.shop.id, 'gid://shopify/Shop/1');
  assert.equal(attempts, 2);
});

test('metafield reads select by identifier', async () => {
  let sent = { query: '', variables: {} as Record<string, unknown> };
  const client = new AdminClient({
    store: 'example.myshopify.com',
    token: 'shpat_x',
    fetch: async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as typeof sent;
      return response({ data: { metafieldDefinition: null } });
    },
  });
  await client.readMetafield({ ownerType: 'PRODUCT', namespace: 'custom', key: 'promo_text' });
  assert.match(sent.query, /metafieldDefinition\(identifier: \$identifier\)/);
  assert.deepEqual(sent.variables, {
    identifier: { ownerType: 'PRODUCT', namespace: 'custom', key: 'promo_text' },
  });
});

function throttled(): Response {
  return response({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
}

test('HTTP 200 throttles retry; over-cost queries do not', async () => {
  const attempts: string[] = [];
  const client = new AdminClient({
    store: 'example.myshopify.com', token: 'shpat_x', retries: 1,
    fetch: async (_input, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      attempts.push(query);
      if (query.includes('overCost')) {
        return response({
          errors: [{
            message: 'Query cost is 2003, which exceeds the single query max cost limit (1000).',
            extensions: { code: 'MAX_COST_EXCEEDED' },
          }],
        });
      }
      return attempts.length === 1 ? throttled() : response({ data: { shop: { id: '1' } } });
    },
  });
  assert.deepEqual(await client.request('query { shop { id } }'), { shop: { id: '1' } });
  assert.equal(attempts.length, 2);
  await assert.rejects(client.request('query { overCost }'), /exceeds the single query max cost/);
  assert.equal(attempts.length, 3);
});

test('mutations retry throttles but not ambiguous failures', async () => {
  let attempts = 0;
  const client = new AdminClient({
    store: 'example.myshopify.com', token: 'shpat_x', retries: 2,
    fetch: async () => {
      attempts += 1;
      return attempts < 3 ? throttled() : response({ data: { ok: true } });
    },
  });
  assert.deepEqual(await client.request('mutation { ok }', {}, true), { ok: true });
  assert.equal(attempts, 3);

  let serverErrors = 0;
  const failing = new AdminClient({
    store: 'example.myshopify.com', token: 'shpat_x', retries: 2,
    fetch: async () => {
      serverErrors += 1;
      return response({}, 500);
    },
  });
  await assert.rejects(failing.request('mutation { ok }', {}, true), /HTTP 500/);
  assert.equal(serverErrors, 1);
});

test('metaobject reference types resolve to Shopify definition IDs', async () => {
  const desired = compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({ name: 'FAQ', fields: { title: field.string() } }),
      story: metaobject({ name: 'Story', fields: { title: field.string() } }),
    },
    metafields: {
      product: {
        custom: {
          faq_ref: field.metaobject('faq'),
          any_ref: field.mixedMetaobject(['faq', 'story']),
        },
      },
    },
  }));
  const ids: Record<string, string> = {
    faq: 'gid://shopify/MetaobjectDefinition/1',
    story: 'gid://shopify/MetaobjectDefinition/2',
  };
  const stored: Record<string, { name: string; value: string }[]> = {
    faq_ref: [{ name: 'metaobject_definition_id', value: ids.faq as string }],
    any_ref: [{ name: 'metaobject_definition_ids', value: JSON.stringify([ids.faq, ids.story]) }],
  };
  const types: Record<string, string> = { faq_ref: 'metaobject_reference', any_ref: 'mixed_reference' };
  const sent: Record<string, { name: string; value: string }[]> = {};
  const live = new Set<string>();
  const client = new AdminClient({
    store: 'example.myshopify.com',
    token: 'shpat_x',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, never> };
      const variables = body.variables as Record<string, never> & {
        type?: string;
        identifier?: { key: string };
        definition?: { type?: string; key?: string; validations?: { name: string; value: string }[] };
      };
      if (body.query.includes('metaobjectDefinitionCreate')) {
        const type = String(variables.definition?.type);
        live.add(type);
        return response({
          data: { metaobjectDefinitionCreate: { metaobjectDefinition: { id: ids[type], type }, userErrors: [] } },
        });
      }
      if (body.query.includes('metafieldDefinitionCreate')) {
        const key = String(variables.definition?.key);
        sent[key] = variables.definition?.validations ?? [];
        live.add(key);
        return response({
          data: {
            metafieldDefinitionCreate: {
              createdDefinition: { id: `gid://shopify/MetafieldDefinition/${key}` },
              userErrors: [],
            },
          },
        });
      }
      if (body.query.includes('metaobjectDefinitionByType')) {
        const type = String(variables.type);
        return response({
          data: {
            metaobjectDefinitionByType: live.has(type) ? {
              id: ids[type], type, name: type, description: null, displayNameKey: null,
              access: { admin: 'MERCHANT_READ_WRITE', storefront: 'NONE' },
              capabilities: { publishable: { enabled: false }, translatable: { enabled: false } },
              fieldDefinitions: [{
                key: 'title', name: 'Title', description: null,
                type: { name: 'single_line_text_field' }, required: false, validations: [],
              }],
            } : null,
          },
        });
      }
      const key = String(variables.identifier?.key);
      return response({
        data: {
          metafieldDefinition: live.has(key) ? {
            id: `gid://shopify/MetafieldDefinition/${key}`, namespace: 'custom', key, ownerType: 'PRODUCT',
            name: key === 'faq_ref' ? 'Faq ref' : 'Any ref', description: null,
            type: { name: types[key] }, validations: stored[key],
            access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ', customerAccount: 'NONE' },
            capabilities: {
              adminFilterable: { enabled: false }, analyticsQueryable: { enabled: false },
              cartToOrderCopyable: { enabled: false }, smartCollectionCondition: { enabled: false },
              uniqueValues: { enabled: false },
            },
            constraints: null, validationStatus: 'ALL_VALID', invalidCount: 0,
          } : null,
        },
      });
    },
  });

  const result = await synchronize(client, desired, 'apply');
  assert.deepEqual(sent.faq_ref, [{ name: 'metaobject_definition_id', value: ids.faq }]);
  assert.deepEqual(sent.any_ref, [
    { name: 'metaobject_definition_ids', value: JSON.stringify([ids.faq, ids.story]) },
  ]);
  assert.equal(result.plan.conflicts, 0);
  assert.deepEqual(result.created, [
    'metaobject:faq', 'metaobject:story',
    'metafield:PRODUCT:custom.any_ref', 'metafield:PRODUCT:custom.faq_ref',
  ]);
});

test('updates can reference metaobjects created in the same run', async () => {
  const desired = compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({ name: 'FAQ', fields: { title: field.string() } }),
      article: metaobject({
        name: 'Article',
        fields: { title: field.string(), faq: field.metaobject('faq') },
      }),
    },
    metafields: {},
  }));
  const faqId = 'gid://shopify/MetaobjectDefinition/10';
  const articleId = 'gid://shopify/MetaobjectDefinition/11';
  const calls: string[] = [];
  let sentUpdate: { id?: string; definition?: { fieldDefinitions?: unknown } } = {};
  let faqLive = false;
  let articleUpdated = false;
  const titleField = {
    key: 'title', name: 'Title', description: null,
    type: { name: 'single_line_text_field' }, required: false, validations: [],
  };
  const client = new AdminClient({
    store: 'example.myshopify.com',
    token: 'shpat_x',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes('metaobjectDefinitionCreate')) {
        calls.push('metaobjectDefinitionCreate');
        faqLive = true;
        return response({
          data: { metaobjectDefinitionCreate: { metaobjectDefinition: { id: faqId, type: 'faq' }, userErrors: [] } },
        });
      }
      if (body.query.includes('metaobjectDefinitionUpdate')) {
        calls.push('metaobjectDefinitionUpdate');
        sentUpdate = body.variables as typeof sentUpdate;
        articleUpdated = true;
        return response({
          data: { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: articleId }, userErrors: [] } },
        });
      }
      const type = String((body.variables as { type?: string }).type);
      const shell = {
        description: null, displayNameKey: null,
        access: { admin: 'MERCHANT_READ_WRITE', storefront: 'NONE' },
        capabilities: { publishable: { enabled: false }, translatable: { enabled: false } },
      };
      if (type === 'faq') {
        return response({
          data: {
            metaobjectDefinitionByType: faqLive
              ? { id: faqId, type, name: 'FAQ', fieldDefinitions: [titleField], ...shell }
              : null,
          },
        });
      }
      const faqRef = {
        key: 'faq', name: 'Faq', description: null, type: { name: 'metaobject_reference' },
        required: false, validations: [{ name: 'metaobject_definition_id', value: faqId }],
      };
      return response({
        data: {
          metaobjectDefinitionByType: {
            id: articleId, type, name: 'Article',
            fieldDefinitions: articleUpdated ? [titleField, faqRef] : [titleField],
            ...shell,
          },
        },
      });
    },
  });

  const result = await synchronize(client, desired, 'apply');
  assert.deepEqual(calls, ['metaobjectDefinitionCreate', 'metaobjectDefinitionUpdate']);
  assert.equal(sentUpdate.id, articleId);
  assert.deepEqual(sentUpdate.definition?.fieldDefinitions, [{
    create: {
      key: 'faq', type: 'metaobject_reference', name: 'Faq',
      validations: [{ name: 'metaobject_definition_id', value: faqId }],
    },
  }]);
  assert.deepEqual(result.created, ['metaobject:faq']);
  assert.deepEqual(result.updated, ['metaobject:article']);
});

test('metaobject field capabilities support read, create, and update', async () => {
  const desired = compileSchema(defineSchema({
    metaobjects: {
      faq: metaobject({ name: 'FAQ', fields: { question: field.string({ adminFilterable: true }) } }),
      article: metaobject({ name: 'Article', fields: { title: field.string({ adminFilterable: true }) } }),
    },
    metafields: {},
  }));
  const articleId = 'gid://shopify/MetaobjectDefinition/11';
  let sentCreate: { definition?: { fieldDefinitions?: unknown } } = {};
  let sentUpdate: { definition?: { fieldDefinitions?: unknown } } = {};
  let filterable = false;
  let faqLive = false;
  const shell = {
    description: null, displayNameKey: null,
    access: { admin: 'MERCHANT_READ_WRITE', storefront: 'NONE' },
    capabilities: { publishable: { enabled: false }, translatable: { enabled: false } },
  };
  const client = new AdminClient({
    store: 'example.myshopify.com',
    token: 'shpat_x',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes('metaobjectDefinitionCreate')) {
        sentCreate = body.variables as typeof sentCreate;
        faqLive = true;
        return response({
          data: {
            metaobjectDefinitionCreate: {
              metaobjectDefinition: { id: 'gid://shopify/MetaobjectDefinition/10', type: 'faq' },
              userErrors: [],
            },
          },
        });
      }
      if (body.query.includes('metaobjectDefinitionUpdate')) {
        sentUpdate = body.variables as typeof sentUpdate;
        filterable = true;
        return response({
          data: { metaobjectDefinitionUpdate: { metaobjectDefinition: { id: articleId }, userErrors: [] } },
        });
      }
      const type = String((body.variables as { type?: string }).type);
      const titled = (key: string, name: string, enabled: boolean) => ({
        key, name, description: null, type: { name: 'single_line_text_field' },
        required: false, validations: [], capabilities: { adminFilterable: { enabled } },
      });
      if (type === 'faq') {
        return response({
          data: {
            metaobjectDefinitionByType: faqLive
              ? { id: 'gid://shopify/MetaobjectDefinition/10', type, name: 'FAQ', ...shell, fieldDefinitions: [titled('question', 'Question', true)] }
              : null,
          },
        });
      }
      return response({
        data: {
          metaobjectDefinitionByType: {
            id: articleId, type, name: 'Article', ...shell,
            fieldDefinitions: [titled('title', 'Title', filterable)],
          },
        },
      });
    },
  });

  const result = await synchronize(client, desired, 'apply');
  assert.deepEqual(sentCreate.definition?.fieldDefinitions, [{
    key: 'question', type: 'single_line_text_field', name: 'Question',
    capabilities: { adminFilterable: { enabled: true } },
  }]);
  assert.deepEqual(sentUpdate.definition?.fieldDefinitions, [{
    update: { key: 'title', capabilities: { adminFilterable: { enabled: true } } },
  }]);
  assert.deepEqual(result.created, ['metaobject:faq']);
  assert.deepEqual(result.updated, ['metaobject:article']);
});

test('apply creates metaobjects before metafields and verifies afterward', async () => {
  const desired = compileSchema(defineSchema({
    metaobjects: { faq: metaobject({ name: 'FAQ', fields: { title: field.string() } }) },
    metafields: { product: { custom: { faq_ref: field.metaobject('faq') } } },
  }));
  const calls: string[] = [];
  let createdMetaobject = false;
  let createdMetafield = false;
  const fake = {
    async readSchema() {
      return {
        metaobjects: createdMetaobject ? [{ type: 'faq', name: 'FAQ', fields: [{ key: 'title', name: 'Title', type: 'single_line_text_field', validations: [], required: false }] }] : [],
        metafields: createdMetafield ? [{ ownerType: 'PRODUCT', namespace: 'custom', key: 'faq_ref', name: 'Faq ref', type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_type', value: 'faq' }], validationStatus: 'ALL_VALID' }] : [],
      };
    },
    async createMetaobject() { calls.push('metaobjectDefinitionCreate'); createdMetaobject = true; },
    async createMetafield() { calls.push('metafieldDefinitionCreate'); createdMetafield = true; },
  };
  const result = await synchronize(fake as never, desired, 'apply');
  assert.deepEqual(calls, ['metaobjectDefinitionCreate', 'metafieldDefinitionCreate']);
  assert.deepEqual(result.created, ['metaobject:faq', 'metafield:PRODUCT:custom.faq_ref']);
});
