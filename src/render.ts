import { blockedAdvice, type DriftItem } from './changes.js';
import type { FleetResult, StoreOutcome } from './fleet.js';
import type { PlanItem } from './planner.js';
import type { CanonicalMetafield, CanonicalMetaobject } from './schema.js';

// One line per definition that needs attention, and a count for the rest: a fleet report is read
// to find the exceptions, and a definition that already matches has nothing to say.
export function renderFleet(result: FleetResult): string {
  const lines: string[] = [];
  for (const outcome of result.stores) {
    if (outcome.status !== 'planned') {
      const label = outcome.status === 'not-installed' ? 'NOT-INSTALLED' : 'UNREACHABLE';
      lines.push(`${label} ${outcome.store} ${outcome.code ?? 'error'}: ${outcome.reason ?? ''}`.trimEnd());
      continue;
    }
    lines.push(...renderStore(outcome));
  }
  lines.push('');
  return lines.join('\n');
}

function renderStore(outcome: StoreOutcome): string[] {
  const drift = new Map((outcome.drift?.items ?? []).map((entry) => [entry.item.identity, entry]));
  const created = new Set(outcome.created ?? []);
  const updated = new Set(outcome.updated ?? []);
  const skipped = new Set(outcome.skipped ?? []);
  const lines: string[] = [];
  let matched = 0;
  for (const item of outcome.plan?.items ?? []) {
    const entry = drift.get(item.identity);
    // --apply re-reads the store, so a definition it just wrote reads PRESENT here. The write
    // it performed is what the operator needs, not the state it left behind.
    if (created.has(item.identity)) lines.push(headline('CREATED', item));
    else if (updated.has(item.identity)) lines.push(headline('UPDATED', item));
    else if (entry === undefined) {
      if (item.status === 'CREATE') lines.push(headline('CREATE', item));
      else if (item.status === 'PRESENT') matched += 1;
      else lines.push(headline(item.status, item), ...indented(item.reasons));
    } else if (skipped.has(item.identity)) lines.push(...renderDeferred(entry));
    else lines.push(headline('UPDATE', item), ...indented(entry.applies));
  }
  const store = `STORE ${outcome.store}`;
  lines.unshift(matched > 0 ? `${store} (${String(matched)} in sync)` : store);
  if (outcome.refused !== undefined) lines.push(`REFUSED ${outcome.store}: ${outcome.refused}`);
  return lines;
}

// The refusal carries the teaching, so the generic flag name costs nothing. BLOCKED matters
// most: saying "--force cannot do this" is what stops someone reaching for it here.
function renderDeferred(entry: DriftItem): string[] {
  if (entry.blocked.length === 0) {
    return [
      headline('SKIPPED', entry.item),
      ...indented(entry.needsForce),
      '  re-run with --force to apply it',
    ];
  }
  const advice = [...new Set(entry.blocked.map((reason) => blockedAdvice(entry.item, reason)))];
  return [headline('BLOCKED', entry.item), ...indented(entry.blocked), ...indented(advice)];
}

// The identity says where a definition lives; the shape says what it is, which is what an
// operator checks before letting a write land on a store they cannot preview.
function headline(label: string, item: PlanItem): string {
  return `${label} ${item.identity} ${shape(item.desired)}`;
}

function shape(desired: CanonicalMetaobject | CanonicalMetafield): string {
  return desired.kind === 'metafield' ? desired.type : `${String(desired.fields.length)} field(s)`;
}

function indented(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`);
}
