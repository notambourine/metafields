# `@notambourine/metafields` package plan

Build a create-only Shopify custom-data CLI that accepts a TypeScript schema module as its first
argument:

```text
npx @notambourine/metafields ./path-to-metafield-types/index.ts --store example.myshopify.com
npx @notambourine/metafields ./path-to-metafield-types/index.ts --store example.myshopify.com --apply
npx @notambourine/metafields ./path-to-metafield-types/index.ts --store example.myshopify.com --check
```

The default invocation is a dry run. `--apply` creates missing definitions. `--check` is read-only
and fails unless every configured definition already exists with a compatible operational shape.

The package will manage merchant-owned metafield and metaobject definitions. It will never delete
or update definitions, delete or write metafield values, or delete or write metaobject entries.

## Architecture decision

The positional TypeScript-module architecture makes sense, with one important constraint: the file
must export a runtime schema value, not only TypeScript interfaces or type aliases.

TypeScript types disappear before the CLI runs. A type such as `{ promo_text: string }` does not
tell the runtime whether the Shopify type is `single_line_text_field`, `rich_text_field`, `url`, or
`json`, and it carries no owner, namespace, display name, validation, access, or capability data.
Using the TypeScript compiler API to reverse-engineer arbitrary interfaces would be fragile and
would still require annotations for those Shopify-specific details.

The package should instead export typed schema builders. The consumer's `index.ts` exports the
result of `defineSchema()`. Builders retain runtime definition metadata and precise generic types,
so the same declaration drives Shopify sync and application type inference.

The module path is positional because it is the primary input, not an incidental option. Resolve it
from the current working directory. Do not search parent directories or require a special filename.

## Proposed schema module

```ts
import {
  defineSchema,
  field,
  metaobject,
  type InferMetafields,
  type InferMetaobjects,
} from '@notambourine/metafields';

export const schema = defineSchema({
  metaobjects: {
    faq: metaobject({
      name: 'FAQ',
      displayNameKey: 'question',
      access: { storefront: 'public_read' },
      capabilities: { publishable: true },
      fields: {
        question: field.string({ name: 'Question', required: true }),
        answer: field.richText({ name: 'Answer', required: true }),
        sort_order: field.integer({ name: 'Sort order' }),
      },
    }),
    pdp_story: metaobject({
      name: 'PDP story',
      displayNameKey: 'name',
      fields: {
        name: field.string({ name: 'Name', required: true }),
        collections: field.list(field.collection(), { name: 'Collections' }),
      },
    }),
  },
  metafields: {
    product: {
      custom: {
        promo_text: field.string({ name: 'Promo text', adminFilterable: true }),
        max_chars: field.integer({ name: 'Maximum characters', min: 1 }),
        story: field.metaobject('pdp_story', { name: 'PDP story' }),
        payload: field.json<{ source: string; enabled: boolean }>({ name: 'Payload' }),
      },
    },
    collection: {
      custom: {
        related_collections: field.list(field.collection(), {
          name: 'Related collections',
        }),
      },
    },
    shop: {
      custom: {
        chain_prices: field.json<Record<string, number>>({ name: 'Chain prices' }),
      },
    },
  },
});

export type StoreMetaobjects = InferMetaobjects<typeof schema>;
export type StoreMetafields = InferMetafields<typeof schema>;
export default schema;
```

The default export is the CLI contract. Named exports are optional and belong to the consuming
repository. The CLI should reject modules with no valid default schema.

The inferred logical shapes are equivalent to:

```ts
type StoreMetaobjects = {
  faq: {
    question: string;
    answer: RichText;
    sort_order?: number;
  };
  pdp_story: {
    name: string;
    collections?: CollectionReference[];
  };
};

type StoreMetafields = {
  product: {
    custom: {
      promo_text?: string;
      max_chars?: number;
      story?: MetaobjectReference<'pdp_story'>;
      payload?: { source: string; enabled: boolean };
    };
  };
  collection: {
    custom: { related_collections?: CollectionReference[] };
  };
  shop: {
    custom: { chain_prices?: Record<string, number> };
  };
};
```

All metafield values are optional because creating a definition does not create a value on every
owner. Metaobject fields are required only when their builder says `required: true`.

Reference types should retain identity rather than pretending every Shopify GID is an ordinary
string. `MetaobjectReference<'pdp_story'>` carries its target definition at compile time. This
package does not write values in the first release, so logical value types need not double as raw
Admin GraphQL input types.

## Builder contract

Start with the common field types needed by the first consumers and leave an explicit extension
path:

| Builder | Shopify type | Inferred value |
|---|---|---|
| `field.string()` | `single_line_text_field` | `string` |
| `field.text()` | `multi_line_text_field` | `string` |
| `field.richText()` | `rich_text_field` | `RichText` |
| `field.integer()` | `number_integer` | `number` |
| `field.decimal()` | `number_decimal` | precision-safe decimal string |
| `field.boolean()` | `boolean` | `boolean` |
| `field.url()` | `url` | branded URL string |
| `field.json<T>()` | `json` | `T` |
| `field.product()` | `product_reference` | `ProductReference` |
| `field.variant()` | `variant_reference` | `VariantReference` |
| `field.collection()` | `collection_reference` | `CollectionReference` |
| `field.file()` | `file_reference` | `FileReference` |
| `field.metaobject(key)` | `metaobject_reference` | `MetaobjectReference<key>` |
| `field.mixedMetaobject(keys)` | `mixed_reference` | union of typed references |
| `field.list(inner)` | `list.<inner type>` | array of the inner value |

Do not infer `number_decimal` as JavaScript `number`; Shopify supports precision JavaScript can
silently lose. `field.json<T>()` supplies compile-time shape only unless the caller also configures
a Shopify JSON-schema validation.

Builder options map to Shopify metadata, capabilities, and validations. TypeScript should reject
inapplicable validations where practical. Runtime validation remains authoritative because loading
a `.ts` file does not run `tsc`.

The type system must enforce these relationships:

- `displayNameKey` is a key in that metaobject's `fields` object.
- `field.metaobject('pdp_story')` targets a key declared under the same schema's `metaobjects`.
- Mixed metaobject references contain only declared target keys.
- Required metaobject fields infer as required; optional fields infer as optional.
- Metafield owner, namespace, and key nesting remains literal.
- A validation applies to the selected Shopify field type.

Local metaobject references emit Shopify's portable `metaobject_definition_type` or
`metaobject_definition_types` validation, not per-store GIDs. Add an explicit external-reference
builder later if a store needs a target definition managed outside this schema.

## Ownership and Shopify behavior

Use the GraphQL Admin API. Shopify's declarative `shopify.app.toml` path creates app-owned data,
which is the wrong ownership model here. GraphQL can create merchant-owned metafield and metaobject
definitions.

Require literal, non-reserved metafield namespaces such as `custom`. Reject `app`, `$app`,
`app--*`, `shopify`, and `shopify--*`. Merchant-owned metafields remain editable by merchants and
properly scoped apps. Matrixify documents that it can import/export ordinary custom metafields but
cannot manage another app's `app--<app_id>--...` metafields.

Liquid can read `product.metafields.custom.example` regardless of the definition's Storefront API
access. Configure `public_read` only when a Storefront API consumer needs it. Metaobjects require
their own storefront access when Liquid or the Storefront API must resolve their entries, so that
setting must remain explicit.

The deployment identity is a Shopify app calling the GraphQL Admin API with an Admin access token.
There is no separate app GraphQL path that avoids Admin scopes. An offline token is suitable for CI
and background deployment work.

Creating definitions does not create metafield values or metaobject entries. Matrixify or other
tools continue to own those values.

## CLI contract

```text
npx @notambourine/metafields <schema-module.ts> --store <store.myshopify.com>
  [--apply | --check] [--api-version YYYY-MM] [--json]

npx @notambourine/metafields <schema-module.ts> --validate

npx @notambourine/metafields pull --store <store.myshopify.com>
  --owner product --namespace custom [--metaobjects] [--out <schema-module.ts>]

npx @notambourine/metafields compile <schema-or-migration.ts> --out <compiled.json>

npx @notambourine/metafields migrate <compiled-migration.json>
  --store <store.myshopify.com> [--apply | --check] [--json]
```

- The schema path and `--store` are required for store operations.
- `--validate` loads and validates the module without credentials or network access.
- `--apply` and `--check` are mutually exclusive.
- `--json` emits one machine-readable result and sends diagnostics to stderr.
- `--api-version` overrides the package's pinned stable Admin API version.
- Read `SHOPIFY_ADMIN_ACCESS_TOKEN` from the environment. Never accept or print a token argument.
- Require a `*.myshopify.com` host before constructing the API URL.
- The package does not mint, refresh, or store tokens.

`sync` may consume the TypeScript schema directly for local use. Secret-bearing audit and migration
jobs should consume canonical JSON emitted by `compile`, so those jobs parse data but execute no
branch-controlled TypeScript.

The CLI must load TypeScript without requiring the consumer to precompile the schema. On Node
22.18 and newer, use Node's maintained built-in type stripping and require erasable TypeScript
syntax. Document that importing the schema executes trusted repository code; deployment must never
load an untrusted pull request's module with production credentials.

Strong typing is checked by the consuming repository's normal `tsc --noEmit` project, which must
include the schema module. `--validate` is a runtime schema check, not a replacement for `tsc`.

### Where `--check` earns its keep

`--check` is a low-cost output mode over the same planner, not a required deployment step. It is
useful when the job is intentionally unable to write:

- A protected preflight job has a read-only token and must prove a store is ready before release.
- A scheduled audit detects a definition deleted or changed by hand.
- Store standup proves a new store has received all definitions.
- A release system separates verification and mutation into different identities or approvals.

It can fail because a configured definition is missing, a type or declared operational option
differs, or a nested metaobject field is absent/incompatible. Authentication and network errors use
exit 2 so CI can distinguish an unreachable store from drift.

Do not run `--check` immediately before `--apply` in the same job. `--apply` performs the same plan
and post-apply verification, so the check adds latency and would prevent the apply from fixing a
missing definition. Pull-request CI without store credentials should run `tsc` and `--validate`,
not `--check` against production. Keeping the flag is still worthwhile because its implementation
is only stricter exit behavior over an already-required dry-run plan.

## Pulling an existing store into a schema

Call the reverse operation `pull`, not `scaffold`. `pull` follows the familiar remote-to-local
direction and says what the command does; scaffolding usually means creating generic boilerplate.

`pull` reads definitions, not values. Definitions are the schema source. Crawling every product,
collection, customer, order, and other owner looking for unstructured values would be expensive,
permission-heavy, incomplete, and capable of finding the same key with conflicting inferred types.
Unstructured-value discovery is out of scope for the first release.

Require explicit scope for the pull:

- `--owner <type>` is repeatable. Require at least one owner or an explicit `--all-owners`.
- `--namespace <name>` is repeatable. Require at least one namespace or an explicit
  `--all-namespaces`; this prevents third-party fields from silently becoming managed source.
- `--metaobjects` includes merchant-owned metaobject definitions and their nested fields.
- If selected metafields reference metaobjects, require `--metaobjects`; otherwise the generated
  local-reference schema would be incomplete. Add an external-reference builder before relaxing
  this requirement.
- Reserved Shopify and app-owned definitions are excluded and reported.
- A permission failure for any requested owner fails the pull. Never emit a plausible-looking
  partial schema after silently skipping an inaccessible owner.

Write deterministic TypeScript using the public builders. Print to stdout by default so the result
can be reviewed or redirected. `--out <path>` creates a new file and refuses if it exists. Do not
offer overwrite or merge in the first release: generated replacement can discard hand-written JSON
generics, comments, imported types, and deliberate schema omissions.

The generated schema preserves names, descriptions, types, validations, access, capabilities,
required flags, and metaobject references where Shopify exposes them. Some static types cannot be
recovered from Shopify:

- A `json` definition becomes `field.json<unknown>()`; Shopify does not know the application's
  TypeScript shape unless it has a usable JSON-schema validation.
- Branded semantic aliases collapse to their underlying Shopify field builder.
- Definitions created by another app or merchant may require ownership/prefix review before they
  can be reproduced on a different store.

The generated file must pass both runtime `--validate` and the package's type-level fixture before
`pull` is considered correct. Pulling is a bootstrap/review workflow, not an ongoing round-trip
formatter and not a replacement for the checked-in schema.

## Planning and drift

Query metafield definitions by exact owner type, namespace, and key. Query metaobject definitions by
exact type. Do not inventory the whole store.

| Store state | Dry run | `--apply` | `--check` |
|---|---|---|---|
| Missing definition | Report `CREATE`, exit 0 | Create it | Fail |
| Operational match | Report `PRESENT` | No action | Pass |
| Metafield type differs | Report `CONFLICT`, exit 1 | Abort before writes | Fail |
| Declared metaobject field missing or wrong type | Report `CONFLICT`, exit 1 | Abort before writes | Fail |
| Explicit validation/access/capability/required flag differs | Report `CONFLICT`, exit 1 | Abort before writes | Fail |
| Definition reports invalid stored values | Report `CONFLICT`, exit 1 | Abort before writes | Fail |
| Definition validation is still in progress | Report `INDETERMINATE`, exit 2 | Abort before writes | Retry later |
| Name or description differs | Report `NOTICE`, exit 0 | Leave unchanged | Pass |
| Undeclared definition or extra metaobject field | Ignore | Ignore | Ignore |

Compare operational fields only when the schema explicitly configures them. Names and descriptions
are cosmetic notices. Extra metaobject fields are ignored because this is an ensure-list. A missing
declared field is a conflict because adding it would require an update mutation.

An exact key match is never sufficient. The metafield query must compare `type.name`, normalized
validations, explicitly configured access, capabilities, constraints, and reference targets. The
metaobject query must additionally compare each configured nested field's type, validations, and
required flag. Include the definition's `validationStatus` and invalid-value count: `SOME_INVALID`
fails check even when the definition shape matches, while `IN_PROGRESS` is indeterminate rather than
a false pass. Name, description, and pin position remain cosmetic notices.

Plan all definitions before any write. Any conflict aborts before mutations. Create missing
metaobject definitions in dependency order, then metafield definitions, so local references
resolve. Reject metaobject-reference creation cycles because create-only sync cannot add a cyclic
field later. Re-read and verify every created definition before returning success. A partial
failure reports which creates landed; rerunning is safe.

Exit codes:

- `0`: the command completed and its mode's condition is satisfied. Missing definitions in a dry
  run remain informational.
- `1`: configured state is unsatisfied: a conflict, or anything missing in `--check` mode.
- `2`: invalid module or arguments, authentication/network failure, exhausted retries, or Shopify
  API/user errors.

## Type migrations without losing values

`string -> url` is a real conflict, not a harmless alias. Shopify's URL type accepts only `https`,
`http`, `mailto`, `sms`, and `tel` schemes. `--check` must report the actual and desired types plus
the value and invalid-value counts. `--apply` must refuse the mismatch.

Shopify's current `metafieldDefinitionUpdate` input cannot change a definition's type. Type,
namespace, key, and owner type identify the definition. Keep type migration outside normal sync so
an additive deploy can never become an implicit data rewrite or definition deletion.

### Recommended: new-key blue-green migration

For `custom.internet` currently stored as text but intended to become a URL:

1. Export/back up the old field with owner IDs and values. A Matrixify export is acceptable; retain
   the untouched export because blank metafield cells on import can delete values.
2. Add a new definition such as `custom.internet_url` using `field.url()`. Apply creates it without
   touching `custom.internet`.
3. Change active writers to dual-write old and new fields, or temporarily freeze edits while the
   backfill runs. This closes the race between export and cutover.
4. Read every old value, trim and normalize it under an explicit rule, and validate it before any
   write. For a web-link field, accept only `http` and `https` even though Shopify's generic URL type
   supports three additional schemes. Produce a rejection report; never blank or coerce invalid
   client data silently.
5. Write valid values to the new key. Preserve the old field unchanged. A purpose-built migration
   should use owner IDs and compare digests so concurrent changes fail instead of being overwritten;
   Matrixify can be used when the catalog team owns a frozen export/import window.
6. Verify source count, migrated count, rejected count, normalized value parity, and Shopify's
   definition `validationStatus = ALL_VALID`.
7. Deploy readers with new-key-first, old-key-fallback behavior. Keep the fallback through at least
   one complete client review and editing cycle.
8. Move writers to the new key only after coverage is complete. Retain the old field and backup for
   rollback. Definition/value removal is a later explicit human migration, never `sync` behavior.

This costs a temporary second key but leaves every uploaded value recoverable and makes rollback a
reader switch rather than a data restore.

### Same-key migration: supported mechanism, not the default

If the key absolutely cannot change, the mechanism is a maintenance operation:

1. Freeze writers and export every value.
2. Validate every value against the target type before changing the store.
3. Delete only the target definition with `deleteAllAssociatedMetafields: false`, preserving its
   values as unstructured metafields.
4. Recreate the same owner/namespace/key with the URL type. Shopify validates matching unstructured
   values and associates the valid ones with the new definition.
5. Wait for validation to finish, require `ALL_VALID`, compare counts and values with the export,
   and restore the old definition from the backup plan if verification fails.

This path has a no-definition interval, can be blocked when the definition is in use, and strands
invalid values until they are repaired. Reference and ID definitions have additional deletion
restrictions. It requires destructive-definition authority and therefore must not be exposed by
the create-only package's `--apply`. If added later, make it a separate, loudly named migration
command with a generated plan, backup acknowledgement, target identity confirmation, and no fleet
mode.

## Declaring and shipping blue-green migrations

A migration-bearing change is two PRs, even though the copy runs automatically when the first one
lands. The first PR expands and backfills; a later PR contracts after an observation window. Do not
change the type in place or remove the fallback in the expansion PR.

### Checked-in migration intent

Keep migration intent beside the typed schema, for example:

```text
metafield-types/
  index.ts
  migrations/
    product-internet-url-v1.ts
```

Canonical JSON is a CI artifact, not checked-in source. The TypeScript declarations remain the one
source of truth; credential-free CI compiles them for later trusted jobs.

The TypeScript migration declaration should reference fields from the schema rather than repeat
raw owner/namespace/key strings:

```ts
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

Only declarative, package-supplied transforms belong in an automatic migration. Arbitrary
functions cannot be audited reliably, cannot compile to a stable data artifact, and would execute
PR-controlled code near production credentials. A migration requiring custom business logic stays
a separate reviewed tool.

Every automatic migration is copy-only. The DSL must have no `move`, `deleteSource`, or overwrite
mode. Its ID and compiled checksum are immutable after the first apply. The source and target types
are part of the compiled plan, and the target must also be present in the desired schema.

The schema in the expansion PR declares both fields. Storefront readers use new-first,
old-fallback behavior. Any active writer either dual-writes both fields before backfill or the
business freezes edits for the migration window.

### What the expansion PR contains

The PR makes migration intent executable and reviewable. It includes:

- The old and new definitions together in the typed schema.
- One new file under `migrations/` with a globally unique migration ID.
- A declarative source, target, transform, invalid-value policy, and target-conflict policy.
- Compatible readers that prefer the new key and fall back to the old key.
- A dual-write change or an explicit edit-freeze procedure.
- Transform fixtures covering every accepted and rejected input class.
- PR acceptance notes naming the stores/owner type, expected source count, normalization rule,
  protected audit result, rollout order, and rollback behavior.

The presence of a migration file in the active `migrations/` directory is the main-deployment
signal; no checkbox or commit-message convention is needed. The release runner executes every
active migration idempotently. Once a migration ID has landed on main, CI permits deletion in the
later contraction PR but rejects edits to its source/target/transform. Git retains the removed file
as history, so no completed-migration archive is needed.

### Credential-free PR checks

Ordinary PR CI runs no store query and receives no Admin token. It should:

1. Type-check the schema and migration declarations.
2. Runtime-validate both declarations.
3. Compile them to canonical JSON and upload the checksummed CI artifacts.
4. Prove the source still exists, the target is additive, the types differ as declared, the
   transform supports that pair, and readers retain the old fallback.
5. Run table-driven transform fixtures, including empty, whitespace, already-valid, bare-host,
   disallowed-scheme, and malformed values.
6. Scan the compiled plan to prove it contains copy-only behavior and no executable code.

The compiled artifact is the trust boundary. A secret-bearing job consumes canonical data with a
pinned trusted CLI; it does not import or execute the PR's TypeScript module.

### Optional protected PR data audit

Checking real data before merge is worthwhile for a migration, but it cannot be a normal
pull-request job. GitHub should not expose production data or tokens to arbitrary PR code. Provide a
manually approved, protected-environment audit that:

1. Uses a read-only store token and the pinned package version from the trusted workflow.
2. Downloads only the compiled migration artifact from credential-free CI.
3. Reads source and target values without executing the branch's code.
4. Reports counts for missing, valid, normalizable, rejected, already-equal, and conflicting target
   values per store.
5. Fails on rejected values, conflicting targets, unexpected source type, or incomplete scope.
6. Avoids raw values in logs. Put owner IDs and rejection reasons in a restricted artifact when
   operators need a repair list.

The audit can be required by review policy for migration PRs, but it is advisory with respect to
time: client data can change after it runs. The fresh main-deployment preflight is authoritative.

### Main deployment sequence

For each store, serially:

1. Export the source and any existing target values to a restricted backup artifact.
2. Run definition sync `--apply`, which creates the new target definition and changes nothing else.
3. Run the migration in fresh dry-run/check mode against current data. Stop on invalid values or
   target conflicts.
4. Apply the copy in atomic Shopify batches. If the target is absent, use `compareDigest: null`; if
   it already equals the transformed source, skip it; if it differs, fail rather than overwrite.
5. Re-read source and target after each batch. A source changed during the copy is a conflict, not a
   silent stale success.
6. Verify source count is unchanged, every non-empty source is either copied or explicitly rejected,
   rejected count is zero, targets equal the declared transform, and the target definition reports
   `ALL_VALID`.
7. Push the compatible theme that reads new first and old as fallback.
8. Run storefront smoke, then continue to the next store. Stop the fleet on the first failure.

Reruns are idempotent: equal targets pass, absent targets are created, and differing targets stop.
No rerun deletes or overwrites source data.

This ordering must live in one release orchestrator or in jobs connected by explicit dependencies.
Two independent workflows triggered by the same merge do not provide an ordering guarantee. The
specific CI vendor and the current repository's workflow layout are integration details, not the
architecture.

### Contraction PR

After every store is verified and the client has edited through at least one normal cycle:

1. Remove dual-write and old-field fallback behavior.
2. Remove the completed migration declaration from the active deployment set while retaining its
   immutable record in release history.
3. Optionally remove the old field from the desired schema. This still does not delete its store
   definition or values.
4. Treat any actual old-definition/value deletion as a separate manual, backed-up cleanup decision.

## Safety invariants

Mutation authority is command-specific:

- `sync --apply` may call only `metaobjectDefinitionCreate` and `metafieldDefinitionCreate`.
- `migrate` dry-run/check may start Shopify bulk read operations but cannot write values.
- `migrate --apply` may additionally call `metafieldsSet`, and only for the declared target key.
- No command may call a definition update/delete mutation, `metafieldsDelete`, or a metaobject entry
  mutation.

Shopify caps `metafieldsSet` at 25 entries and makes each call atomic. The migration runner should
use those synchronous batches for compare-and-set guarantees. Use Shopify bulk query operations to
read large owner sets efficiently; do not use bulk mutation as a reason to give up per-target
conflict checks.

Removing anything from the TypeScript schema does nothing to the store. Definitions and values not
declared in the module are ignored.

One Shopify-side effect must be explicit: creating a definition for a matching unstructured
metafield can associate valid existing values with that definition. Invalid values remain unchanged
but must conform before a later update. The CLI does not rewrite or delete them.

Use bounded timeouts and retries for GraphQL throttling, HTTP 429/5xx, and dropped connections.
Never retry a mutation `userError` automatically.

## Permissions

For product, variant, collection, shop, and metaobject definitions, the deployment token generally
needs `write_products` and `write_metaobject_definitions`. The latter manages definition schemas,
not metaobject entries. `read_metaobjects` and `write_metaobjects` are unnecessary unless another
workflow manages entries.

| Owner type | Read/check | Create/apply |
|---|---|---|
| Product, product variant, collection | `read_products` | `write_products` |
| Customer, company, company location | `read_customers` | `write_customers` |
| Page, blog, article | `read_content` | `write_content` |
| Order | `read_orders` | `write_orders` |
| Draft order | `read_draft_orders` | `write_draft_orders` |
| Location | `read_locations` | `write_locations` |
| Metaobject definition | `read_metaobject_definitions` | `write_metaobject_definitions` |

Shop-level definitions have no separately documented `write_shop` scope. Verify that owner in the
development-store suite before claiming support. Reject unverified owner types instead of guessing.

`pull` needs each requested owner's read scope and `read_metaobject_definitions` when
`--metaobjects` is present. A pull token does not need write scopes.

## Package boundary

Extract the reusable behavior from Horizon:

- Pure desired-vs-existing planning from `scripts/custom-data/lib/plan.mts`.
- Pinned API version, timeout, throttling detection, retries, and response validation from
  `lib/admin.mts`.
- Plan-before-write and idempotent definition creation from `lib/apply.mts`.
- Both metafield and metaobject definition support from the current custom-data runner.

Do not extract fleet discovery, production guards, per-store token naming, `--allow-production`,
entry/value seeders, or deploy policy.

Package layers:

1. Public field/metaobject builders, branded references, and inference utility types.
2. TypeScript module loader and runtime validator.
3. Pure planner.
4. Shopify Admin GraphQL adapter.
5. Apply and verification coordinator.
6. Deterministic schema-module generator for `pull`.
7. CLI and text/JSON output adapters.

Compile to JavaScript and expose both a `metafields` bin and typed ESM library exports. Support
maintained Node LTS releases instead of relying on native `.ts` execution. Keep runtime dependencies
to Shopify's Admin API client and the TypeScript module loader where possible.

## Acceptance plan

Type-level tests must cover literal nested inference, required/optional fields, every builder,
lists, JSON generics, local references, `displayNameKey`, and invalid validations.

Runtime tests must cover module loading, validation when `tsc` is bypassed, exact identity mapping,
reserved namespaces, duplicate identities, all drift states, output/exit codes, retries, ordering,
redaction, partial applies, and the mutation allowlist. Pull tests must cover pagination, explicit
owner/namespace selection, reserved-definition filtering, permission failures, deterministic
output, `json<unknown>`, stdout, and refusal to overwrite an existing file.

Check fixtures must prove that an existing `single_line_text_field` fails against `field.url()`,
that normalized validation/reference differences fail, that cosmetic drift passes with a notice,
and that `SOME_INVALID` and `IN_PROGRESS` cannot pass CI.

Development-store acceptance:

1. Dry run absent metafield and metaobject definitions without changing the store.
2. Prove `--check` fails while either is absent.
3. Apply and prove a metaobject lands before a metafield that references it.
4. Rerun apply as a no-op and pass `--check`.
5. Remove configured keys and prove store definitions and values remain.
6. Seed an ordinary `custom` metafield value and metaobject entry through Matrixify and resolve both
   in Liquid.
7. Reject reserved/app-owned namespaces locally.
8. Exercise an existing unstructured value and portable single/mixed metaobject validations.
9. Verify every claimed owner/scope pair, including shop-level definitions.
10. Pull the resulting definitions, validate/type-check the generated module, and prove it plans as
    present against the source store.

Publish `0.0.x` as prerelease-quality packages while development-store acceptance is incomplete.
Release `0.1.0` only after these checks are automated. Treat builders, inference types, output, and
exit codes as public APIs.

## Horizon migration

1. Build and publish the package from the new repository without changing Horizon.
2. Convert `scripts/custom-data/custom-data.toml` to a typed schema module containing its metafield
   and metaobject definitions. Use `pull` as comparison input, not as an unchecked replacement.
   Leave entries, values, and seeders in Horizon.
3. Add the exact package version as a dev dependency, include the schema module in the relevant
   TypeScript project, and commit the lockfile.
4. Compare old and new dry-run plans against a development store.
5. Add runtime schema validation and TypeScript checking to existing relevant CI paths. Do not give
   pull-request jobs production Admin tokens.
6. Run `sync --apply` immediately before each theme push. Definitions land before code reads them.
7. Use `--check` for read-only prelaunch/smoke jobs and store-standup audits.
8. Keep the old runner for one release, then remove duplicated definition-management code only.

If a later theme deploy fails, the only prior changes are additive merchant-owned definitions with
no automatically created values or entries.

## Source basis

- [Shopify: About metafields](https://shopify.dev/docs/apps/build/metafields)
- [Shopify: Manage metafield definitions](https://shopify.dev/docs/apps/build/metafields/definitions)
- [Shopify: Manage metaobject definitions](https://shopify.dev/docs/apps/build/metaobjects/manage-metaobject-definitions)
- [Shopify: `metafieldDefinitionCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafielddefinitioncreate)
- [Shopify: API access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Shopify: Access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Shopify: List of validation options](https://shopify.dev/docs/apps/build/metafields/list-of-validation-options)
- [Shopify: List of data types and type migration](https://shopify.dev/docs/apps/build/metafields/list-of-data-types)
- [Shopify: `metafieldDefinitionUpdate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafielddefinitionupdate)
- [Shopify: `metafieldDefinitionDelete`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafielddefinitiondelete)
- [Shopify: Definition validation status](https://shopify.dev/docs/api/admin-graphql/latest/enums/metafielddefinitionvalidationstatus)
- [Shopify: `metafieldsSet` compare-and-set behavior](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsset)
- [Shopify: Bulk query operations](https://shopify.dev/docs/api/usage/bulk-operations/queries)
- [Shopify Liquid: `metafields`](https://shopify.dev/docs/api/liquid/objects/metafields)
- [Matrixify: Metafields](https://matrixify.app/documentation/metafields/)
