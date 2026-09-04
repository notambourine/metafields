import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  compileSchema,
  defineSchema,
  descriptionViolations,
  field,
  fleetExitCode,
  fleetReport,
  GrantError,
  metaobject,
  mintAccessToken,
  renderFleet,
  synchronize,
  synchronizeFleet,
  type CompiledSchema,
  type Connect,
  type StoreTarget,
} from '../dist/index.js';

function schema(): CompiledSchema {
  return compileSchema(defineSchema({
    metaobjects: {},
    metafields: { product: { custom: { promo_text: field.string({ name: 'Promo text' }) } } },
  }));
}

const PRESENT = {
  ownerType: 'PRODUCT', namespace: 'custom', key: 'promo_text', name: 'Promo text',
  type: 'single_line_text_field', validations: [], validationStatus: 'ALL_VALID' as const, invalidCount: 0,
};

interface StoreState { metafields: unknown[]; refuse?: string }

function fleet(states: Record<string, StoreState>): { connect: Connect; created: string[] } {
  const created: string[] = [];
  const connect = (async (store: string) => {
    const state = states[store];
    if (!state) throw new GrantError(store, 'app_not_installed', 'app is not installed on this shop');
    return {
      store,
      async readSchema() { return { metaobjects: [], metafields: state.metafields }; },
      async createMetafield() {
        if (state.refuse) throw new Error(state.refuse);
        state.metafields.push(PRESENT);
        created.push(store);
      },
      async createMetaobject() { throw new Error('unexpected'); },
    };
  }) as unknown as Connect;
  return { connect, created };
}

function targets(...stores: [string, boolean][]): StoreTarget[] {
  return stores.map(([store, explicit]) => ({ store, explicit }));
}

test('blocked drift on one store does not block other stores', async () => {
  const { connect, created } = fleet({
    'a.myshopify.com': { metafields: [] },
    'b.myshopify.com': { metafields: [{ ...PRESENT, type: 'url' }] },
  });
  const result = await synchronizeFleet(
    targets(['a.myshopify.com', true], ['b.myshopify.com', true]), schema(), 'apply', connect,
  );
  assert.deepEqual(created, ['a.myshopify.com']);
  assert.deepEqual(result.stores.map((item) => item.skipped), [
    [], ['metafield:PRODUCT:custom.promo_text'],
  ]);
  assert.equal(fleetExitCode(result), 1);
});

test('sweeps report unenrolled stores without failing', async () => {
  const { connect, created } = fleet({ 'a.myshopify.com': { metafields: [] } });
  const result = await synchronizeFleet(
    targets(['a.myshopify.com', true], ['b.myshopify.com', false]), schema(), 'apply', connect,
  );
  assert.deepEqual(created, ['a.myshopify.com']);
  assert.deepEqual(
    result.stores.map((item) => [item.store, item.status]),
    [['a.myshopify.com', 'planned'], ['b.myshopify.com', 'not-installed']],
  );
  assert.equal(fleetExitCode(result), 0);
});

test('explicit stores fail when the app is not installed', async () => {
  const { connect } = fleet({ 'a.myshopify.com': { metafields: [] } });
  await assert.rejects(
    synchronizeFleet(targets(['a.myshopify.com', true], ['b.myshopify.com', true]), schema(), 'apply', connect),
    /app is not installed/,
  );
});

test('unreachable swept stores exit 2', async () => {
  const connect = (async (store: string) => {
    if (store === 'b.myshopify.com') throw new GrantError(store, 'shop_not_permitted', 'shop is in another organization');
    return { store, async readSchema() { return { metaobjects: [], metafields: [PRESENT] }; } };
  }) as unknown as Connect;
  const result = await synchronizeFleet(
    targets(['a.myshopify.com', true], ['b.myshopify.com', false]), schema(), 'apply', connect,
  );
  assert.equal(result.stores[1]?.status, 'unreachable');
  assert.equal(result.stores[1]?.code, 'shop_not_permitted');
  assert.equal(fleetExitCode(result), 2);
});

test('fleet writes continue after refusals and collect each error', async () => {
  const { connect, created } = fleet({
    'a.myshopify.com': { metafields: [], refuse: 'PRODUCT:custom.promo_text: taken' },
    'b.myshopify.com': { metafields: [] },
    'c.myshopify.com': { metafields: [], refuse: 'PRODUCT:custom.promo_text: locked' },
  });
  const result = await synchronizeFleet(
    targets(['a.myshopify.com', true], ['b.myshopify.com', true], ['c.myshopify.com', true]),
    schema(), 'apply', connect,
  );
  assert.deepEqual(created, ['b.myshopify.com']);
  assert.deepEqual(result.stores.map((item) => item.refused?.split(':').pop()?.trim()), ['taken', undefined, 'locked']);
  assert.equal(fleetExitCode(result), 2);
});

test('description validation reports all errors before requests', async () => {
  const long = 'x'.repeat(256);
  const over = compileSchema(defineSchema({
    metaobjects: { faq: metaobject({ name: 'FAQ', fields: { question: field.string({ description: long }) } }) },
    metafields: { product: { custom: { promo_text: field.string({ description: long }) } } },
  }));
  assert.deepEqual(descriptionViolations(over).map((item) => item.split('.description')[0]), [
    'metaobject:faq.fields.question', 'metafield:PRODUCT:custom.promo_text',
  ]);
  const unreachable = { async readSchema() { throw new Error('a socket was opened'); } };
  await assert.rejects(synchronize(unreachable as never, over, 'apply'), /256 characters/);
});

test('token minting distinguishes app installation and organization errors', async () => {
  let sent = { url: '', body: '' };
  const token = await mintAccessToken({
    store: 'a.myshopify.com', clientId: 'id', clientSecret: 'secret',
    fetch: async (input, init) => {
      sent = { url: String(input), body: String(init?.body) };
      return Response.json({ access_token: 'shpca_minted' });
    },
  });
  assert.equal(token, 'shpca_minted');
  assert.equal(sent.url, 'https://a.myshopify.com/admin/oauth/access_token');
  assert.deepEqual([...new URLSearchParams(sent.body).entries()].sort(), [
    ['client_id', 'id'], ['client_secret', 'secret'], ['grant_type', 'client_credentials'],
  ]);

  for (const code of ['app_not_installed', 'shop_not_permitted']) {
    await assert.rejects(mintAccessToken({
      store: 'a.myshopify.com', clientId: 'id', clientSecret: 'secret',
      fetch: async () => Response.json({ error: code, error_description: `${code} detail` }, { status: 400 }),
    }), (error: unknown) => error instanceof GrantError && error.code === code);
  }
});

test('fleet reports summarize matches and identify changed shapes', async () => {
  const desired = compileSchema(defineSchema({
    metaobjects: { faq: metaobject({ name: 'FAQ', fields: { question: field.string({ name: 'Question' }) } }) },
    metafields: { product: { custom: {
      promo_text: field.string({ name: 'Promo text' }),
      docs: field.url({ name: 'Docs' }),
    } } },
  }));
  const metafields: unknown[] = [PRESENT];
  const connect = (async (store: string) => ({
    store,
    async readSchema() {
      return {
        metaobjects: [{
          id: 'gid://shopify/MetaobjectDefinition/1', type: 'faq', name: 'FAQ',
          fields: [{ key: 'question', name: 'Question', type: 'single_line_text_field', validations: [] }],
        }],
        metafields,
      };
    },
    async createMetafield() {
      metafields.push({ ...PRESENT, key: 'docs', name: 'Docs', type: 'url' });
    },
  })) as unknown as Connect;
  const result = await synchronizeFleet(targets(['a.myshopify.com', true]), desired, 'apply', connect);
  assert.equal(renderFleet(result), [
    'STORE a.myshopify.com (2 in sync)',
    'CREATED metafield:PRODUCT:custom.docs url',
    '',
  ].join('\n'));
});

test('blocked definitions retain reasons and --force guidance', async () => {
  const connect = (async (store: string) => ({
    store,
    async readSchema() { return { metaobjects: [], metafields: [{ ...PRESENT, type: 'url' }] }; },
  })) as unknown as Connect;
  const result = await synchronizeFleet(targets(['a.myshopify.com', true]), schema(), 'dry-run', connect);
  assert.equal(renderFleet(result), [
    'STORE a.myshopify.com',
    'BLOCKED metafield:PRODUCT:custom.promo_text single_line_text_field',
    '  metafield:PRODUCT:custom.promo_text.type: expected single_line_text_field, found url',
    '  Retyping definitions with stored values is unsupported. Use a migration.',
    '',
  ].join('\n'));
});

test('JSON reports include decisions and omit input schemas', async () => {
  const connect = (async (store: string) => ({
    store,
    async readSchema() { return { metaobjects: [], metafields: [{ ...PRESENT, type: 'url' }] }; },
  })) as unknown as Connect;
  const result = await synchronizeFleet(targets(['a.myshopify.com', true]), schema(), 'dry-run', connect);
  const report = fleetReport(result);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('"desired"') && !serialized.includes('"existing"'));
  assert.deepEqual(report.stores[0]?.plan?.items, [{
    kind: 'metafield',
    identity: 'metafield:PRODUCT:custom.promo_text',
    status: 'CONFLICT',
    reasons: ['metafield:PRODUCT:custom.promo_text.type: expected single_line_text_field, found url'],
    notices: [],
  }]);
  assert.deepEqual(report.stores[0]?.drift?.items, [{
    identity: 'metafield:PRODUCT:custom.promo_text',
    applies: [],
    needsForce: [],
    blocked: ['metafield:PRODUCT:custom.promo_text.type: expected single_line_text_field, found url'],
  }]);
});

const execFileAsync = promisify(execFile);

async function cli(args: string[], env: Record<string, string>) {
  return execFileAsync(process.execPath, ['./dist/cli.js', ...args], {
    env: { ...process.env, SHOPIFY_ADMIN_ACCESS_TOKEN: '', SHOPIFY_APP_CLIENT_ID: '', SHOPIFY_APP_SECRET: '', ...env },
  });
}

test('CLI accepts repeated --store and rejects token-only fleets', async () => {
  await assert.rejects(
    cli(['./test/fixture-schema.ts', '--store', 'a.myshopify.com', '--store', 'b.myshopify.com'],
      { SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_x' }),
    /fleets require SHOPIFY_APP_CLIENT_ID/,
  );
});

test('incomplete app credentials fall back to a static token', async () => {
  const reject = (args: string[], env: Record<string, string>) =>
    cli(args, env).then(() => '', (error: { stderr?: string }) => error.stderr ?? '');
  assert.match(
    await reject(['./test/fixture-schema.ts', '--store', 'not-a-shop'],
      { SHOPIFY_APP_CLIENT_ID: 'id', SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_x' }),
    /store must be a \*\.myshopify\.com host/,
  );
  assert.match(
    await reject(['./test/fixture-schema.ts', '--store', 'not-a-shop'], { SHOPIFY_APP_CLIENT_ID: 'id' }),
    /app auth needs both/,
  );
});

test('CLI --validate reports all description errors and exits 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'metafields-limits-'));
  const path = join(directory, 'schema.ts');
  await writeFile(path, `import { defineSchema, field } from '${join(process.cwd(), 'dist/index.js')}';
export default defineSchema({
  metaobjects: {},
  metafields: { product: { custom: {
    alpha: field.string({ description: '${'x'.repeat(256)}' }),
    beta: field.string({ description: '${'y'.repeat(300)}' }),
  } } },
});
`);
  const failure = await cli([path, '--validate', '--json'], {}).catch((error: unknown) => error);
  const { code, stdout } = failure as { code: number; stdout: string };
  assert.equal(code, 2);
  const parsed = JSON.parse(stdout) as { status: string; violations: string[] };
  assert.equal(parsed.status, 'invalid');
  assert.equal(parsed.violations.length, 2);
});

test('errors redact minted tokens', () => {
  const leaked = new GrantError('a.myshopify.com', 'unreachable', 'connect failed for shpca_minted_abc');
  assert.equal(leaked.message, 'connect failed for [REDACTED]');
});
