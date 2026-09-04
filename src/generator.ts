import { baseType, builderFor, REFERENCE_VALIDATIONS, VALIDATION_OPTIONS } from './declarable.js';
import type { ExistingField, ExistingMetafield, ExistingMetaobject } from './planner.js';
import { isReservedNamespace, type Owner } from './schema.js';
import { FIELD_CAPABILITIES, METAOBJECT_FIELD_CAPABILITIES, type Validation } from './types.js';

export interface PulledSchema {
  metaobjects: ExistingMetaobject[];
  metafields: (ExistingMetafield & { owner: Owner })[];
  excluded: string[];
}

export interface SkippedDefinition {
  identity: string;
  reason: string;
}

export interface GeneratedSchema {
  module: string;
  skipped: SkippedDefinition[];
}

type AnyField = ExistingField | (ExistingMetafield & { owner: Owner });

function quote(value: string): string {
  return JSON.stringify(value);
}

function property(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

// Parse scalar and measurement bounds; other validations already contain option-compatible JSON.
function renderValidation(name: string, value: string): string {
  if (name === 'regex') return quote(value);
  if (name !== 'min' && name !== 'max') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const numeric = Number(trimmed);
  return JSON.stringify(trimmed === '' || Number.isNaN(numeric) ? value : numeric);
}

function options(
  field: AnyField,
  validations: readonly Validation[],
  metaobjectField: boolean,
  attributes = true,
): string {
  const result: string[] = [];
  if (attributes) {
    if (field.name) result.push(`name: ${quote(field.name)}`);
    if (field.description) result.push(`description: ${quote(field.description)}`);
    if (field.required === true) result.push('required: true');
  }
  const validationMap = new Map(validations.map((item) => [item.name, item.value]));
  for (const [name, option] of Object.entries(VALIDATION_OPTIONS)) {
    const value = validationMap.get(name);
    if (value !== undefined) result.push(`${option}: ${renderValidation(name, value)}`);
  }
  if (attributes && !metaobjectField && 'access' in field && field.access) {
    const access = Object.entries(field.access)
      .filter(([key]) => key === 'admin' || key === 'storefront')
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}: ${quote(String(value).toLowerCase())}`);
    if (access.length > 0) result.push(`access: { ${access.join(', ')} }`);
  }
  if (attributes && 'capabilities' in field && field.capabilities) {
    const capabilities: readonly string[] = metaobjectField ? METAOBJECT_FIELD_CAPABILITIES : FIELD_CAPABILITIES;
    for (const key of capabilities) {
      if (field.capabilities[key] !== undefined) result.push(`${key}: ${String(field.capabilities[key])}`);
    }
  }
  if (attributes && !metaobjectField && 'constraints' in field && field.constraints?.key) {
    result.push(`constraints: { key: ${quote(field.constraints.key)}, values: ${JSON.stringify([...field.constraints.values].sort())} }`);
  }
  return result.length > 0 ? `{ ${result.join(', ')} }` : '';
}

// Pulled JSON definitions do not describe their value shape.
const TYPE_ARGUMENTS: Record<string, string> = { json: '<unknown>' };

type Expression = { code: string; reason?: undefined } | { code?: undefined; reason: string };

function referenceTargets(type: string, validations: readonly Validation[]): string[] | undefined {
  const value = validations.find((item) =>
    item.name === (type === 'mixed_reference' ? 'metaobject_definition_types' : 'metaobject_definition_type'),
  )?.value;
  if (value === undefined) return undefined;
  if (type !== 'mixed_reference') return [value];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : undefined;
}

function fieldExpression(
  field: AnyField,
  declared: ReadonlySet<string>,
  metaobjectField: boolean,
): Expression {
  const rawType = typeof field.type === 'string' ? field.type : field.type.name;
  const list = rawType.startsWith('list.');
  const type = baseType(rawType);
  const call = builderFor(type);
  if (!call) return { reason: `unsupported type: ${rawType}` };

  const all = field.validations ?? [];
  const args = [...call.args];
  if (type === 'metaobject_reference' || type === 'mixed_reference') {
    const targets = referenceTargets(type, all);
    if (!targets || targets.length === 0) {
      // Skip store-specific reference IDs until a pulled metaobject supplies a portable type.
      return {
        reason: all.some((entry) => entry.name.startsWith('metaobject_definition_id'))
          ? `${rawType} uses a store-specific definition ID; pass --metaobjects to resolve it`
          : `${rawType} has no metaobject type`,
      };
    }
    const missing = targets.filter((target) => !declared.has(target));
    if (missing.length > 0) {
      return { reason: `missing referenced metaobject: ${missing.join(', ')}` };
    }
    args.push(type === 'mixed_reference' ? JSON.stringify(targets) : quote(targets[0] as string));
  }

  const itemValidations = all.filter((entry) => !entry.name.startsWith('list.') && !REFERENCE_VALIDATIONS.has(entry.name));
  const undeclarable = itemValidations.find((entry) => !(entry.name in VALIDATION_OPTIONS));
  if (undeclarable) {
    return { reason: `unsupported ${undeclarable.name} validation on ${rawType}` };
  }

  const builder = `field.${call.name}${TYPE_ARGUMENTS[type] ?? ''}`;
  if (!list) {
    const fieldOptions = options(field, itemValidations, metaobjectField);
    return { code: `${builder}(${[...args, fieldOptions].filter((part) => part !== '').join(', ')})` };
  }
  const inner = `${builder}(${[...args, options(field, itemValidations, metaobjectField, false)].filter((part) => part !== '').join(', ')})`;
  const bounds = all
    .filter((entry) => entry.name.startsWith('list.'))
    .map((entry) => ({ name: entry.name.slice('list.'.length), value: entry.value }));
  const outer = options(field, bounds, metaobjectField);
  return { code: `field.list(${inner}${outer === '' ? '' : `, ${outer}`})` };
}

interface DeclaredMetaobject {
  definition: ExistingMetaobject;
  fields: { key: string; code: string }[];
}

interface Declarable {
  metaobjects: DeclaredMetaobject[];
  metafields: { field: ExistingMetafield & { owner: Owner }; code: string }[];
  skipped: SkippedDefinition[];
}

// Remove empty metaobjects and their stranded references until the schema stabilizes.
function declarable(pulled: PulledSchema): Declarable {
  const declared = new Set(pulled.metaobjects.map((definition) => definition.type));
  const dropped = new Map<string, string>();
  let metaobjects: DeclaredMetaobject[] = [];
  let skipped: SkippedDefinition[] = [];
  for (;;) {
    metaobjects = [];
    skipped = [];
    const emptied: string[] = [];
    for (const definition of pulled.metaobjects) {
      if (!declared.has(definition.type)) continue;
      const fields: DeclaredMetaobject['fields'] = [];
      const reasons: SkippedDefinition[] = [];
      for (const field of definition.fields) {
        const result = fieldExpression(field, declared, true);
        if (result.code !== undefined) fields.push({ key: field.key, code: result.code });
        else reasons.push({ identity: `metaobject:${definition.type}.${field.key}`, reason: result.reason });
      }
      if (fields.length > 0) {
        metaobjects.push({ definition, fields });
        skipped.push(...reasons);
        continue;
      }
      emptied.push(definition.type);
      dropped.set(definition.type, `no supported fields: ${reasons[0]?.reason ?? 'empty definition'}`);
    }
    if (emptied.length === 0) break;
    for (const type of emptied) declared.delete(type);
  }

  const metafields: Declarable['metafields'] = [];
  for (const field of pulled.metafields) {
    const result = fieldExpression(field, declared, false);
    if (result.code !== undefined) metafields.push({ field, code: result.code });
    else skipped.push({ identity: `${field.owner}:${field.namespace}.${field.key}`, reason: result.reason });
  }
  for (const [type, reason] of dropped) skipped.push({ identity: `metaobject:${type}`, reason });
  skipped.sort((a, b) => a.identity.localeCompare(b.identity));
  return { metaobjects, metafields, skipped };
}

export function generateSchemaModule(pulled: PulledSchema): GeneratedSchema {
  const { metaobjects, metafields, skipped } = declarable(pulled);
  const lines: string[] = [];
  if (skipped.length > 0) {
    lines.push(`// Omitted ${skipped.length} unsupported definition(s). See pull diagnostics.`, '');
  }
  lines.push(
    "import { defineSchema, field, metaobject } from '@notambourine/metafields';",
    '',
    'export default defineSchema({',
    '  metaobjects: {',
  );
  for (const { definition, fields } of [...metaobjects].sort((a, b) => a.definition.type.localeCompare(b.definition.type))) {
    const metaOptions = [`name: ${quote(definition.name)}`];
    if (definition.description) metaOptions.push(`description: ${quote(definition.description)}`);
    // Drop display keys that reference omitted fields.
    if (definition.displayNameKey && fields.some((field) => field.key === definition.displayNameKey)) {
      metaOptions.push(`displayNameKey: ${quote(definition.displayNameKey)}`);
    }
    if (definition.access) {
      const values = Object.entries(definition.access)
        .filter(([key]) => key === 'admin' || key === 'storefront')
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}: ${quote(String(value).toLowerCase())}`);
      if (values.length > 0) metaOptions.push(`access: { ${values.join(', ')} }`);
    }
    if (definition.capabilities) {
      const values = Object.entries(definition.capabilities).map(([key, value]) => `${key}: ${String(value)}`);
      if (values.length > 0) metaOptions.push(`capabilities: { ${values.join(', ')} }`);
    }
    lines.push(`    ${property(definition.type)}: metaobject({`);
    for (const option of metaOptions) lines.push(`      ${option},`);
    lines.push('      fields: {');
    for (const field of [...fields].sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(`        ${property(field.key)}: ${field.code},`);
    }
    lines.push('      },', '    }),');
  }
  lines.push('  },', '  metafields: {');
  const owners = groupBy(metafields, (entry) => entry.field.owner);
  for (const [owner, ownerFields] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${property(owner)}: {`);
    const namespaces = groupBy(ownerFields, (entry) => entry.field.namespace);
    for (const [namespace, fields] of [...namespaces].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`      ${property(namespace)}: {`);
      for (const entry of [...fields].sort((a, b) => a.field.key.localeCompare(b.field.key))) {
        lines.push(`        ${property(entry.field.key)}: ${entry.code},`);
      }
      lines.push('      },');
    }
    lines.push('    },');
  }
  lines.push('  },', '});', '');
  return { module: lines.join('\n'), skipped };
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const group = key(value);
    const existing = groups.get(group);
    if (existing) existing.push(value);
    else groups.set(group, [value]);
  }
  return groups;
}

export function filterPulledMetafields(
  fields: (ExistingMetafield & { owner: Owner })[],
): PulledSchema['metafields'] {
  return fields.filter((field) => !isReservedNamespace(field.namespace));
}
