import type { METAFIELD_TYPES, MetafieldTypeName } from './metafield-types.js';

export const FIELD_MARKER = '@notambourine/metafields/field' as const;
export const METAOBJECT_MARKER = '@notambourine/metafields/metaobject' as const;
export const SCHEMA_MARKER = '@notambourine/metafields/schema' as const;

declare const brand: unique symbol;

export type Decimal = string & { readonly [brand]: 'Decimal' };
export type Url = string & { readonly [brand]: 'Url' };
export type RichText = object & { readonly [brand]: 'RichText' };
export type Money = object & { readonly [brand]: 'Money' };
export type Color = string & { readonly [brand]: 'Color' };
export type DateOnly = string & { readonly [brand]: 'DateOnly' };
export type DateTime = string & { readonly [brand]: 'DateTime' };
export type Rating = object & { readonly [brand]: 'Rating' };
export type Link = object & { readonly [brand]: 'Link' };
export type Measurement = object & { readonly [brand]: 'Measurement' };
export type Id = string & { readonly [brand]: 'Id' };
export type LanguageCode = string & { readonly [brand]: 'LanguageCode' };
export type Jurisdiction = string & { readonly [brand]: 'Jurisdiction' };
export type ProductReference = string & { readonly [brand]: 'ProductReference' };
export type VariantReference = string & { readonly [brand]: 'VariantReference' };
export type CollectionReference = string & { readonly [brand]: 'CollectionReference' };
export type FileReference = string & { readonly [brand]: 'FileReference' };
export type ArticleReference = string & { readonly [brand]: 'ArticleReference' };
export type PageReference = string & { readonly [brand]: 'PageReference' };
export type OrderReference = string & { readonly [brand]: 'OrderReference' };
export type CustomerReference = string & { readonly [brand]: 'CustomerReference' };
export type CompanyReference = string & { readonly [brand]: 'CompanyReference' };
export type MetaobjectReference<Key extends string> = string & {
  readonly [brand]: 'MetaobjectReference';
  readonly __metaobjectType?: Key;
};

// Measurements differ only by unit, so the registry names them rather than a builder each: a unit
// Shopify adds becomes declarable as soon as the generated table is refreshed.
export type MeasurementType = {
  [K in MetafieldTypeName]: K extends `list.${string}`
    ? never
    : (typeof METAFIELD_TYPES)[K]['category'] extends 'MEASUREMENT' ? K : never;
}[MetafieldTypeName];

export interface Validation {
  readonly name: string;
  readonly value: string;
}

export interface FieldOptions {
  readonly name?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly access?: {
    readonly admin?: 'merchant_read' | 'merchant_read_write';
    readonly storefront?: 'none' | 'public_read';
  };
  readonly adminFilterable?: boolean;
  readonly analyticsQueryable?: boolean;
  readonly cartToOrderCopyable?: boolean;
  readonly smartCollectionCondition?: boolean;
  readonly uniqueValues?: boolean;
  readonly constraints?: {
    readonly key: string;
    readonly values: readonly string[];
  };
}

export interface PatternOptions extends FieldOptions {
  readonly min?: number;
  readonly max?: number;
  readonly regex?: string;
}

export interface TextOptions extends PatternOptions {
  readonly choices?: readonly string[];
}

export interface NumberOptions extends FieldOptions {
  readonly min?: number | string;
  readonly max?: number | string;
}

export interface DecimalOptions extends NumberOptions {
  readonly maxPrecision?: number;
}

export interface DateOptions extends FieldOptions {
  readonly min?: string;
  readonly max?: string;
}

// Shopify stores a rating alongside the scale it was recorded on, and rejects a definition that
// omits either bound.
export interface RatingOptions extends FieldOptions {
  readonly scaleMin: number;
  readonly scaleMax: number;
}

export interface MeasurementValue {
  readonly value: number;
  readonly unit: string;
}

export interface MeasurementOptions extends FieldOptions {
  readonly min?: MeasurementValue;
  readonly max?: MeasurementValue;
}

export interface JsonOptions extends FieldOptions {
  readonly schema?: object;
}

export interface ListOptions extends FieldOptions {
  readonly min?: number;
  readonly max?: number;
}

export interface FieldDefinition<
  Value = unknown,
  Required extends boolean = boolean,
  Targets extends string = never,
> {
  readonly __kind: typeof FIELD_MARKER;
  readonly type: string;
  readonly options: FieldOptions;
  readonly validations: readonly Validation[];
  readonly targets: readonly Targets[];
  readonly identity?: {
    readonly owner: string;
    readonly namespace: string;
    readonly key: string;
  };
  readonly __value?: Value;
  readonly __required?: Required;
}

export type Fields = Readonly<Record<string, FieldDefinition<any, any, any>>>;

export interface MetaobjectOptions<F extends Fields = Fields> {
  readonly name: string;
  readonly description?: string;
  readonly displayNameKey?: keyof F & string;
  readonly access?: {
    readonly admin?: 'merchant_read' | 'merchant_read_write';
    readonly storefront?: 'none' | 'public_read';
  };
  readonly capabilities?: {
    readonly publishable?: boolean;
    readonly translatable?: boolean;
  };
  readonly fields: F;
}

export interface MetaobjectDefinition<F extends Fields = Fields> extends MetaobjectOptions<F> {
  readonly __kind: typeof METAOBJECT_MARKER;
}

export type Metaobjects = Readonly<Record<string, MetaobjectDefinition<any>>>;
export type Metafields = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, FieldDefinition<any, any, any>>>>>>
>;

export interface SchemaDefinition<
  M extends Metaobjects = Metaobjects,
  F extends Metafields = Metafields,
> {
  readonly __kind: typeof SCHEMA_MARKER;
  readonly metaobjects: M;
  readonly metafields: F;
}

type FieldValue<F> = F extends FieldDefinition<infer V, infer _R, infer _T> ? V : never;
type IsRequired<F> = F extends FieldDefinition<infer _V, infer R, infer _T> ? R : false;
type RequiredKeys<F extends Fields> = {
  [K in keyof F]-?: IsRequired<F[K]> extends true ? K : never;
}[keyof F];
type OptionalKeys<F extends Fields> = Exclude<keyof F, RequiredKeys<F>>;

export type InferFields<F extends Fields> = {
  [K in RequiredKeys<F>]: FieldValue<F[K]>;
} & {
  [K in OptionalKeys<F>]?: FieldValue<F[K]>;
};

export type InferMetaobjects<S extends SchemaDefinition> = {
  [K in keyof S['metaobjects']]: InferFields<S['metaobjects'][K]['fields']>;
};

export type InferMetafields<S extends SchemaDefinition> = {
  [O in keyof S['metafields']]: {
    [N in keyof S['metafields'][O]]: S['metafields'][O][N] extends Fields
      ? InferFields<S['metafields'][O][N]>
      : never;
  };
};

type ValidReference<F, Keys extends PropertyKey> =
  F extends FieldDefinition<infer _V, infer _R, infer Targets>
    ? Exclude<Targets, Keys> extends never
      ? F
      : never
    : never;

export type ValidMetafields<F extends Metafields, Keys extends PropertyKey> = {
  [O in keyof F]: {
    [N in keyof F[O]]: {
      [K in keyof F[O][N]]: ValidReference<F[O][N][K], Keys>;
    };
  };
};

export type ValidMetaobjects<M extends Metaobjects, Keys extends PropertyKey> = {
  [K in keyof M]: Omit<M[K], 'fields'> & {
    readonly fields: {
      [F in keyof M[K]['fields']]: ValidReference<M[K]['fields'][F], Keys>;
    };
  };
};
