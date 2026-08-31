import {
  FIELD_MARKER,
  METAOBJECT_MARKER,
  SCHEMA_MARKER,
  type CollectionReference,
  type Decimal,
  type FieldDefinition,
  type FieldOptions,
  type Fields,
  type FileReference,
  type JsonOptions,
  type ListOptions,
  type MetaobjectDefinition,
  type MetaobjectOptions,
  type MetaobjectReference,
  type Metafields,
  type Metaobjects,
  type NumberOptions,
  type ProductReference,
  type RichText,
  type SchemaDefinition,
  type TextOptions,
  type Url,
  type Validation,
  type ValidMetafields,
  type ValidMetaobjects,
  type VariantReference,
} from './types.js';

type RequiredFlag<O> = O extends { readonly required: true } ? true : false;

function validations(options: Record<string, unknown>, numeric = false): Validation[] {
  const result: Validation[] = [];
  for (const name of ['min', 'max', 'regex'] as const) {
    const value = options[name];
    if (value !== undefined) result.push({ name, value: String(value) });
  }
  if (options.choices !== undefined) {
    result.push({ name: 'choices', value: JSON.stringify(options.choices) });
  }
  if (options.schema !== undefined) {
    result.push({ name: 'schema', value: JSON.stringify(options.schema) });
  }
  return result;
}

function makeField<Value, const O extends FieldOptions, Targets extends string = never>(
  type: string,
  options: O,
  extraValidations: readonly Validation[] = [],
  targets: readonly Targets[] = [],
): FieldDefinition<Value, RequiredFlag<O>, Targets> {
  return {
    __kind: FIELD_MARKER,
    type,
    options,
    validations: [...validations(options as Record<string, unknown>), ...extraValidations],
    targets,
  };
}

export const field = {
  string<const O extends TextOptions = {}>(options = {} as O) {
    return makeField<string, O>('single_line_text_field', options);
  },
  text<const O extends TextOptions = {}>(options = {} as O) {
    return makeField<string, O>('multi_line_text_field', options);
  },
  richText<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<RichText, O>('rich_text_field', options);
  },
  integer<const O extends NumberOptions = {}>(options = {} as O) {
    return makeField<number, O>('number_integer', options);
  },
  decimal<const O extends NumberOptions = {}>(options = {} as O) {
    return makeField<Decimal, O>('number_decimal', options);
  },
  boolean<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<boolean, O>('boolean', options);
  },
  url<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<Url, O>('url', options);
  },
  json<Value = unknown, const O extends JsonOptions = JsonOptions>(options = {} as O) {
    return makeField<Value, O>('json', options);
  },
  product<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<ProductReference, O>('product_reference', options);
  },
  variant<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<VariantReference, O>('variant_reference', options);
  },
  collection<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<CollectionReference, O>('collection_reference', options);
  },
  file<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<FileReference, O>('file_reference', options);
  },
  metaobject<const Key extends string, const O extends FieldOptions = {}>(key: Key, options = {} as O) {
    return makeField<MetaobjectReference<Key>, O, Key>(
      'metaobject_reference',
      options,
      [{ name: 'metaobject_definition_type', value: key }],
      [key],
    );
  },
  mixedMetaobject<const Keys extends readonly [string, ...string[]], const O extends FieldOptions = {}>(
    keys: Keys,
    options = {} as O,
  ) {
    return makeField<MetaobjectReference<Keys[number]>, O, Keys[number]>(
      'mixed_reference',
      options,
      [{ name: 'metaobject_definition_types', value: JSON.stringify([...keys].sort()) }],
      keys,
    );
  },
  list<
    Value,
    InnerRequired extends boolean,
    Targets extends string,
    const O extends ListOptions = {},
  >(inner: FieldDefinition<Value, InnerRequired, Targets>, options = {} as O) {
    const listValidations = validations(options as Record<string, unknown>).map((validation) => ({
      ...validation,
      name: validation.name === 'min' || validation.name === 'max'
        ? `list.${validation.name}`
        : validation.name,
    }));
    const referenceValidations = inner.validations.filter((validation) =>
      validation.name.startsWith('metaobject_definition_'),
    );
    return {
      __kind: FIELD_MARKER,
      type: `list.${inner.type}`,
      options,
      validations: [...listValidations, ...referenceValidations],
      targets: inner.targets,
    } as FieldDefinition<Value[], RequiredFlag<O>, Targets>;
  },
};

export function metaobject<const F extends Fields>(
  definition: MetaobjectOptions<F>,
): MetaobjectDefinition<F> {
  return { __kind: METAOBJECT_MARKER, ...definition };
}

export function defineSchema<const M extends Metaobjects, const F extends Metafields>(
  schema: {
    readonly metaobjects: M & ValidMetaobjects<M, keyof M>;
    readonly metafields: F & ValidMetafields<F, keyof M>;
  },
): SchemaDefinition<M, F> {
  for (const [owner, namespaces] of Object.entries(schema.metafields)) {
    for (const [namespace, fields] of Object.entries(namespaces)) {
      for (const [key, definition] of Object.entries(fields)) {
        Object.defineProperty(definition, 'identity', {
          value: Object.freeze({ owner, namespace, key }),
          enumerable: true,
          configurable: false,
        });
      }
    }
  }
  return { __kind: SCHEMA_MARKER, ...schema };
}
