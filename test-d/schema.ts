import {
  defineSchema,
  field,
  metaobject,
  type Decimal,
  type InferMetafields,
  type InferMetaobjects,
  type Measurement,
  type MetaobjectReference,
} from '../src/index.js';

const measurements = defineSchema({
  metaobjects: {},
  metafields: {
    product: {
      custom: {
        span: field.measurement('dimension', { min: { value: 1, unit: 'in' } }),
        price: field.money(),
        stars: field.rating({ scaleMin: 1, scaleMax: 5 }),
      },
    },
  },
});

const schema = defineSchema({
  metaobjects: {
    faq: metaobject({
      name: 'FAQ',
      displayNameKey: 'question',
      fields: {
        question: field.string({ required: true, min: 1 }),
        answer: field.richText(),
        rank: field.decimal(),
      },
    }),
  },
  metafields: {
    product: {
      custom: {
        faq: field.metaobject('faq'),
        payload: field.json<{ enabled: boolean }>(),
        prices: field.list(field.decimal()),
        sku: field.string({ required: true }),
      },
    },
  },
});

type Objects = InferMetaobjects<typeof schema>;
type Metafields = InferMetafields<typeof schema>;

const object: Objects['faq'] = { question: 'Why?' };
const decimal: Decimal | undefined = object.rank;
const reference: MetaobjectReference<'faq'> | undefined = ({} as Metafields).product.custom.faq;
const sku: string = ({} as Metafields).product.custom.sku;
void decimal;
void reference;
void sku;

// @ts-expect-error required metafields are not optional
const missingSku: Metafields['product']['custom'] = { payload: { enabled: true } };
void missingSku;

// @ts-expect-error required fields stay required
const missingQuestion: Objects['faq'] = {};
void missingQuestion;

metaobject({
  name: 'Invalid display key',
  // @ts-expect-error displayNameKey must name a declared field
  displayNameKey: 'missing',
  fields: { title: field.string() },
});

defineSchema({
  metaobjects: { faq: metaobject({ name: 'FAQ', fields: { title: field.string() } }) },
  metafields: {
    product: {
      custom: {
        // @ts-expect-error local references must target this schema
        invalid: field.metaobject('missing'),
      },
    },
  },
});

// @ts-expect-error numeric validations do not accept regex
field.integer({ regex: '^1$' });

// @ts-expect-error a rating carries the scale it was recorded on
field.rating({ scaleMin: 1 });

// @ts-expect-error the measurement type comes from the generated registry
field.measurement('furlongs');

const measured: Measurement | undefined = ({} as InferMetafields<typeof measurements>).product.custom.span;
void measured;
