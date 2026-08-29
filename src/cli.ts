#!/usr/bin/env node
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AdminClient, DEFAULT_API_VERSION, synchronize } from './admin.js';
import { generateSchemaModule } from './generator.js';
import { loadDefault, loadSchema } from './loader.js';
import {
  assertCompiledMigration,
  compileMigration,
  migrationExitCode,
  MIGRATION_MARKER,
  runMigration,
} from './migration.js';
import { emitLiquidMetafields, isLiquidMetafieldsFile } from './liquid.js';
import { exitCodeForPlan, type Plan } from './planner.js';
import { pullSchema } from './pull.js';
import { compileSchema, OWNER_TYPES, SCHEMA_MARKER, stringifyCanonical, type Owner } from './schema.js';

interface Arguments {
  command: 'sync' | 'pull' | 'compile' | 'emit' | 'migrate' | 'help' | 'version';
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

const valueOptions = new Set(['store', 'api-version', 'owner', 'namespace', 'out']);
const booleanOptions = new Set([
  'apply', 'check', 'json', 'validate', 'metaobjects', 'all-owners', 'all-namespaces', 'liquid',
  'help', 'version',
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
  if (args.flags.has('apply') && args.flags.has('check')) {
    throw new Error('--apply and --check are mutually exclusive');
  }
  if (args.command === 'compile') return compileCommand(args);
  if (args.command === 'emit') return emitCommand(args);
  if (args.command === 'pull') return pullCommand(args);
  if (args.command === 'migrate') return migrateCommand(args);
  return syncCommand(args);
}

async function syncCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'schema module');
  const schema = await loadSchema(path);
  if (args.flags.has('validate')) {
    output(args, { status: 'valid', metaobjects: schema.metaobjects.length, metafields: schema.metafields.length },
      `VALID ${schema.metaobjects.length} metaobject definition(s), ${schema.metafields.length} metafield definition(s)\n`);
    return 0;
  }
  const mode = modeFrom(args);
  const client = clientFrom(args);
  const result = await synchronize(client, schema, mode);
  const code = exitCodeForPlan(result.plan, mode);
  output(args, { mode, ...result }, renderPlan(result.plan, result.applied));
  return code;
}

async function pullCommand(args: Arguments): Promise<number> {
  if (args.positional.length > 0) throw new Error('pull accepts no positional arguments');
  const allOwners = args.flags.has('all-owners');
  const ownerValues = values(args, 'owner');
  if (allOwners && ownerValues.length > 0) throw new Error('--all-owners and --owner are mutually exclusive');
  if (!allOwners && ownerValues.length === 0) throw new Error('pull requires --owner or --all-owners');
  const owners = (allOwners ? Object.keys(OWNER_TYPES) : ownerValues) as Owner[];
  for (const owner of owners) if (!(owner in OWNER_TYPES)) throw new Error(`unsupported owner: ${owner}`);
  const allNamespaces = args.flags.has('all-namespaces');
  const namespaces = values(args, 'namespace');
  if (allNamespaces && namespaces.length > 0) throw new Error('--all-namespaces and --namespace are mutually exclusive');
  if (!allNamespaces && namespaces.length === 0) throw new Error('pull requires --namespace or --all-namespaces');
  const pulled = await pullSchema(clientFrom(args), {
    owners,
    namespaces,
    allNamespaces,
    metaobjects: args.flags.has('metaobjects'),
  });
  const generated = generateSchemaModule(pulled);
  const out = oneValue(args, 'out', false);
  if (out) {
    const handle = await open(resolve(process.cwd(), out), 'wx');
    await handle.writeFile(generated);
    await handle.close();
    output(args, { status: 'written', out, excluded: pulled.excluded }, `WROTE ${out}\n`);
  } else if (args.flags.has('json')) {
    output(args, { schema: generated, excluded: pulled.excluded }, '');
  } else {
    process.stdout.write(generated);
    for (const identity of pulled.excluded) process.stderr.write(`EXCLUDED ${identity}\n`);
  }
  return 0;
}

async function compileCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'schema or migration module');
  const value = await loadDefault(path);
  let compiled: unknown;
  if (isRecord(value) && value.__kind === SCHEMA_MARKER) compiled = compileSchema(value);
  else if (isRecord(value) && value.__kind === MIGRATION_MARKER) compiled = compileMigration(value);
  else throw new Error('default export is neither a schema nor a migration declaration');
  const text = stringifyCanonical(compiled);
  const out = oneValue(args, 'out', false);
  if (out) {
    const handle = await open(resolve(process.cwd(), out), 'wx');
    await handle.writeFile(text);
    await handle.close();
    process.stdout.write(`WROTE ${out}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

async function emitCommand(args: Arguments): Promise<number> {
  const path = onlyPositional(args, 'schema module');
  if (!args.flags.has('liquid')) throw new Error('emit requires an output format: --liquid');
  const { definitions, skipped } = emitLiquidMetafields(await loadSchema(path));
  const text = stringifyCanonical(definitions);
  const out = oneValue(args, 'out', false);
  if (!out) {
    process.stdout.write(text);
    for (const identity of skipped) process.stderr.write(`SKIPPED ${identity}\n`);
    return 0;
  }
  const target = resolve(process.cwd(), out);
  await assertGeneratedTarget(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  output(args, { status: 'written', out, skipped }, `WROTE ${out}\n`);
  return 0;
}

// The target is a regenerated editor cache, so emit replaces it. Anything that is not
// already one is refused rather than overwritten.
async function assertGeneratedTarget(target: string): Promise<void> {
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
  const result = await runMigration(clientFrom(args), migration, mode);
  output(args, { mode, ...result }, [
    `MIGRATION ${result.id}`,
    `source=${result.source} pending=${result.pending} equal=${result.equal}`,
    `invalid=${result.invalid} conflicts=${result.conflicts} applied=${result.applied}`,
    '',
  ].join('\n'));
  return migrationExitCode(result, mode);
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positional: string[] = [];
  let command: Arguments['command'] = 'sync';
  const rest = [...argv];
  const first = rest[0];
  if (first && ['sync', 'pull', 'compile', 'emit', 'migrate', 'help', 'version'].includes(first)) {
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

function modeFrom(args: Arguments): 'dry-run' | 'check' | 'apply' {
  if (args.flags.has('apply')) return 'apply';
  if (args.flags.has('check')) return 'check';
  return 'dry-run';
}

function clientFrom(args: Arguments): AdminClient {
  const store = oneValue(args, 'store', true);
  // guarddog: documented auth input, read here only to reach the store the user named.
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? '';
  return new AdminClient({
    store,
    token,
    apiVersion: oneValue(args, 'api-version', false) ?? DEFAULT_API_VERSION,
  });
}

function values(args: Arguments, name: string): string[] {
  return args.values.get(name) ?? [];
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

function renderPlan(plan: Plan, applied: string[]): string {
  const lines: string[] = [];
  for (const item of plan.items) {
    lines.push(`${item.status} ${item.identity}`);
    for (const reason of item.reasons) lines.push(`  ${reason}`);
    for (const notice of item.notices) lines.push(`NOTICE ${notice}`);
  }
  for (const identity of applied) lines.push(`APPLIED ${identity}`);
  lines.push('');
  return lines.join('\n');
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
  metafields <schema.ts> --store <store.myshopify.com> [--apply | --check] [--json]
  metafields pull --store <store.myshopify.com> --owner <owner> --namespace <namespace>
                  [--metaobjects] [--out <schema.ts>]
  metafields compile <schema-or-migration.ts> [--out <compiled.json>]
  metafields emit <schema.ts> --liquid [--out .shopify/metafields.json]
  metafields migrate <compiled-migration.json> --store <store.myshopify.com>
                     [--apply | --check] [--json]

Options:
  --api-version <YYYY-MM>  Shopify Admin API version (default: ${DEFAULT_API_VERSION})
  --all-owners             Pull every supported owner type
  --all-namespaces         Pull every merchant-owned namespace
  --liquid                 Emit Liquid editor metafield definitions
  --help                   Show help
  --version                Show version
`;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  process.stderr.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
