import {
  defineSchema,
  field,
  metaobject,
  type Decimal,
  type InferMetafields,
  type InferMetaobjects,
  type MetaobjectReference,
} from '../src/index.js';

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
      },
    },
  },
});

type Objects = InferMetaobjects<typeof schema>;
type Metafields = InferMetafields<typeof schema>;

const object: Objects['faq'] = { question: 'Why?' };
const decimal: Decimal | undefined = object.rank;
const reference: MetaobjectReference<'faq'> | undefined = ({} as Metafields).product!.custom!.faq;
void decimal;
void reference;

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
