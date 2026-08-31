import type { Validation } from './types.js';

// Shopify resolves a metaobject reference only by definition id; the documented type form covers
// app-reserved types alone, and a merchant type there reads as no validation at all. A schema that
// travels between stores can only name types, so the two forms are translated at the API boundary.
const STORE_NAMES: Record<string, string> = {
  metaobject_definition_type: 'metaobject_definition_id',
  metaobject_definition_types: 'metaobject_definition_ids',
};

const PORTABLE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(STORE_NAMES).map(([portable, store]) => [store, portable]),
);

function listValue(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed as string[]
      : null;
  } catch {
    return null;
  }
}

function toStoreValidations(
  validations: readonly Validation[],
  idByType: ReadonlyMap<string, string>,
): Validation[] {
  return validations.map((validation) => {
    const name = STORE_NAMES[validation.name];
    if (name === undefined) return validation;
    if (!validation.name.endsWith('_types')) {
      return { name, value: definitionId(validation.value, idByType) };
    }
    const types = listValue(validation.value) ?? [];
    return { name, value: JSON.stringify(types.map((type) => definitionId(type, idByType))) };
  });
}

// Whole definitions are translated once at the client boundary, so the GraphQL input builders
// stay a plain projection of the canonical shape.
export function toStoreField<T extends { validations: readonly Validation[] }>(
  definition: T,
  idByType: ReadonlyMap<string, string>,
): T {
  return { ...definition, validations: toStoreValidations(definition.validations, idByType) };
}

export function toStoreMetaobject<T extends { fields: readonly { validations: readonly Validation[] }[] }>(
  definition: T,
  idByType: ReadonlyMap<string, string>,
): T {
  return { ...definition, fields: definition.fields.map((field) => toStoreField(field, idByType)) };
}

export function toPortableField<T extends { validations?: readonly Validation[] | undefined }>(
  field: T,
  typeById: ReadonlyMap<string, string>,
): T {
  return { ...field, validations: toPortableValidations(field.validations, typeById) };
}

function toPortableValidations(
  validations: readonly Validation[] = [],
  typeById: ReadonlyMap<string, string>,
): Validation[] {
  return validations.map((validation) => {
    const name = PORTABLE_NAMES[validation.name];
    if (name === undefined) return validation;
    if (!validation.name.endsWith('_ids')) {
      const type = typeById.get(validation.value);
      return type === undefined ? validation : { name, value: type };
    }
    const ids = listValue(validation.value);
    const types = ids?.map((id) => typeById.get(id));
    if (!types || types.some((type) => type === undefined)) return validation;
    return { name, value: JSON.stringify([...types as string[]].sort()) };
  });
}

function definitionId(type: string, idByType: ReadonlyMap<string, string>): string {
  const id = idByType.get(type);
  if (id === undefined) {
    throw new Error(`metaobject ${type} has no definition on this store to reference`);
  }
  return id;
}
