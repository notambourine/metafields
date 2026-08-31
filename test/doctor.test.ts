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

// The shipped table rendered back into the shape the proxy answers with, so a registry built
// from it compares equal. Every case below starts here and changes one thing.
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

test('a registry matching the shipped table reports no differences', () => {
  const check = compareRegistry(shippedRegistry());
  assert.equal(check.matches, true);
  assert.deepEqual(check.types, []);
  assert.deepEqual(check.owners, []);
});

test('a type Shopify added is reported as added', () => {
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

test('a type Shopify dropped is reported as removed', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes(registry.types.filter((type) => type.name !== 'boolean')));
  assert.deepEqual(check.types, [{ kind: 'removed', name: 'boolean' }]);
});

test('a new validation on an existing type is reported with what changed', () => {
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

test('category and migratable changes are reported together', () => {
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

test('an owner type the enum gained is reported without touching the type list', () => {
  const registry = shippedRegistry();
  const check = compareRegistry({ ...registry, owners: [...registry.owners, 'WAREHOUSE'] });
  assert.deepEqual(check.types, []);
  assert.deepEqual(check.owners, [{ kind: 'added', name: 'WAREHOUSE' }]);
  assert.equal(check.matches, false);
});

// Validation order is a rendering detail of whichever side you read; only membership matters.
test('validations reordered are not a difference', () => {
  const registry = shippedRegistry();
  const check = compareRegistry(withTypes(registry.types.map((type) => (
    { ...type, supportedValidations: [...type.supportedValidations].reverse() }
  ))));
  assert.equal(check.matches, true);
});

// runDoctor takes its fetcher so both branches stay offline. Nothing in the suite may depend
// on shopify.dev being up.
test('doctor passes both checks when the registry matches', async () => {
  const report = await runDoctor(DEFAULT_API_VERSION, async () => shippedRegistry());
  assert.equal(report.healthy, true);
  assert.deepEqual(report.checks.map((check) => check.name), ['api-version', 'metafield-types']);
  assert.equal(doctorExitCode(report), 0);
});

test('doctor reports a stale table as a failed check, not an error', async () => {
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

test('a version Shopify refuses is a failed check, and the type table is not guessed at', async () => {
  const report = await runDoctor('2019-01', () => {
    throw new RegistryError('unsupported-version', 'Invalid API version');
  });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.checks.map((check) => check.name), ['api-version']);
  assert.equal(doctorExitCode(report), 1);
});

// An outage is not a finding: it must not read as a healthy store or a stale table.
test('an unreachable proxy throws rather than reporting a failed check', async () => {
  await assert.rejects(
    runDoctor(DEFAULT_API_VERSION, () => {
      throw new RegistryError('unavailable', 'cannot reach shopify.dev');
    }),
    /cannot reach shopify.dev/,
  );
});

test('an aged-out pin blames the release, and an explicit --api-version blames the flag', async () => {
  const fail = () => { throw new RegistryError('unsupported-version', 'Invalid API version'); };
  const pinned = await runDoctor(DEFAULT_API_VERSION, fail);
  const chosen = await runDoctor('2019-01', fail);
  assert.match(pinned.checks[0]?.details[0] ?? '', /upgrade @notambourine\/metafields/);
  assert.match(chosen.checks[0]?.details[0] ?? '', /--api-version/);
});
