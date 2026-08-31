#!/usr/bin/env node
// Regenerates src/metafield-types.ts from Shopify's own list of metafield types.
//
// The Admin API exposes metafieldDefinitionTypes, and shopify.dev proxies it without a store,
// a token, or an app: the same endpoint @shopify/api-codegen-preset points graphql-codegen at.
// So the authoritative list is fetchable in CI, and the generated module is checked in, which
// keeps the network out of install and out of the test run.
//
//   node scripts/generate-metafield-types.ts            # rewrite src/metafield-types.ts
//   node scripts/generate-metafield-types.ts --check    # fail if it is stale

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../src/metafield-types.ts', import.meta.url));
const ADMIN = fileURLToPath(new URL('../src/admin.ts', import.meta.url));

interface TypeRow {
  name: string;
  category: string;
  supportsDefinitionMigrations: boolean;
  supportedValidations: { name: string; type: string }[];
}

// The proxy serves only the versions Shopify currently supports and answers
// {"error":"Invalid API version"} for the rest, so generating against the version we send is
// also the check that the version has not aged out.
async function apiVersion(): Promise<string> {
  const source = await readFile(ADMIN, 'utf8');
  const match = /DEFAULT_API_VERSION = '([^']+)'/.exec(source);
  if (!match?.[1]) throw new Error('cannot find DEFAULT_API_VERSION in src/admin.ts');
  return match[1];
}

async function query<T>(version: string, document: string): Promise<T> {
  const response = await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${version}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: document }),
  });
  if (!response.ok) throw new Error(`proxy answered HTTP ${response.status}`);
  const body = await response.json() as { data?: T; error?: string; errors?: unknown };
  if (body.error) throw new Error(`proxy rejected ${version}: ${body.error}`);
  if (!body.data) throw new Error(`proxy returned no data: ${JSON.stringify(body.errors)}`);
  return body.data;
}

// Single quotes, to match the rest of src/.
function quote(value: string): string {
  if (value.includes("'")) throw new Error(`unexpected quote in ${value}`);
  return `'${value}'`;
}

function property(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

function render(version: string, types: TypeRow[], owners: string[]): string {
  const rows = [...types].sort((a, b) => a.name.localeCompare(b.name)).map((type) => {
    const validations = [...type.supportedValidations]
      .map((validation) => validation.name)
      .sort()
      .map(quote);
    return `  ${property(type.name)}: { category: ${quote(type.category)}, ` +
      `migratable: ${String(type.supportsDefinitionMigrations)}, ` +
      `validations: [${validations.join(', ')}] },`;
  });
  return [
    `// Generated from the Admin API ${version} by scripts/generate-metafield-types.ts. Do not edit.`,
    '// Run `npm run generate:metafield-types` to refresh it.',
    '',
    'export interface MetafieldTypeInfo {',
    '  readonly category: string;',
    '  // Whether values that predate a definition can be adopted into one of this type. It is not',
    '  // a statement about retyping a definition that already exists, which Shopify never allows.',
    '  readonly migratable: boolean;',
    '  readonly validations: readonly string[];',
    '}',
    '',
    'export const METAFIELD_TYPES = {',
    ...rows,
    '} as const satisfies Record<string, MetafieldTypeInfo>;',
    '',
    'export type MetafieldTypeName = keyof typeof METAFIELD_TYPES;',
    '',
    'export const METAFIELD_OWNER_TYPES = [',
    ...[...owners].sort().map((owner) => `  ${quote(owner)},`),
    '] as const;',
    '',
    'export type MetafieldOwnerType = typeof METAFIELD_OWNER_TYPES[number];',
    '',
  ].join('\n');
}

const version = await apiVersion();
const { metafieldDefinitionTypes } = await query<{ metafieldDefinitionTypes: TypeRow[] }>(
  version,
  '{ metafieldDefinitionTypes { name category supportsDefinitionMigrations supportedValidations { name type } } }',
);
const { __type: ownerEnum } = await query<{ __type: { enumValues: { name: string }[] } | null }>(
  version,
  '{ __type(name: "MetafieldOwnerType") { enumValues { name } } }',
);
if (!ownerEnum) throw new Error('MetafieldOwnerType is missing from the schema');

const generated = render(version, metafieldDefinitionTypes, ownerEnum.enumValues.map((value) => value.name));
const current = await readFile(OUT, 'utf8').catch(() => '');

if (process.argv.includes('--check')) {
  if (current === generated) {
    console.log(`src/metafield-types.ts matches the Admin API ${version}.`);
  } else {
    console.error(
      `src/metafield-types.ts is stale against the Admin API ${version}.\n` +
      'Run `npm run generate:metafield-types` and commit the result.',
    );
    process.exitCode = 1;
  }
} else if (current === generated) {
  console.log(`src/metafield-types.ts already matches the Admin API ${version}.`);
} else {
  await writeFile(OUT, generated);
  console.log(`Wrote src/metafield-types.ts from the Admin API ${version}: ` +
    `${metafieldDefinitionTypes.length} types, ${ownerEnum.enumValues.length} owner types.`);
}
