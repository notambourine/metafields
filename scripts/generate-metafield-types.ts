#!/usr/bin/env node
// Run against dist so generation and doctor share one registry client; scripts cannot import
// src under Node's type-stripping constraints.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_VERSION } from '../dist/admin.js';
import { fetchRegistry, type RegistryType } from '../dist/type-registry.js';

const OUT = fileURLToPath(new URL('../src/metafield-types.ts', import.meta.url));

type TypeRow = RegistryType;

// Single quotes, to match the rest of src/.
function quote(value: string): string {
  if (value.includes("'")) throw new Error(`unexpected quote in ${value}`);
  return `'${value}'`;
}

function property(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

function render(version: string, types: readonly TypeRow[], owners: readonly string[]): string {
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

const { version, types, owners } = await fetchRegistry(DEFAULT_API_VERSION).catch((error: unknown) => {
  console.error(`Cannot read the Admin API: ${error instanceof Error ? error.message : String(error)}`);
  console.error('If DEFAULT_API_VERSION in src/admin.ts has aged out, pin a supported one first.');
  process.exit(2);
});

const generated = render(version, types, owners);
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
    `${types.length} types, ${owners.length} owner types.`);
}
