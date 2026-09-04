import { defineSchema, field } from '../dist/index.js';

export default defineSchema({
  metaobjects: {},
  metafields: {
    product: { custom: { blurb: field.string({ name: 'Blurb' }) } },
    customer: { custom: { tier: field.string({ name: 'Tier' }) } },
  },
});
