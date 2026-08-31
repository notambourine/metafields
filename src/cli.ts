#!/usr/bin/env node
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AdminClient, DEFAULT_API_VERSION } from './admin.js';
import { readAppConfig } from './app-config.js';
import { mintAccessToken } from './auth.js';
import { fleetExitCode, synchronizeFleet, type Connect, type FleetResult, type StoreTarget } from './fleet.js';
import { generateSchemaModule } from './generator.js';
import { descriptionViolations } from './limits.js';
import { loadDefault, loadSchema } from './loader.js';
import {
  assertCompiledMigration,
  compileMigration,
  migrationExitCode,
  MIGRATION_MARKER,
  runMigration,
} from './migration.js';
import { emitLiquidMetafields, isLiquidMetafieldsFile } from './liquid.js';
import { blockedAdvice, type DriftItem } from './changes.js';
import type { PlanItem, SyncMode } from './planner.js';
import { pullSchema } from './pull.js';
import { compileSchema, OWNER_TYPES, SCHEMA_MARKER, stringifyCanonical, type Owner } from './schema.js';
import { doctorExitCode, runDoctor, type DoctorReport } from './doctor.js';

interface Arguments {
  command: 'sync' | 'pull' | 'compile' | 'emit' | 'migrate' | 'doctor' | 'help' | 'version';
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

const valueOptions = new Set([
  'store', 'stores-from', 'client-id', 'app-config', 'api-version', 'owner', 'namespace', 'out',
]);
const booleanOptions = new Set([
  'apply', 'force', 'dry-run', 'json', 'validate', 'metaobjects', 'all-owners', 'all-namespaces',
  'liquid', 'help', 'version',
]);

async function main(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  if (args.command === 'help' || args.flags.has('help')) {
    process.stdout.write(await help());
    return 0;
  }
  if (args.command === 'version' || args.flags.has('version')) {
    process.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }
  // Alone it modifies nothing: there is no write for it to widen.
  if (args.flags.has('force') && !args.flags.has('apply') && args.command !== 'emit') {
    throw new Error('--force requires --apply');
  }
  if (args.command === 'compile') return compileCommand(args);
  if (args.command === 'emit') return emitCommand(args);
  if (args.command === 'pull') return pullCommand(args);
  if (args.command === 'migrate') return migrateCommand(args);
  if (args.command === 'doctor') return doctorCommand(args);
  return syncCommand(args);
}

// The one command that reaches Shopify without a store: shopify.dev proxies the type list to
// anyone. Kept out of sync so that no store operation depends on shopify.dev being up.
async function doctorCommand(args: Arguments): Promise<number> {
  if (args.positional.length > 0) throw new Error('doctor accepts no positional arguments');
  const report = await runDoctor(oneValue(args, 'api-version', false));
  output(args, { installed: await packageVersion(), ...report }, renderDoctor(report));
  return doctorExitCode(report);
}

function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${check.ok ? 'OK  ' : 'FAIL'} ${check.summary}`);
    for (const line of check.details) lines.push(`     ${line}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function syncCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'schema module');
  const schema = await loadSchema(path);
  if (args.flags.has('validate')) {
    // Every offender at once: one create rejected mid-run leaves a store half-applied
    // behind an error that reads transient.
    const violations = descriptionViolations(schema);
    if (violations.length > 0) {
      output(args, { status: 'invalid', violations }, `${violations.map((item) => `INVALID ${item}`).join('\n')}\n`);
      return 2;
    }
    output(args, { status: 'valid', metaobjects: schema.metaobjects.length, metafields: schema.metafields.length },
      `VALID ${schema.metaobjects.length} metaobject definition(s), ${schema.metafields.length} metafield definition(s)\n`);
    return 0;
  }
  const mode = modeFrom(args);
  const targets = await storeTargets(args);
  const result = await synchronizeFleet(targets, schema, mode, await connectorFrom(args, targets.length), {
    force: args.flags.has('force'),
  });
  output(args, result, renderFleet(result));
  return fleetExitCode(result);
}

async function pullCommand(args: Arguments): Promise<number> {
  if (args.positional.length > 0) throw new Error('pull accepts no positional arguments');
  const allOwners = args.flags.has('all-owners');
  const ownerValues = requireExactlyOne(args, 'owner', 'all-owners');
  const owners = (allOwners ? Object.keys(OWNER_TYPES) : ownerValues) as Owner[];
  for (const owner of owners) if (!(owner in OWNER_TYPES)) throw new Error(`unsupported owner: ${owner}`);
  const allNamespaces = args.flags.has('all-namespaces');
  const namespaces = requireExactlyOne(args, 'namespace', 'all-namespaces');
  const pulled = await pullSchema(await clientFrom(args), {
    owners,
    namespaces,
    allNamespaces,
    metaobjects: args.flags.has('metaobjects'),
  });
  const generated = generateSchemaModule(pulled);
  await deliver(args, {
    key: 'schema',
    value: generated,
    text: generated,
    notes: { key: 'excluded', identities: pulled.excluded },
  });
  return 0;
}

async function compileCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'schema or migration module');
  const value = await loadDefault(path);
  let compiled: unknown;
  if (isRecord(value) && value.__kind === SCHEMA_MARKER) compiled = compileSchema(value);
  else if (isRecord(value) && value.__kind === MIGRATION_MARKER) compiled = compileMigration(value);
  else throw new Error('default export is neither a schema nor a migration declaration');
  await deliver(args, { key: 'compiled', value: compiled, text: stringifyCanonical(compiled) });
  return 0;
}

async function emitCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'schema module');
  if (!args.flags.has('liquid')) throw new Error('emit requires an output format: --liquid');
  const { definitions, skipped } = emitLiquidMetafields(await loadSchema(path));
  const out = oneValue(args, 'out', false);
  if (out !== undefined) {
    await assertGeneratedTarget(resolve(process.cwd(), out), args.flags.has('force'));
  }
  await deliver(args, {
    key: 'definitions',
    value: definitions,
    text: stringifyCanonical(definitions),
    notes: { key: 'skipped', identities: skipped },
    overwrite: true,
  });
  return 0;
}

// The target is a regenerated editor cache, so emit replaces it. Anything that is not
// already one is refused rather than overwritten, until --force says otherwise.
async function assertGeneratedTarget(target: string, force: boolean): Promise<void> {
  if (force) return;
  let existing: string;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    parsed = undefined;
  }
  if (!isLiquidMetafieldsFile(parsed)) {
    throw new Error(`${target} exists and is not a generated metafields file; remove it first`);
  }
}

async function migrateCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'compiled migration');
  const migration = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8')) as unknown;
  assertCompiledMigration(migration);
  const mode = modeFrom(args);
  const result = await runMigration(await clientFrom(args), migration, mode);
  output(args, { mode, ...result }, [
    `MIGRATION ${result.id}`,
    `source=${result.source} pending=${result.pending} equal=${result.equal}`,
    `invalid=${result.invalid} conflicts=${result.conflicts} applied=${result.applied}`,
    '',
  ].join('\n'));
  return migrationExitCode(result);
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positional: string[] = [];
  let command: Arguments['command'] = 'sync';
  const rest = [...argv];
  const first = rest[0];
  if (first && ['sync', 'pull', 'compile', 'emit', 'migrate', 'doctor', 'help', 'version'].includes(first)) {
    command = rest.shift() as Arguments['command'];
  }
  while (rest.length > 0) {
    const argument = rest.shift();
    if (!argument) break;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const [rawName, inline] = argument.slice(2).split('=', 2);
    if (!rawName) throw new Error(`invalid option: ${argument}`);
    if (valueOptions.has(rawName)) {
      const value = inline ?? rest.shift();
      if (!value || value.startsWith('--')) throw new Error(`--${rawName} requires a value`);
      values.set(rawName, [...(values.get(rawName) ?? []), value]);
    } else if (booleanOptions.has(rawName)) {
      if (inline !== undefined) throw new Error(`--${rawName} does not accept a value`);
      flags.add(rawName);
    } else {
      throw new Error(`unknown option: --${rawName}`);
    }
  }
  return { command, positional, values, flags };
}

// --dry-run cancels whatever write was asked for, so the exact command line CI runs takes one
// appended flag to show what it would do.
function modeFrom(args: Arguments): SyncMode {
  return args.flags.has('apply') && !args.flags.has('dry-run') ? 'apply' : 'dry-run';
}

async function storeTargets(args: Arguments): Promise<StoreTarget[]> {
  const targets = new Map<string, StoreTarget>();
  for (const store of values(args, 'store')) targets.set(store.toLowerCase(), { store, explicit: true });
  const sweep = oneValue(args, 'stores-from', false);
  if (sweep !== undefined) {
    const text = await readFile(resolve(process.cwd(), sweep), 'utf8');
    for (const line of text.split('\n')) {
      const store = (line.split('#')[0] ?? '').trim().toLowerCase();
      if (store.length > 0 && !targets.has(store)) targets.set(store, { store, explicit: false });
    }
  }
  if (targets.size === 0) throw new Error('--store or --stores-from is required');
  return [...targets.values()];
}

// Most explicit source first. The app TOML the Shopify CLI already requires carries the client
// id, so a caller should not have to cut it out of the file to pass --client-id.
async function clientIdFrom(args: Arguments): Promise<string> {
  const explicit = oneValue(args, 'client-id', false);
  if (explicit !== undefined) return explicit;
  const appConfig = oneValue(args, 'app-config', false);
  if (appConfig !== undefined) return (await readAppConfig(resolve(process.cwd(), appConfig))).clientId;
  return process.env.SHOPIFY_APP_CLIENT_ID ?? '';
}

async function connectorFrom(args: Arguments, storeCount: number): Promise<Connect> {
  const apiVersion = oneValue(args, 'api-version', false) ?? DEFAULT_API_VERSION;
  // guarddog: the three documented auth inputs, read here only to reach the named stores.
  const clientId = await clientIdFrom(args);
  const clientSecret = process.env.SHOPIFY_APP_SECRET ?? ''; // guarddog: see above
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? ''; // guarddog: see above
  if (clientId.length > 0 && clientSecret.length > 0) {
    return async (store) => new AdminClient({
      store,
      apiVersion,
      token: await mintAccessToken({ store, clientId, clientSecret }),
    });
  }
  // Incomplete app credentials fall back rather than fail: a stray SHOPIFY_APP_CLIENT_ID in a
  // CI image must not break a command a static token can serve on its own.
  if (token.length > 0 && storeCount === 1) {
    return async (store) => new AdminClient({ store, token, apiVersion });
  }
  if (clientId.length > 0 || clientSecret.length > 0) {
    throw new Error('app auth needs both --client-id (or SHOPIFY_APP_CLIENT_ID) and SHOPIFY_APP_SECRET');
  }
  if (token.length === 0) {
    throw new Error('set SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_APP_CLIENT_ID and SHOPIFY_APP_SECRET');
  }
  throw new Error('SHOPIFY_ADMIN_ACCESS_TOKEN reaches one store; a fleet needs SHOPIFY_APP_CLIENT_ID and SHOPIFY_APP_SECRET');
}

async function clientFrom(args: Arguments): Promise<AdminClient> {
  return (await connectorFrom(args, 1))(oneValue(args, 'store', true));
}

function values(args: Arguments, name: string): string[] {
  return args.values.get(name) ?? [];
}

// emit regenerates an editor cache in place; pull and compile refuse to clobber anything.
async function writeOut(out: string, text: string, overwrite = false): Promise<void> {
  const path = resolve(process.cwd(), out);
  if (!overwrite) {
    const handle = await open(path, 'wx');
    await handle.writeFile(text);
    await handle.close();
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

// Every command that produces a document delivers it the same way, so one --json shape parses
// them all. Left-out identities join the object, or reach stderr to keep stdout pipeable.
interface Delivery {
  key: string;
  value: unknown;
  text: string;
  notes?: { key: string; identities: readonly string[] };
  overwrite?: boolean;
}

async function deliver(args: Arguments, delivery: Delivery): Promise<void> {
  const notes = delivery.notes ? { [delivery.notes.key]: delivery.notes.identities } : {};
  const out = oneValue(args, 'out', false);
  if (out !== undefined) {
    await writeOut(out, delivery.text, delivery.overwrite);
    output(args, { status: 'written', out, ...notes }, `WROTE ${out}\n`);
    return;
  }
  if (args.flags.has('json')) {
    output(args, { [delivery.key]: delivery.value, ...notes }, '');
    return;
  }
  process.stdout.write(delivery.text);
  for (const identity of delivery.notes?.identities ?? []) {
    process.stderr.write(`${delivery.notes?.key.toUpperCase()} ${identity}\n`);
  }
}

function requireExactlyOne(args: Arguments, name: string, allFlag: string): string[] {
  const selected = values(args, name);
  const all = args.flags.has(allFlag);
  if (all && selected.length > 0) throw new Error(`--${allFlag} and --${name} are mutually exclusive`);
  if (!all && selected.length === 0) throw new Error(`${args.command} requires --${name} or --${allFlag}`);
  return selected;
}

function oneValue(args: Arguments, name: string, required: true): string;
function oneValue(args: Arguments, name: string, required: false): string | undefined;
function oneValue(args: Arguments, name: string, required: boolean): string | undefined {
  const found = values(args, name);
  if (found.length > 1) throw new Error(`--${name} may be specified only once`);
  if (required && found.length === 0) throw new Error(`--${name} is required`);
  return found[0];
}

function onlyPositional(args: Arguments, label: string): string {
  if (args.positional.length !== 1) throw new Error(`${args.command} requires exactly one ${label}`);
  return args.positional[0] as string;
}

function output(args: Arguments, json: unknown, text: string): void {
  process.stdout.write(args.flags.has('json') ? stringifyCanonical(json) : text);
}

function renderFleet(result: FleetResult): string {
  const lines: string[] = [];
  for (const outcome of result.stores) {
    if (outcome.status !== 'planned') {
      const label = outcome.status === 'not-installed' ? 'NOT-INSTALLED' : 'UNREACHABLE';
      lines.push(`${label} ${outcome.store} ${outcome.code ?? 'error'}: ${outcome.reason ?? ''}`.trimEnd());
      continue;
    }
    lines.push(`STORE ${outcome.store}`);
    for (const item of outcome.plan?.items ?? []) lines.push(...renderItem(item));
    const updated = new Set(outcome.updated ?? []);
    const skipped = new Set(outcome.skipped ?? []);
    for (const entry of outcome.drift?.items ?? []) {
      // The reasons are already above, under the plan item; only a refusal repeats one, next to
      // the line that says what to do about it.
      if (updated.has(entry.item.identity)) lines.push(`UPDATED ${entry.item.identity}`);
      else if (!skipped.has(entry.item.identity)) lines.push(`UPDATE ${entry.item.identity}`);
      else lines.push(...renderSkipped(entry));
    }
    for (const identity of outcome.created ?? []) lines.push(`CREATED ${identity}`);
    if (outcome.refused !== undefined) lines.push(`REFUSED ${outcome.store}: ${outcome.refused}`);
  }
  lines.push('');
  return lines.join('\n');
}

// The refusal carries the teaching, so the generic flag name costs nothing. BLOCKED matters
// most: saying "--force cannot do this" is what stops someone reaching for it here.
function renderSkipped(entry: DriftItem): string[] {
  if (entry.blocked.length === 0) {
    return [
      `SKIPPED ${entry.item.identity}`,
      ...entry.needsForce.map((reason) => `  ${reason}`),
      '  re-run with --force to apply it',
    ];
  }
  const advice = [...new Set(entry.blocked.map((reason) => blockedAdvice(entry.item, reason)))];
  return [
    `BLOCKED ${entry.item.identity}`,
    ...entry.blocked.map((reason) => `  ${reason}`),
    ...advice.map((line) => `  ${line}`),
  ];
}

function renderItem(item: PlanItem): string[] {
  return [
    `${item.status} ${item.identity}`,
    ...item.reasons.map((reason) => `  ${reason}`),
    ...item.notices.map((notice) => `NOTICE ${notice}`),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function packageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as unknown;
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new Error('package.json has no version');
  }
  return value.version;
}

async function help(): Promise<string> {
  return `@notambourine/metafields ${await packageVersion()}

Usage:
  metafields <schema.ts> --validate
  metafields <schema.ts> --store <store.myshopify.com> [--json]
  metafields <schema.ts> --store <store.myshopify.com> --apply [--force] [--dry-run]
  metafields <schema.ts> --store <a> --store <b> --stores-from <stores.txt> [--apply]
  metafields pull --store <store.myshopify.com> --owner <owner> --namespace <namespace>
                  [--metaobjects] [--out <schema.ts>]
  metafields compile <schema-or-migration.ts> [--out <compiled.json>]
  metafields emit <schema.ts> --liquid [--out .shopify/metafields.json] [--force]
  metafields migrate <compiled-migration.json> --store <store.myshopify.com>
                     [--apply] [--dry-run] [--json]
  metafields doctor [--api-version <YYYY-MM>] [--json]

Options:
  --store <host>           Target store; repeat for a fleet
  --stores-from <file>     Sweep the stores listed one per line, '#' comments allowed
  --client-id <id>         App client id; wins over --app-config and SHOPIFY_APP_CLIENT_ID
  --app-config <path>      Read client_id from a Shopify app TOML
  --apply                  Make the store match the schema
  --force                  Apply updates that can break a live storefront or strand stored values
  --dry-run                Report the writes --apply would make and make none
  --api-version <YYYY-MM>  Shopify Admin API version (default: ${DEFAULT_API_VERSION})
  --all-owners             Pull every supported owner type
  --all-namespaces         Pull every merchant-owned namespace
  --liquid                 Emit Liquid editor metafield definitions
  --help                   Show help
  --version                Show version

Auth reads SHOPIFY_APP_CLIENT_ID and SHOPIFY_APP_SECRET to mint a short-lived Admin token
per store, or SHOPIFY_ADMIN_ACCESS_TOKEN for a single store. The client id can also come from
--client-id or --app-config ./shopify.app.toml; the secret is always an environment variable.
`;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  process.stderr.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
