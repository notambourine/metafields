# @notambourine/metafields

Define Shopify metafields and metaobjects in TypeScript. Preview store drift and apply supported changes. The CLI does not delete or retype definitions. Requires Node.js 22.18+.

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

Schema modules execute as local code. Compile untrusted declarations before setting credentials:

```sh
npx metafields compile ./schema.ts --out ./schema.json
```

## Change policy

Updates are atomic per definition. One blocked attribute defers the entire definition. Other definitions continue.

| Change | Required mode |
| --- | --- |
| Create a definition or add a field | `--apply` |
| Change a definition or field label, `displayNameKey`, or enable a capability | `--apply` |
| Change access, validation, constraints, `required`, or disable a capability | `--apply --force` |
| Delete, retype, override invalid values, or bypass Shopify validation | Unsupported |

`--force` permits storefront and stored-value risk but cannot override Shopify. `--dry-run` cancels writes without changing the plan or exit code. Mutations retry only Shopify's explicit `THROTTLED` response; retrying ambiguous failures could duplicate a completed write.

Exit codes describe store state: `0` matches, `1` has actionable drift, and `2` is invalid, indeterminate, or failed. Cosmetic label drift does not fail. Migration exit code `1` means rows remain pending.

## Schema API

Field builders:

- Values: `string`, `text`, `richText`, `integer`, `decimal`, `boolean`, `url`, `json`, `money`, `color`, `date`, `dateTime`, `rating`, `link`, `id`, `language`, `jurisdiction`, and `measurement`.
- References: `product`, `variant`, `collection`, `file`, `article`, `page`, `order`, `customer`, `company`, `metaobject`, and `mixedMetaobject`.
- Lists: wrap a builder with `field.list()`.

Options are type-checked by each builder. Examples include `field.measurement('weight')`, `field.file({ fileTypes: ['Image'] })`, and `field.url({ allowedDomains: ['example.com'] })`.

A metaobject field supports `adminFilterable`, but not `access`, `constraints`, or metafield-only capabilities. Compilation rejects unsupported options.

Metaobject references use portable types. The CLI resolves store-specific IDs and creates dependencies first. Shopify-owned disclosure and taxonomy references cannot be declared portably.

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

Fleet files contain one store per line and support `#` comments. Unreachable explicit stores fail. Swept stores without the app report `NOT-INSTALLED` without failing the fleet.

Each store reports created, updated, skipped, or blocked definitions with their metafield type or metaobject field count. The `STORE` line counts matching definitions. `--json` includes each definition's status, reasons, and drift buckets without repeating the input schema.

Pull requires explicit owners and namespaces or their `--all-*` flags. It reports unrepresentable definitions under `skipped` and reserved namespaces under `excluded`. Without `--metaobjects`, it skips metaobject references. Pull and compile do not overwrite output files.

Liquid output includes only editor-supported metafields. It omits metaobjects, customer and draft-order metafields, access, validation, constraints, and `required`. Emit overwrites recognized generated output; other files require `--force`.

## Authentication and output

For one store, set `SHOPIFY_ADMIN_ACCESS_TOKEN`. For one store or a fleet, set `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_SECRET`; the CLI creates a short-lived token per store. The client ID resolves from `--client-id`, `--app-config`, then the environment. Complete app credentials take priority over a static token. Errors redact credentials.

Operational commands support `--json` and write one JSON object to stdout. In text mode, generated documents use stdout while `excluded` and `skipped` identities use stderr. With `--out`, the CLI reports the written path instead of the document.

## Copy values to a replacement definition

Migrations copy values without retyping or deleting the source. Define endpoints from the schema and use a package transform:

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
