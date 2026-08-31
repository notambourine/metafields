# @notambourine/metafields

Declare merchant-owned Shopify metafield and metaobject definitions in TypeScript, inspect drift,
and make a store match. `--apply` is additive: it creates what is missing and widens what already
exists. `--force` is the one opt-in that changes how something already there behaves, and nothing
deletes a definition under any flag.

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
npx @notambourine/metafields ./schema.ts --validate                              # schema only
npx @notambourine/metafields ./schema.ts --store example.myshopify.com           # report
npx @notambourine/metafields ./schema.ts --store example.myshopify.com --apply
npx @notambourine/metafields ./schema.ts --store example.myshopify.com --apply --force
npx @notambourine/metafields ./schema.ts --store example.myshopify.com --apply --dry-run
```

The default command reports without writing. The exit code describes the store, not the flags:
`0` means it matches, `1` means real drift remains after the run, and `2` means invalid input,
indeterminate Shopify state, or an API failure. `--dry-run` cancels whatever write was asked for,
so the exact command line CI runs takes one appended flag to show what it would do, and works as a
gate that flips to `0` once the work lands.

Schema modules use Node's built-in type stripping and must use erasable TypeScript syntax.
Importing one executes trusted local code, so compile declarations to canonical JSON before a
secret-bearing workflow consumes pull-request output.

See `metafields --help` for `pull`, `compile`, `emit`, and migration commands.

## Auth

Set `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_SECRET`, and the CLI mints a short-lived Admin token
per store with the `client_credentials` grant. The client id can come from three places, most
explicit first: `--client-id`, `--app-config ./shopify.app.toml`, then the environment. The secret
is only ever an environment variable.

```sh
metafields ./schema.ts --app-config ./shopify.app.toml --store example.myshopify.com --apply
```

`--app-config` reads the top-level `client_id` out of the app TOML the Shopify CLI already
requires; a `client_id` under a `[section]` belongs to that section and is never read.
`readAppConfig()` is exported for programmatic callers. Two grant errors stay distinct because a
fleet treats them differently: `app_not_installed` means the store has not installed the app,
`shop_not_permitted` means the app and the store are in different organizations.

`SHOPIFY_ADMIN_ACCESS_TOKEN` still works and reaches one store. Complete app credentials win when
both are set, and half-set ones fall back to the token rather than failing. Only a fleet, which one
token cannot reach, requires the app. Minted tokens are never logged, and Shopify credential
prefixes are redacted from errors.

## What `--apply` writes, and what needs `--force`

The line runs through the updates, not between creating and updating. Adding a missing field to a
metaobject is purely additive; narrowing storefront access can break a live theme.

Applied by `--apply`:

- Creating a definition, metaobject or metafield. A new definition has no stored values and no
  live readers, so nothing about it can break anything.
- A field missing from an existing metaobject.
- Metaobject `displayNameKey`.
- Enabling a capability, `adminFilterable` most often.
- Drifted `name` and `description`. Both are labels, so no stored value can be lost by rewriting
  one. They never affect the exit code, and a definition that has only drifted cosmetically stays
  `PRESENT`.

Needs `--force`, because each can change how something already in use behaves:

- `access`, on a metafield or a metaobject. Narrowing it stops a storefront reading the field.
- `validations` and `constraints`. Tightening either can strand stored values.
- `required: true` on a metaobject field.
- Disabling a capability.

Reported and skipped, never attempted, with or without `--force`:

- A `type` that differs. Shopify will not retype a definition that has stored values; that is what
  the migration commands are for.
- Invalid stored values (`validationStatus: SOME_INVALID`). That is data, not shape.
- Anything `INDETERMINATE`, meaning validation is still in progress. Wait, do not write.

`--force` requires `--apply`; alone it has no write to widen. It overrides the tool's own judgment,
never a Shopify constraint and never a data problem, and it means the same thing everywhere in the
CLI, including `emit --liquid` refusing to clobber a file it did not generate.

A definition is skipped whole, never half-updated: if one definition holds both an applied change
and one needing force, it gets neither until forced. Skipping one definition does not stop the
others, so `--apply` alone against a store holding drift that needs force writes everything it can,
names what it skipped, and exits `1`. An update carries only the attributes the plan reported as
drifted, so changing a capability never rewrites a name.

`--apply` updates existing definitions first, metaobjects before metafields, so a metaobject a new
metafield references is already correct; then it creates the missing ones in the same order. A
description over 255 characters fails `--validate` and fails sync before the first request, listing
every offender at once. Shopify refuses `required: true` on a field whose existing entries are
blank, and that `userErrors` message is surfaced intact so the operator knows which entries to
fill.

A rate limit is retried on a backoff, on reads and on writes alike: the Admin GraphQL API answers
one with HTTP 200 carrying `THROTTLED` and rejects the request before running it, so a retried
create cannot leave a second definition behind. A timeout or a `5xx`, either of which may already
have landed, is still sent exactly once for a mutation.

## Fleets

`--store` repeats, and `--stores-from <file>` sweeps a list of stores, one per line, with `#`
comments:

```sh
metafields ./schema.ts --store flagship.myshopify.com --stores-from ./stores.txt --apply
```

- Every store applies the same set and skips the same definitions, so the fleet stays uniform
  without withholding from one store the creates another cannot take.
- A swept store that cannot be reached is reported and does not abort the run, as long as one store
  could be planned. A swept store that has not installed the app is reported as `NOT-INSTALLED` and
  keeps the run green. A store named on the command line never fails quietly.
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
`draft_order` metafields, which are reported as skipped. Treat it as a generated artifact that
`emit` replaces, and that `emit` refuses to overwrite until `--force` says otherwise if it did not
generate it. Shopify's own `shopify theme metafields pull` overwrites the same path, so do not
hand-edit it.

## Pull

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

`migrate` exits `1` while rows are still pending, the same way schema drift does.

`0.x` is prerelease quality. Confirm owner scopes and behavior against a development store before
production use.
