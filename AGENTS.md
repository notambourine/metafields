# Repository instructions

- Keep `README.md` focused on the public setup, safety contract, and operator workflows.
- Use erasable TypeScript and `.js` suffixes for relative imports.
- Centralize drift risk in `src/changes.ts`; keep consumers policy-free.
- Derive Shopify type metadata through `npm run generate:metafield-types`; never edit generated output.
- Validate the complete schema before the first request and keep credentials out of diagnostics.
- Bump the package version for publishable changes.
