import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminClient, synchronize } from '../dist/index.js';
import { compileSchema, defineSchema, field, metaobject } from '../dist/index.js';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('Admin client validates stores before constructing a URL', () => {
  assert.throws(() => new AdminClient({ store: 'evil.example.com', token: 'secret' }), /myshopify/);
});

test('read requests retry transient HTTP responses without exposing tokens', async () => {
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

// The escape this closes: every other test here stubs readSchema, so nothing ever sent the
// metafield query, and 0.0.1 through 0.0.4 shipped one no Shopify API version accepts.
test('metafield reads select by identifier, the only selector that is not deprecated', async () => {
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
  assert.deepEqual(result.applied, ['metaobject:faq', 'metafield:PRODUCT:custom.faq_ref']);
});
