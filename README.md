# @notambourine/metafields

Declare Shopify metafield and metaobject definitions in TypeScript, inspect store drift, and apply
controlled changes. The CLI never deletes or retypes a definition.

Requires Node.js 22.18 or newer.

## Quick start

Create `schema.ts`:

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

Validate it, inspect a store, then apply the plan:

```sh
npx @notambourine/metafields ./schema.ts --validate
npx @notambourine/metafields ./schema.ts --store example.myshopify.com
npx @notambourine/metafields ./schema.ts --store example.myshopify.com --apply
```

Schema modules run as trusted local code through Node's type stripping. Use erasable TypeScript
syntax. Compile untrusted pull-request declarations before a credentialed workflow consumes them:

```sh
npx @notambourine/metafields compile ./schema.ts --out ./schema.json
```

## Changes and safety

Without `--apply`, the CLI only reports drift. A definition is updated as one unit: if any part is
blocked or needs `--force`, its other changes wait too. Other definitions continue independently.

| Change | Required mode |
| --- | --- |
| Create a definition or add a metaobject field | `--apply` |
| Update labels, `displayNameKey`, or enable a capability | `--apply` |
| Change access, validations, constraints, or `required` | `--apply --force` |
| Disable a capability | `--apply --force` |
| Delete or retype a definition | Never performed |
| Change invalid values or a definition Shopify is still validating | Never performed |

`--force` opts into changes that can break a storefront or strand stored values. For schema sync it
requires `--apply`; it cannot override Shopify constraints or repair data.

Use `--dry-run` to cancel requested writes while preserving the plan and exit code:

```sh
npx @notambourine/metafields ./schema.ts \
  --store example.myshopify.com --apply --force --dry-run
```

Exit codes describe the result:

- `0`: the store matches the schema.
- `1`: actionable drift remains.
- `2`: input is invalid, Shopify state is indeterminate, or an operation failed.

Cosmetic label drift does not change the exit code. Mutations retry Shopify's explicit
`THROTTLED` response, but are not retried after a timeout or `5xx` because the first request may
have landed.

## Authentication

For one store, set an Admin API token:

```sh
export SHOPIFY_ADMIN_ACCESS_TOKEN=...
```

For one store or a fleet, set app credentials. The CLI mints a short-lived token for each store:

```sh
export SHOPIFY_APP_CLIENT_ID=...
export SHOPIFY_APP_SECRET=...
```

The client ID is resolved from `--client-id`, then `--app-config`, then
`SHOPIFY_APP_CLIENT_ID`. The secret is read only from `SHOPIFY_APP_SECRET`.

```sh
npx @notambourine/metafields ./schema.ts \
  --app-config ./shopify.app.toml --store example.myshopify.com --apply
```

`--app-config` reads only the top-level `client_id`. Complete app credentials take priority over a
static token; incomplete app credentials fall back to the token. Credentials are redacted from
errors.

## Fleets

Repeat `--store` or load one store per line from a file. Lines beginning with `#` are ignored.

```sh
npx @notambourine/metafields ./schema.ts \
  --store flagship.myshopify.com --stores-from ./stores.txt --apply
```

Each store is planned against the same schema. One store refusing a write does not stop the others.
A store named directly fails loudly; a swept store without the app is reported as `NOT-INSTALLED`
without failing the fleet. Other unreachable stores and rejected writes exit `2`.

## Pull and generated output

Pull existing definitions into a new schema file:

```sh
npx @notambourine/metafields pull \
  --store example.myshopify.com \
  --owner product \
  --namespace custom \
  --metaobjects \
  --out schema.ts
```

Owners and namespaces must be explicit unless their corresponding `--all-owners` or
`--all-namespaces` flag is passed. The output path must not exist; omit `--out` to write to stdout.

Generate Liquid editor metadata from the schema:

```sh
npx @notambourine/metafields emit ./schema.ts \
  --liquid --out .shopify/metafields.json
```

The generated file supports Liquid completion and hover without a store login. It cannot represent
metaobjects, `required`, validations, access, customer metafields, or draft-order metafields.
`emit` refuses to replace a file it did not generate unless passed `--force`.

## Types

Infer application types from the schema. Required declarations remain required:

```ts
import type { InferMetafields, InferMetaobjects } from '@notambourine/metafields';
import schema from './schema.js';

type ProductMetafields = InferMetafields<typeof schema>['product'];
type Faq = InferMetaobjects<typeof schema>['faq'];
```

## Migrations

Migrations copy values to a new definition. They never retype or delete the source.

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

Compile before introducing credentials, inspect the plan, then apply it:

```sh
npx @notambourine/metafields compile ./migration.ts --out ./migration.json
npx @notambourine/metafields migrate ./migration.json --store example.myshopify.com
npx @notambourine/metafields migrate ./migration.json --store example.myshopify.com --apply
```

Migration exit code `1` means rows remain pending.

## API compatibility

`doctor` checks that Shopify still serves the selected API version and that the package's generated
metafield type table matches it. It needs no store or credentials.

```sh
npx @notambourine/metafields doctor
npx @notambourine/metafields doctor --api-version 2026-07 --json
```

An unsupported version or changed type table is a failed check. An unreachable Shopify registry is
indeterminate and exits `2`.

Run `npx @notambourine/metafields --help` for the complete CLI reference.

This `0.x` release is prerelease quality. Confirm scopes and behavior against a development store
before production use.
