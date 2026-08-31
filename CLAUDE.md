# metafields

Preserve these constraints in every change.

## Product

- Operate on definitions only. Never write values or metaobject entries.
- Never delete or retype definitions or fields.
- Let `--force` override risk policy only, never Shopify constraints or data problems.
- Keep each definition atomic and update only attributes reported as drifted.
- Retry mutations only when Shopify rejects them as `THROTTLED`.
- Keep credentials out of logs and errors.
- Make exit codes describe remaining store state, not the selected mode.

## Code

- Use erasable TypeScript and `.js` suffixes for relative imports.
- Centralize drift risk in `src/changes.ts`; keep its consumers policy-free.
- Derive Shopify type metadata from the generated registry table.
- Validate the complete schema before making the first request.
- Explain only non-obvious choices and traps in comments, in at most two lines.

## Delivery

- Document user-facing behavior in `README.md`.
- Bump the package version for publishable changes.
- Regenerate metafield types through the package script; never edit generated output.
