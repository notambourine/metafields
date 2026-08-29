import { defineSchema, field, metaobject } from '../dist/index.js';

export default defineSchema({
  metaobjects: {
    faq: metaobject({
      name: 'FAQ',
      displayNameKey: 'question',
      fields: { question: field.string({ required: true }) },
    }),
  },
  metafields: {
    product: {
      custom: { faq_ref: field.metaobject('faq', { name: 'FAQ' }) },
    },
  },
});
