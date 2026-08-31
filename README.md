# @notambourine/metafields

Declare merchant-owned Shopify metafield and metaobject definitions in TypeScript, inspect drift,
and create only what is missing. The CLI never updates or deletes definitions during schema sync.

```ts
import { defineSchema, field, metaobject } from '@notambourine/metafields';

export default defineSchema({
  metaobjects: {
    faq: metaobject({
      name: 'FAQ',
      displayNameKey: 'question',
      fields: {
        question: field.string({ name: 'Question', required: true }),
        answer: field.richText({ name: 'Answer', required: true }),
      },
    }),
  },
  metafields: {
    product: {
      custom: {
        promo_text: field.string({ name: 'Promo text' }),
        faq: field.metaobject('faq', { name: 'FAQ' }),
      },
    },
  },
});
```

```sh
npx @notambourine/metafields ./schema.ts --validate
npx @notambourine/metafields ./schema.ts --store example.myshopify.com
npx @notambourine/metafields ./schema.ts --store example.myshopify.com --apply
npx @notambourine/metafields ./schema.ts --store example.myshopify.com --check
```

The default command is a dry run. Importing a TypeScript schema executes trusted local code, so
compile declarations to canonical JSON before a secret-bearing workflow consumes pull-request
output.

Schema modules use Node's built-in type stripping and must use erasable TypeScript syntax.

See `metafields --help` for `pull`, `compile`, `emit`, and migration commands.

## Auth

Set `SHOPIFY_APP_CLIENT_ID` (or pass `--client-id`) and `SHOPIFY_APP_SECRET`, and the CLI mints a
short-lived Admin token per store with the `client_credentials` grant. Two grant errors stay
distinct in the output because a fleet treats them differently: `app_not_installed` means the store
has not installed the app, `shop_not_permitted` means the app and the store are in different
organizations.

`SHOPIFY_ADMIN_ACCESS_TOKEN` still works, and reaches one store. App credentials win when both are
set. Minted tokens are never logged, and Shopify credential prefixes are redacted from errors.

## Fleets

`--store` repeats, and `--stores-from <file>` sweeps a list of stores, one per line, with `#`
comments:

```sh
metafields ./schema.ts --store flagship.myshopify.com --stores-from ./stores.txt --apply
```

- Every store is planned before any store is written to. A conflict on one store exits nonzero
  having written nothing, because creating on the others first half-applies the fleet.
- A swept store that cannot be reached is reported and does not abort the run, as long as one store
  could be planned. A swept store that has not installed the app is reported as `NOT-INSTALLED` and
  keeps the run green.
- A store named on the command line never fails quietly; only a swept store is downgraded.
- Writes run per store, so one store refusing does not stop the next, and every refusal is
  reported together.
- Exit is `2` if any store was unreachable or refused a write, even when every reached store came
  back clean.

## Types

The schema is the single declaration. Value types come back out of it with `InferMetafields` and
`InferMetaobjects`, and fields declared `required: true` are not optional in the inferred type:

```ts
type Product = InferMetafields<typeof schema>['product'];

const promo: string | undefined = product.custom.promo_text;
const sku: string = product.custom.sku; // declared required
```

## Liquid

`emit --liquid` writes `.shopify/metafields.json`, the file Shopify's Liquid language server reads
to complete and hover `product.metafields.custom.promo_text`:

```sh
metafields emit ./schema.ts --liquid --out .shopify/metafields.json
```

Generating it from the schema means completions work without a store login, and cover definitions
that are declared but not yet created. This drives editor assistance only: no theme-check rule
validates metafields, so nothing here fails a build.

The file's shape carries less than the schema does. It has no field for `required`, validations, or
access, it cannot represent metaobject definitions, and it has no group for `customer` or
`draft_order` metafields, which are reported as skipped. Treat it as a generated artifact: `emit`
replaces an existing one and refuses to overwrite a file it did not generate. Shopify's own
`shopify theme metafields pull` overwrites the same path, so do not hand-edit it.

## Behavior

- Dry run reports missing definitions without writing them.
- `--apply` creates missing metaobject definitions in dependency order, then metafield definitions.
- `--check` exits nonzero for missing or incompatible operational shape.
- Cosmetic name and description drift is reported but never changed.
- Existing definitions, values, and entries are never updated or deleted by schema sync.
- A description over 255 characters fails `--validate` and fails sync before the first request,
  listing every offender at once. The Admin API answers `TOO_LONG`, and one create rejected
  mid-run leaves a store half-applied behind an error that reads transient.

Exit `0` means the selected condition is satisfied, exit `1` means schema or migration drift, and
exit `2` means invalid input, indeterminate Shopify state, or an API failure.

`pull` requires explicit owners and namespaces:

```sh
metafields pull --store example.myshopify.com \
  --owner product --namespace custom --metaobjects --out schema.ts
```

The output path must not exist. Without `--out`, the generated module is written to stdout.

## Migrations

Migrations are declarative, copy-only, and compiled before credentials are introduced:

```ts
import { defineMigration, transforms } from '@notambourine/metafields';
import schema from './schema.js';

export default defineMigration({
  id: 'product-internet-url-v1',
  from: schema.metafields.product.custom.internet,
  to: schema.metafields.product.custom.internet_url,
  mode: 'copy',
  transform: transforms.url({
    allowedSchemes: ['http', 'https'],
    bareHost: 'reject',
    trim: true,
  }),
  onInvalid: 'fail',
  onTargetConflict: 'fail',
});
```

```sh
metafields compile ./migration.ts --out ./migration.json
metafields migrate ./migration.json --store example.myshopify.com
metafields migrate ./migration.json --store example.myshopify.com --apply
```

`0.0.x` is prerelease quality. Confirm owner scopes and behavior against a development store before
production use.
