import type { CompiledSchema } from './schema.js';

// The Admin API answers TOO_LONG past this. Consumers were hand-maintaining the number;
// owning it here lets a whole schema fail before the first create leaves a store half-applied.
export const DESCRIPTION_MAX_LENGTH = 255;

export function descriptionViolations(schema: CompiledSchema): string[] {
  const violations: string[] = [];
  const check = (path: string, description: string | undefined): void => {
    if (description !== undefined && description.length > DESCRIPTION_MAX_LENGTH) {
      violations.push(`${path}.description is ${description.length} characters, over the ${DESCRIPTION_MAX_LENGTH} the Admin API accepts`);
    }
  };
  for (const definition of schema.metaobjects) {
    const identity = `metaobject:${definition.type}`;
    check(identity, definition.description);
    for (const field of definition.fields) check(`${identity}.fields.${field.key}`, field.description);
  }
  for (const definition of schema.metafields) {
    check(`metafield:${definition.ownerType}:${definition.namespace}.${definition.key}`, definition.description);
  }
  return violations;
}

export function assertDescriptionLengths(schema: CompiledSchema): void {
  const violations = descriptionViolations(schema);
  if (violations.length > 0) throw new Error(violations.join('; '));
}
