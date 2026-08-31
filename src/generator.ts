import type { ExistingMetafield, ExistingMetaobject } from './planner.js';
import { isReservedNamespace, type Owner } from './schema.js';

export interface PulledSchema {
  metaobjects: ExistingMetaobject[];
  metafields: (ExistingMetafield & { owner: Owner })[];
  excluded: string[];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function property(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

function options(field: ExistingMetafield | ExistingMetaobject['fields'][number], metaobjectField = false): string {
  const result: string[] = [];
  if (field.name) result.push(`name: ${quote(field.name)}`);
  if (field.description) result.push(`description: ${quote(field.description)}`);
  if (field.required === true) result.push('required: true');
  const validationMap = new Map(field.validations?.map((item) => [item.name, item.value]));
  for (const name of ['min', 'max'] as const) {
    const value = validationMap.get(name);
    if (value !== undefined) result.push(`${name}: ${JSON.stringify(Number.isNaN(Number(value)) ? value : Number(value))}`);
  }
  const regex = validationMap.get('regex');
  if (regex !== undefined) result.push(`regex: ${quote(regex)}`);
  const choices = validationMap.get('choices');
  if (choices !== undefined) result.push(`choices: ${choices}`);
  const jsonSchema = validationMap.get('schema');
  if (jsonSchema !== undefined) result.push(`schema: ${jsonSchema}`);
  if (!metaobjectField && 'access' in field && field.access) {
    const access = Object.entries(field.access)
      .filter(([key]) => key === 'admin' || key === 'storefront')
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}: ${quote(String(value).toLowerCase())}`);
    if (access.length > 0) result.push(`access: { ${access.join(', ')} }`);
  }
  if (!metaobjectField && 'capabilities' in field && field.capabilities) {
    for (const key of [
      'adminFilterable', 'analyticsQueryable', 'cartToOrderCopyable', 'smartCollectionCondition', 'uniqueValues',
    ] as const) {
      if (field.capabilities[key] !== undefined) result.push(`${key}: ${String(field.capabilities[key])}`);
    }
  }
  if (!metaobjectField && 'constraints' in field && field.constraints?.key) {
    result.push(`constraints: { key: ${quote(field.constraints.key)}, values: ${JSON.stringify([...field.constraints.values].sort())} }`);
  }
  return result.length > 0 ? `{ ${result.join(', ')} }` : '';
}

const builders: Record<string, string> = {
  single_line_text_field: 'string',
  multi_line_text_field: 'text',
  rich_text_field: 'richText',
  number_integer: 'integer',
  number_decimal: 'decimal',
  boolean: 'boolean',
  url: 'url',
  json: 'json<unknown>',
  product_reference: 'product',
  variant_reference: 'variant',
  collection_reference: 'collection',
  file_reference: 'file',
};

function fieldExpression(field: ExistingMetafield | ExistingMetaobject['fields'][number], metaobjectField = false): string {
  const rawType = typeof field.type === 'string' ? field.type : field.type.name;
  const list = rawType.startsWith('list.');
  const type = list ? rawType.slice(5) : rawType;
  const validations = new Map(field.validations?.map((item) => [item.name, item.value]));
  let expression: string;
  if (type === 'metaobject_reference') {
    const target = validations.get('metaobject_definition_type');
    if (!target) throw new Error(`${field.key}: metaobject reference has no portable type validation`);
    expression = `field.metaobject(${quote(target)})`;
  } else if (type === 'mixed_reference') {
    const value = validations.get('metaobject_definition_types');
    if (!value) throw new Error(`${field.key}: mixed reference has no portable type validation`);
    expression = `field.mixedMetaobject(${value})`;
  } else {
    const builder = builders[type];
    if (!builder) throw new Error(`${field.key}: unsupported Shopify type ${rawType}`);
    expression = `field.${builder}()`;
  }
  const fieldOptions = options(field, metaobjectField);
  if (fieldOptions && !list) expression = expression.replace(/\(\)$/, `(${fieldOptions})`);
  if (list) {
    const listValues = new Map(field.validations?.filter((item) => item.name.startsWith('list.'))
      .map((item) => [item.name.slice(5), item.value]));
    const listOptions = options({ ...field, validations: [...listValues].map(([name, value]) => ({ name, value })) }, metaobjectField);
    expression = `field.list(${expression}${listOptions ? `, ${listOptions}` : ''})`;
  }
  return expression;
}

export function generateSchemaModule(pulled: PulledSchema): string {
  const lines = [
    "import { defineSchema, field, metaobject } from '@notambourine/metafields';",
    '',
    'export default defineSchema({',
    '  metaobjects: {',
  ];
  for (const definition of [...pulled.metaobjects].sort((a, b) => a.type.localeCompare(b.type))) {
    const metaOptions = [`name: ${quote(definition.name)}`];
    if (definition.description) metaOptions.push(`description: ${quote(definition.description)}`);
    if (definition.displayNameKey) metaOptions.push(`displayNameKey: ${quote(definition.displayNameKey)}`);
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
    for (const field of [...definition.fields].sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(`        ${property(field.key)}: ${fieldExpression(field, true)},`);
    }
    lines.push('      },', '    }),');
  }
  lines.push('  },', '  metafields: {');
  const owners = groupBy(pulled.metafields, (field) => field.owner);
  for (const [owner, ownerFields] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${property(owner)}: {`);
    const namespaces = groupBy(ownerFields, (field) => field.namespace);
    for (const [namespace, fields] of [...namespaces].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`      ${property(namespace)}: {`);
      for (const field of [...fields].sort((a, b) => a.key.localeCompare(b.key))) {
        lines.push(`        ${property(field.key)}: ${fieldExpression(field)},`);
      }
      lines.push('      },');
    }
    lines.push('    },');
  }
  lines.push('  },', '});', '');
  return lines.join('\n');
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
