import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { readAppConfig } from '../dist/index.js';

const execFileAsync = promisify(execFile);

async function toml(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'metafields-app-'));
  const path = join(directory, 'shopify.app.toml');
  await writeFile(path, content);
  return path;
}

test('readAppConfig reads top-level client_id', async () => {
  const path = await toml([
    '# Learn more at https://shopify.dev',
    'client_id = "0123456789abcdef0123456789abcdef"',
    'name = "storefront-data"',
    'application_url = "https://example.com"',
    '',
    '[access_scopes]',
    'scopes = "write_products"',
  ].join('\n'));
  assert.deepEqual(await readAppConfig(path), { clientId: '0123456789abcdef0123456789abcdef' });
});

test('readAppConfig ignores section-scoped client_id', async () => {
  const path = await toml(['name = "app"', '[build]', 'client_id = "wrong"'].join('\n'));
  await assert.rejects(readAppConfig(path), /no top-level client_id/);
});

test('readAppConfig ignores commented client_id', async () => {
  const path = await toml(['# client_id = "commented"', 'name = "app" # client_id = "trailing"'].join('\n'));
  await assert.rejects(readAppConfig(path), /no top-level client_id/);
});

test('readAppConfig rejects unquoted client_id', async () => {
  const path = await toml('client_id = 12345\n');
  await assert.rejects(readAppConfig(path), /must be a non-empty quoted string/);
});

test('readAppConfig reports the missing path', async () => {
  await assert.rejects(readAppConfig(join(tmpdir(), 'metafields-absent.toml')), /could not read/);
});

async function authError(options: string[], env: Record<string, string> = {}): Promise<string> {
  const argv = ['./dist/cli.js', './test/fixture-schema.ts', '--store', 'example.myshopify.com', ...options];
  try {
    return (await execFileAsync(process.execPath, argv, { env: { PATH: process.env.PATH ?? '', ...env } })).stderr;
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

test('--app-config supplies the app grant client ID', async () => {
  const path = await toml('client_id = "from-toml"\n');
  assert.match(await authError([]), /set SHOPIFY_ADMIN_ACCESS_TOKEN/);
  assert.match(await authError(['--app-config', path]), /app auth needs both/);
});

test('--client-id overrides --app-config and the environment', async () => {
  const unreadable = join(tmpdir(), 'metafields-absent.toml');
  assert.match(await authError(['--app-config', unreadable, '--client-id', 'x']), /app auth needs both/);
  assert.match(await authError(['--app-config', unreadable]), /could not read/);
  assert.match(
    await authError(['--app-config', unreadable], { SHOPIFY_APP_CLIENT_ID: 'from-env' }),
    /could not read/,
  );
});
