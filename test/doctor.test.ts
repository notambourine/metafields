import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_API_VERSION,
  METAFIELD_OWNER_TYPES,
  METAFIELD_TYPES,
  RegistryError,
  compareRegistry,
  doctorExitCode,
  runDoctor,
} from '../dist/index.js';
import type { Registry, RegistryType } from '../dist/index.js';

function shippedRegistry(): Registry {
  const types: RegistryType[] = Object.entries(METAFIELD_TYPES).map(([name, info]) => ({
    name,
    category: info.category,
    supportsDefinitionMigrations: info.migratable,
    supportedValidations: info.validations.map((validation) => ({ name: validation, type: 'string' })),
  }));
  return { version: '2026-07', types, owners: [...METAFIELD_OWNER_TYPES] };
}

function withTypes(types: RegistryType[]): Registry {
  return { ...shippedRegistry(), types };
}

test('matching registries report no differences', () => {
  const check = compareRegistry(shippedRegistry());
  assert.equal(check.matches, true);
  assert.deepEqual(check.types, []);
  assert.deepEqual(check.owners, []);
});

test('new Shopify types are reported as added', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes([...registry.types, {
    name: 'quantum_field',
    category: 'TEXT',
    supportsDefinitionMigrations: true,
    supportedValidations: [],
  }]));
  assert.deepEqual(check.types, [{ kind: 'added', name: 'quantum_field' }]);
  assert.equal(check.matches, false);
});

test('removed Shopify types are reported as removed', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes(registry.types.filter((type) => type.name !== 'boolean')));
  assert.deepEqual(check.types, [{ kind: 'removed', name: 'boolean' }]);
});

test('new validations report their type and name', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes(registry.types.map((type) => (
    type.name === 'url'
      ? { ...type, supportedValidations: [...type.supportedValidations, { name: 'allowed_schemes', type: 'string' }] }
      : type
  ))));
  assert.deepEqual(check.types, [{
    kind: 'changed',
    name: 'url',
    detail: 'validations +allowed_schemes',
  }]);
});

test('category and migratable changes report together', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes(registry.types.map((type) => (
    type.name === 'boolean'
      ? { ...type, category: 'LOGIC', supportsDefinitionMigrations: !type.supportsDefinitionMigrations }
      : type
  ))));
  const was = METAFIELD_TYPES.boolean;
  assert.deepEqual(check.types, [{
    kind: 'changed',
    name: 'boolean',
    detail: `category ${was.category} -> LOGIC, migratable ${String(was.migratable)} -> ${String(!was.migratable)}`,
  }]);
});

test('new owner types do not change the type list', () => {
  const registry = shippedRegistry();
  const check = compareRegistry({ ...registry, owners: [...registry.owners, 'WAREHOUSE'] });
  assert.deepEqual(check.types, []);
  assert.deepEqual(check.owners, [{ kind: 'added', name: 'WAREHOUSE' }]);
  assert.equal(check.matches, false);
});

test('validation order does not create drift', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes(registry.types.map((type) => (
    { ...type, supportedValidations: [...type.supportedValidations].reverse() }
  ))));
  assert.equal(check.matches, true);
});

test('doctor passes when the registry matches', async () => {
  const report = await runDoctor(DEFAULT_API_VERSION, async () => shippedRegistry());
  assert.equal(report.healthy, true);
  assert.deepEqual(report.checks.map((check) => check.name), ['api-version', 'metafield-types']);
  assert.equal(doctorExitCode(report), 0);
});

test('doctor reports stale tables as findings', async () => {
  const report = await runDoctor(DEFAULT_API_VERSION, async () => {
    const registry = shippedRegistry();
    return { ...registry, owners: [...registry.owners, 'WAREHOUSE'] };
  });
  assert.equal(report.healthy, false);
  const types = report.checks.find((check) => check.name === 'metafield-types');
  assert.equal(types?.ok, false);
  assert.ok(types?.details.includes('added owner WAREHOUSE'));
  assert.equal(doctorExitCode(report), 1);
});

test('doctor reports rejected API versions without guessing types', async () => {
  const report = await runDoctor('2019-01', () => {
    throw new RegistryError('unsupported-version', 'Invalid API version');
  });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.checks.map((check) => check.name), ['api-version']);
  assert.equal(doctorExitCode(report), 1);
});

test('doctor throws when the registry is unreachable', async () => {
  await assert.rejects(
    runDoctor(DEFAULT_API_VERSION, () => {
      throw new RegistryError('unavailable', 'cannot reach shopify.dev');
    }),
    /cannot reach shopify.dev/,
  );
});

test('doctor attributes rejected default and explicit API versions', async () => {
  const fail = () => { throw new RegistryError('unsupported-version', 'Invalid API version'); };
  const pinned = await runDoctor(DEFAULT_API_VERSION, fail);
  const chosen = await runDoctor('2019-01', fail);
  assert.match(pinned.checks[0]?.details[0] ?? '', /upgrade @notambourine\/metafields/);
  assert.match(chosen.checks[0]?.details[0] ?? '', /--api-version/);
});
