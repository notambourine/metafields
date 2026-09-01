# @notambourine/metafields

Version Shopify metafield and metaobject definitions in TypeScript, preview store drift, and apply supported changes. The CLI never deletes or retypes definitions. Requires Node.js 22.18+.

## Define and sync a schema

Install the package, then create `schema.ts`:

```sh
npm install --save-dev @notambourine/metafields
```

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
    product: { custom: {
      promo_text: field.string({ name: 'Promo text' }),
      faq: field.metaobject('faq', { name: 'FAQ' }),
    } },
  },
});
```

Validate locally, authenticate, preview drift, then apply the same plan:

```sh
npx metafields ./schema.ts --validate
export SHOPIFY_ADMIN_ACCESS_TOKEN=...
npx metafields ./schema.ts --store example.myshopify.com
npx metafields ./schema.ts --store example.myshopify.com --apply
```

Schema modules execute as trusted local code. For untrusted declarations, compile before introducing credentials:

```sh
npx metafields compile ./schema.ts --out ./schema.json
```

## Change policy

Each definition is atomic: if one attribute is blocked, its other changes wait. Other definitions continue independently.

| Change | Required mode |
| --- | --- |
| Create a definition or add a field | `--apply` |
| Change labels, `displayNameKey`, or enable a capability | `--apply` |
| Change access, validation, constraints, `required`, or disable a capability | `--apply --force` |
| Delete, retype, override invalid values, or bypass Shopify validation | Unsupported |

`--force` accepts storefront and stored-value risk; it does not override Shopify. `--dry-run` cancels requested writes without changing the plan or exit code. Mutations retry only Shopify's explicit `THROTTLED` response because retrying ambiguous failures could duplicate a completed write.

Exit codes describe store state: `0` matches, `1` has actionable drift, and `2` is invalid, indeterminate, or failed. Cosmetic label drift does not fail. Migration code `1` means rows remain pending.

## Schema API

Field builders:

- Values: `string`, `text`, `richText`, `integer`, `decimal`, `boolean`, `url`, `json`, `money`, `color`, `date`, `dateTime`, `rating`, `link`, `id`, `language`, `jurisdiction`, and `measurement`.
- References: `product`, `variant`, `collection`, `file`, `article`, `page`, `order`, `customer`, `company`, `metaobject`, and `mixedMetaobject`.
- Lists: wrap a builder with `field.list()`.

Options are type-checked by each builder. Examples include `field.measurement('weight')`, `field.file({ fileTypes: ['Image'] })`, and `field.url({ allowedDomains: ['example.com'] })`.

Metaobject references name portable types in the schema; the CLI resolves their store-specific IDs and creates dependencies first. Shopify-owned disclosure and taxonomy references are not portable and cannot be declared.

Infer application types directly from the schema:

```ts
import type { InferMetafields, InferMetaobjects } from '@notambourine/metafields';
import schema from './schema.js';

type ProductMetafields = InferMetafields<typeof schema>['product'];
type Faq = InferMetaobjects<typeof schema>['faq'];
```

## Other workflows

| Goal | Command |
| --- | --- |
| Sync a fleet | `npx metafields schema.ts --store a.myshopify.com --stores-from stores.txt --apply` |
| Pull selected store definitions | `npx metafields pull --store example.myshopify.com --owner product --namespace custom --metaobjects --out schema.ts` |
| Emit Liquid editor metadata | `npx metafields emit schema.ts --liquid --out .shopify/metafields.json` |
| Check the Shopify API type registry | `npx metafields doctor --api-version 2026-07` |
| Print all commands and options | `npx metafields --help` |

Fleet files contain one store per line and support `#` comments. Directly named stores fail when unreachable; swept stores without the app report `NOT-INSTALLED` and do not fail the fleet.

Each store reports one line per definition it creates, updates, skips, or blocks, each naming the metafield type or metaobject field count, and counts the definitions that already match on the `STORE` line. Use `--json` for the complete plan.

Pull requires explicit owners and namespaces, or their `--all-*` flags. It emits representable definitions and reports the rest under `skipped` and reserved namespaces under `excluded`. Without `--metaobjects`, metaobject references are skipped. Pull and compile never overwrite output files.

Liquid output contains only editor-supported metafields. It omits metaobjects, customer and draft-order metafields, access, validation, constraints, and `required`. Emit overwrites only recognized generated output unless passed `--force`.

## Authentication and output

For one store, set `SHOPIFY_ADMIN_ACCESS_TOKEN`. For one store or a fleet, set `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_SECRET`; the CLI mints a short-lived token per store. The client ID resolves from `--client-id`, `--app-config`, then the environment. Complete app credentials take priority over a static token, and credentials are redacted from errors.

Operational commands support `--json`, producing one JSON object on stdout. In text mode, generated documents use stdout while `excluded` and `skipped` identities use stderr. `--out` reports a small written status instead of the document.

## Copy values to a replacement definition

Migrations copy values; they never retype or delete the source. Define endpoints from the schema and use a package transform:

```ts
import { defineMigration, transforms } from '@notambourine/metafields';
import schema from './schema.js';

export default defineMigration({
  id: 'product-internet-url-v1',
  from: schema.metafields.product.custom.internet,
  to: schema.metafields.product.custom.internet_url,
  mode: 'copy',
  transform: transforms.url({ allowedSchemes: ['http', 'https'], bareHost: 'reject', trim: true }),
  onInvalid: 'fail',
  onTargetConflict: 'fail',
});
```

Compile without credentials, preview, then apply:

```sh
npx metafields compile migration.ts --out migration.json
npx metafields migrate migration.json --store example.myshopify.com
npx metafields migrate migration.json --store example.myshopify.com --apply
```

This `0.x` package is prerelease quality. Verify scopes and behavior on a development store before production use.
