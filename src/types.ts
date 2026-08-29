export const FIELD_MARKER = '@notambourine/metafields/field' as const;
export const METAOBJECT_MARKER = '@notambourine/metafields/metaobject' as const;
export const SCHEMA_MARKER = '@notambourine/metafields/schema' as const;

declare const brand: unique symbol;

export type Decimal = string & { readonly [brand]: 'Decimal' };
export type Url = string & { readonly [brand]: 'Url' };
export type RichText = object & { readonly [brand]: 'RichText' };
export type ProductReference = string & { readonly [brand]: 'ProductReference' };
export type VariantReference = string & { readonly [brand]: 'VariantReference' };
export type CollectionReference = string & { readonly [brand]: 'CollectionReference' };
export type FileReference = string & { readonly [brand]: 'FileReference' };
export type MetaobjectReference<Key extends string> = string & {
  readonly [brand]: 'MetaobjectReference';
  readonly __metaobjectType?: Key;
};

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

export interface TextOptions extends FieldOptions {
  readonly min?: number;
  readonly max?: number;
  readonly regex?: string;
  readonly choices?: readonly string[];
}

export interface NumberOptions extends FieldOptions {
  readonly min?: number | string;
  readonly max?: number | string;
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
    [N in keyof S['metafields'][O]]: {
      [K in keyof S['metafields'][O][N]]?: FieldValue<S['metafields'][O][N][K]>;
    };
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
