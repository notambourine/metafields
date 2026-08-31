import { defineSchema, field } from '../dist/index.js';

// The customer metafield is one Liquid cannot represent, so emit reports it as left out.
export default defineSchema({
  metaobjects: {},
  metafields: {
    product: { custom: { blurb: field.string({ name: 'Blurb' }) } },
    customer: { custom: { tier: field.string({ name: 'Tier' }) } },
  },
});
