import { VALIDATION_OPTIONS } from './declarable.js';
import {
  FIELD_MARKER,
  METAOBJECT_MARKER,
  SCHEMA_MARKER,
  type ArticleReference,
  type CollectionReference,
  type Color,
  type CompanyReference,
  type CustomerReference,
  type DateOnly,
  type DateOptions,
  type DateTime,
  type Decimal,
  type DecimalOptions,
  type FieldDefinition,
  type FieldOptions,
  type Fields,
  type FileReference,
  type Id,
  type Jurisdiction,
  type JsonOptions,
  type LanguageCode,
  type Link,
  type ListOptions,
  type Measurement,
  type MeasurementOptions,
  type MeasurementType,
  type MetaobjectDefinition,
  type MetaobjectOptions,
  type MetaobjectReference,
  type Metafields,
  type Metaobjects,
  type Money,
  type NumberOptions,
  type OrderReference,
  type PageReference,
  type PatternOptions,
  type ProductReference,
  type Rating,
  type RatingOptions,
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

function validations(options: Record<string, unknown>): Validation[] {
  const result: Validation[] = [];
  for (const [name, option] of Object.entries(VALIDATION_OPTIONS)) {
    const value = options[option];
    if (value === undefined) continue;
    result.push({ name, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
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
  decimal<const O extends DecimalOptions = {}>(options = {} as O) {
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
  money<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<Money, O>('money', options);
  },
  color<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<Color, O>('color', options);
  },
  date<const O extends DateOptions = {}>(options = {} as O) {
    return makeField<DateOnly, O>('date', options);
  },
  dateTime<const O extends DateOptions = {}>(options = {} as O) {
    return makeField<DateTime, O>('date_time', options);
  },
  rating<const O extends RatingOptions>(options: O) {
    return makeField<Rating, O>('rating', options);
  },
  link<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<Link, O>('link', options);
  },
  measurement<const T extends MeasurementType, const O extends MeasurementOptions = {}>(
    type: T,
    options = {} as O,
  ) {
    return makeField<Measurement, O>(type, options);
  },
  id<const O extends PatternOptions = {}>(options = {} as O) {
    return makeField<Id, O>('id', options);
  },
  language<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<LanguageCode, O>('language', options);
  },
  jurisdiction<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<Jurisdiction, O>('jurisdiction', options);
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
  article<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<ArticleReference, O>('article_reference', options);
  },
  page<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<PageReference, O>('page_reference', options);
  },
  order<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<OrderReference, O>('order_reference', options);
  },
  customer<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<CustomerReference, O>('customer_reference', options);
  },
  company<const O extends FieldOptions = {}>(options = {} as O) {
    return makeField<CompanyReference, O>('company_reference', options);
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
    // The list options bound how many entries a value may hold; the inner builder's validations
    // bound each entry, and Shopify accepts both on the same definition.
    return {
      __kind: FIELD_MARKER,
      type: `list.${inner.type}`,
      options,
      validations: [...listValidations, ...inner.validations],
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
