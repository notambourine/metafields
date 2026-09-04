import type {
  CanonicalField,
  CanonicalMetafield,
  CanonicalMetaobject,
  CompiledSchema,
} from './schema.js';

export interface ExistingField {
  key: string;
  name: string;
  description?: string | null | undefined;
  type: string | { name: string };
  required?: boolean | undefined;
  validations?: readonly { name: string; value: string }[] | undefined;
  access?: Record<string, string | null>;
  capabilities?: Record<string, boolean>;
  constraints?: { key: string | null; values: readonly string[] } | null;
}

export interface ExistingMetafield extends ExistingField {
  id?: string;
  ownerType: string;
  namespace: string;
  validationStatus?: 'ALL_VALID' | 'IN_PROGRESS' | 'SOME_INVALID' | undefined;
  invalidCount?: number | undefined;
}

export interface ExistingMetaobject {
  id?: string;
  type: string;
  name: string;
  description?: string | null | undefined;
  displayNameKey?: string | null | undefined;
  access?: Record<string, string | null>;
  capabilities?: Record<string, boolean>;
  fields: ExistingField[];
}

export interface ExistingSchema {
  metaobjects: ExistingMetaobject[];
  metafields: ExistingMetafield[];
}

export type PlanStatus = 'CREATE' | 'PRESENT' | 'CONFLICT' | 'INDETERMINATE';

export type SyncMode = 'dry-run' | 'apply';

export interface PlanItem {
  kind: 'metaobject' | 'metafield';
  identity: string;
  status: PlanStatus;
  reasons: string[];
  notices: string[];
  desired: CanonicalMetaobject | CanonicalMetafield;
  existing?: ExistingMetaobject | ExistingMetafield;
}

export interface Plan {
  items: PlanItem[];
  creates: number;
  conflicts: number;
  indeterminate: number;
  notices: number;
}

function typeName(value: string | { name: string }): string {
  return typeof value === 'string' ? value : value.name;
}

function normalizedValue(validation: { name: string; value: string }): string {
  if (validation.name === 'choices' || validation.name.endsWith('_types') ||
      validation.name.endsWith('_ids')) {
    try {
      const parsed = JSON.parse(validation.value) as unknown;
      if (Array.isArray(parsed)) return JSON.stringify([...parsed].sort());
    } catch {
      return validation.value;
    }
  }
  if (validation.name === 'schema') {
    try {
      return JSON.stringify(sortJson(JSON.parse(validation.value) as unknown));
    } catch {
      return validation.value;
    }
  }
  return validation.value;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function normalizedValidations(values: readonly { name: string; value: string }[] = []): string {
  return JSON.stringify(values
    .map((value) => ({ name: value.name, value: normalizedValue(value) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value)));
}

function compareDeclared(
  label: string,
  desired: Record<string, string | boolean> | undefined,
  existing: Record<string, string | boolean | null> | undefined,
  reasons: string[],
): void {
  if (!desired) return;
  for (const [key, expected] of Object.entries(desired)) {
    const actual = existing?.[key];
    if (actual !== expected) reasons.push(`${label}.${key}: expected ${String(expected)}, found ${String(actual)}`);
  }
}

function compareField(
  desired: CanonicalField,
  existing: ExistingField,
  path: string,
  // The Admin API stores `required` only for metaobject fields.
  comparesRequired = true,
): string[] {
  const reasons: string[] = [];
  if (typeName(existing.type) !== desired.type) {
    reasons.push(`${path}.type: expected ${desired.type}, found ${typeName(existing.type)}`);
  }
  if (normalizedValidations(existing.validations) !== normalizedValidations(desired.validations)) {
    reasons.push(`${path}.validations differ`);
  }
  if (comparesRequired && desired.required !== undefined && Boolean(existing.required) !== desired.required) {
    reasons.push(`${path}.required: expected ${String(desired.required)}, found ${String(Boolean(existing.required))}`);
  }
  compareDeclared(`${path}.access`, desired.access, existing.access, reasons);
  compareDeclared(`${path}.capabilities`, desired.capabilities, existing.capabilities, reasons);
  if (desired.constraints !== undefined) {
    const actual = existing.constraints
      ? { key: existing.constraints.key, values: [...existing.constraints.values].sort() }
      : null;
    if (JSON.stringify(desired.constraints) !== JSON.stringify(actual)) {
      reasons.push(`${path}.constraints differ`);
    }
  }
  return reasons;
}

function cosmeticNotices(
  path: string,
  desired: { name: string; description?: string },
  existing: { name: string; description?: string | null | undefined },
): string[] {
  const notices: string[] = [];
  if (desired.name !== existing.name) notices.push(`${path}.name differs`);
  if (desired.description !== undefined && desired.description !== (existing.description ?? undefined)) {
    notices.push(`${path}.description differs`);
  }
  return notices;
}

export function planSchema(desired: CompiledSchema, existing: ExistingSchema): Plan {
  const items: PlanItem[] = [];
  const existingMetaobjects = new Map(existing.metaobjects.map((item) => [item.type, item]));
  for (const definition of desired.metaobjects) {
    const identity = `metaobject:${definition.type}`;
    const found = existingMetaobjects.get(definition.type);
    if (!found) {
      items.push({ kind: 'metaobject', identity, status: 'CREATE', reasons: [], notices: [], desired: definition });
      continue;
    }
    const reasons: string[] = [];
    if (definition.displayNameKey !== undefined && definition.displayNameKey !== found.displayNameKey) {
      reasons.push(`displayNameKey: expected ${definition.displayNameKey}, found ${String(found.displayNameKey)}`);
    }
    compareDeclared('access', definition.access, found.access, reasons);
    compareDeclared('capabilities', definition.capabilities, found.capabilities, reasons);
    const notices = cosmeticNotices(identity, definition, found);
    const fields = new Map(found.fields.map((field) => [field.key, field]));
    for (const field of definition.fields) {
      const existingField = fields.get(field.key);
      if (!existingField) {
        reasons.push(`fields.${field.key}: missing`);
        continue;
      }
      reasons.push(...compareField(field, existingField, `fields.${field.key}`));
      notices.push(...cosmeticNotices(`fields.${field.key}`, field, existingField));
    }
    items.push({
      kind: 'metaobject',
      identity,
      status: reasons.length > 0 ? 'CONFLICT' : 'PRESENT',
      reasons,
      notices,
      desired: definition,
      existing: found,
    });
  }

  const existingMetafields = new Map(existing.metafields.map((item) => [
    `${item.ownerType}:${item.namespace}.${item.key}`,
    item,
  ]));
  for (const definition of desired.metafields) {
    const key = `${definition.ownerType}:${definition.namespace}.${definition.key}`;
    const identity = `metafield:${key}`;
    const found = existingMetafields.get(key);
    if (!found) {
      items.push({ kind: 'metafield', identity, status: 'CREATE', reasons: [], notices: [], desired: definition });
      continue;
    }
    const reasons = compareField(definition, found, identity, false);
    let status: PlanStatus = reasons.length > 0 ? 'CONFLICT' : 'PRESENT';
    if (found.validationStatus === 'SOME_INVALID') {
      status = 'CONFLICT';
      reasons.push(`stored values include ${String(found.invalidCount ?? 'unknown')} invalid value(s)`);
    } else if (found.validationStatus === 'IN_PROGRESS') {
      status = 'INDETERMINATE';
      reasons.push('stored-value validation is in progress');
    }
    items.push({
      kind: 'metafield',
      identity,
      status,
      reasons,
      notices: cosmeticNotices(identity, definition, found),
      desired: definition,
      existing: found,
    });
  }

  return planFrom(items);
}

export function planFrom(items: PlanItem[]): Plan {
  return {
    items,
    creates: items.filter((item) => item.status === 'CREATE').length,
    conflicts: items.filter((item) => item.status === 'CONFLICT').length,
    indeterminate: items.filter((item) => item.status === 'INDETERMINATE').length,
    notices: items.reduce((count, item) => count + item.notices.length, 0),
  };
}

// Exit on operational drift in every mode; cosmetic notices do not count.
export function exitCodeForPlan(plan: Plan): number {
  if (plan.indeterminate > 0) return 2;
  if (plan.conflicts > 0 || plan.creates > 0) return 1;
  return 0;
}
