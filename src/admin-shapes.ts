import type { ExistingField, ExistingMetafield, ExistingMetaobject } from './planner.js';

export interface RawField {
  key: string;
  name: string;
  description?: string | null;
  type: { name: string };
  required?: boolean;
  validations: { name: string; value: string }[];
}

export interface RawMetafield extends RawField {
  id: string;
  namespace: string;
  ownerType: string;
  access: Record<string, string | null>;
  capabilities: Record<string, { enabled: boolean }>;
  constraints?: { key: string | null; values: { nodes: { value: string }[] } } | null;
  validationStatus: ExistingMetafield['validationStatus'];
  invalidCount: number;
}

export interface RawMetaobject {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  displayNameKey?: string | null;
  access: Record<string, string | null>;
  capabilities: { publishable: { enabled: boolean }; translatable: { enabled: boolean } };
  fieldDefinitions: RawField[];
}

export function mapField(value: RawField): ExistingField {
  return {
    key: value.key,
    name: value.name,
    description: value.description,
    type: value.type,
    required: value.required,
    validations: value.validations,
  };
}

export function mapMetafield(value: RawMetafield): ExistingMetafield {
  return {
    ...mapField(value),
    id: value.id,
    namespace: value.namespace,
    ownerType: value.ownerType,
    access: value.access,
    capabilities: Object.fromEntries(Object.entries(value.capabilities).map(([key, item]) => [key, item.enabled])),
    constraints: value.constraints
      ? { key: value.constraints.key, values: value.constraints.values.nodes.map((item) => item.value) }
      : null,
    validationStatus: value.validationStatus,
    invalidCount: value.invalidCount,
  };
}

export function mapMetaobject(value: RawMetaobject): ExistingMetaobject {
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    description: value.description,
    displayNameKey: value.displayNameKey,
    access: value.access,
    capabilities: {
      publishable: value.capabilities.publishable.enabled,
      translatable: value.capabilities.translatable.enabled,
    },
    fields: value.fieldDefinitions.map(mapField),
  };
}

// Read and pull select the same definitions, so the selections live with the shapes they decode:
// a capability Shopify adds is then one edit, not two that can silently disagree.
export const FIELD_SELECTION = `
  key name description type { name } required validations { name value }
`;

export const METAFIELD_SELECTION = `
  id namespace key ownerType name description type { name }
  validations { name value }
  access { admin storefront customerAccount }
  capabilities {
    adminFilterable { enabled }
    analyticsQueryable { enabled }
    cartToOrderCopyable { enabled }
    smartCollectionCondition { enabled }
    uniqueValues { enabled }
  }
  constraints { key values(first: 250) { nodes { value } } }
  validationStatus
  invalidCount: metafieldsCount(validationStatus: INVALID)
`;

export const METAOBJECT_SELECTION = `
  id type name description displayNameKey
  access { admin storefront }
  capabilities { publishable { enabled } translatable { enabled } }
  fieldDefinitions { ${FIELD_SELECTION} }
`;
