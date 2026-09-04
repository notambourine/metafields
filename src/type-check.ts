// Recommend upgrades only when the bundled registry version is stale.

import { METAFIELD_OWNER_TYPES, METAFIELD_TYPES, type MetafieldTypeInfo } from './metafield-types.js';
import type { Registry, RegistryType } from './type-registry.js';

export interface TypeDifference {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly name: string;
  readonly detail?: string;
}

export interface TypeCheck {
  readonly version: string;
  readonly matches: boolean;
  readonly types: readonly TypeDifference[];
  readonly owners: readonly TypeDifference[];
}

function validationsOf(type: RegistryType): string[] {
  return type.supportedValidations.map((validation) => validation.name).sort();
}

// Compare only fields retained by the generated registry.
function changes(live: RegistryType, shipped: MetafieldTypeInfo): string[] {
  const differences: string[] = [];
  if (live.category !== shipped.category) {
    differences.push(`category ${shipped.category} -> ${live.category}`);
  }
  if (live.supportsDefinitionMigrations !== shipped.migratable) {
    differences.push(`migratable ${String(shipped.migratable)} -> ${String(live.supportsDefinitionMigrations)}`);
  }
  const now = validationsOf(live);
  const before = [...shipped.validations].sort();
  const added = now.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !now.includes(name));
  if (added.length > 0) differences.push(`validations +${added.join(' +')}`);
  if (removed.length > 0) differences.push(`validations -${removed.join(' -')}`);
  return differences;
}

function compareNames(live: readonly string[], shipped: readonly string[]): TypeDifference[] {
  const differences: TypeDifference[] = [];
  for (const name of [...live].sort()) {
    if (!shipped.includes(name)) differences.push({ kind: 'added', name });
  }
  for (const name of [...shipped].sort()) {
    if (!live.includes(name)) differences.push({ kind: 'removed', name });
  }
  return differences;
}

export function compareRegistry(registry: Registry): TypeCheck {
  const shipped: Record<string, MetafieldTypeInfo | undefined> = METAFIELD_TYPES;
  const types: TypeDifference[] = [];
  for (const type of [...registry.types].sort((a, b) => a.name.localeCompare(b.name))) {
    const known = shipped[type.name];
    if (!known) {
      types.push({ kind: 'added', name: type.name });
      continue;
    }
    const differences = changes(type, known);
    if (differences.length > 0) {
      types.push({ kind: 'changed', name: type.name, detail: differences.join(', ') });
    }
  }
  const live = new Set(registry.types.map((type) => type.name));
  for (const name of Object.keys(METAFIELD_TYPES).sort()) {
    if (!live.has(name)) types.push({ kind: 'removed', name });
  }
  const owners = compareNames(registry.owners, METAFIELD_OWNER_TYPES);
  return { version: registry.version, matches: types.length === 0 && owners.length === 0, types, owners };
}
