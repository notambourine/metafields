# metafields

A CLI that makes a Shopify store's metafield and metaobject **definitions** match a TypeScript
schema.

## Invariants

Hold these in any change; they are the product, not implementation detail.

- Never write a metafield value or a metaobject entry. Definitions only.
- Never delete a definition or a field, under any flag, `--force` included.
- Never retype a definition. Retyping is what the migration commands are for.
- Let `--force` override this tool's own judgment only, never a Shopify constraint and never a
  data problem. Keep its meaning identical everywhere in the CLI.
- Carry only the attributes the plan reported as drifted into an update.
- Skip a definition whole rather than half-updating it.
- Send a mutation exactly once on a timeout or `5xx`; retry only `THROTTLED`.
- Redact Shopify credential prefixes from errors and never log a minted token.

## Code

- Write erasable TypeScript syntax; schema modules load under Node's type stripping.
- Suffix relative imports with `.js`.
- Classify drift in `src/changes.ts` (`applies` / `needsForce` / `blocked`); let `src/admin.ts`,
  `src/fleet.ts`, and `src/cli.ts` consume that classification rather than re-deciding risk.
- Make the exit code describe the store, not the flags: `0` matches, `1` real drift remains,
  `2` invalid input, indeterminate state, or an API failure. Keep cosmetic drift out of it.

- Take type names, categories, owner enum values, and supported validation names from the
  generated `src/metafield-types.ts`; never hand-transcribe a second copy of one. Refresh it with
  `npm run generate:metafield-types` and never edit it by hand.

## Workflow

- Bump `version` in `package.json` for any change outside `.github/`, `test/`, `test-d/`, and
  `scripts/`; `scripts/check-version-bump.sh` fails the PR otherwise.
- Put user-facing behavior in `README.md`.
