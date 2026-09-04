import { blockedAdvice, type DriftItem, type DriftPlan } from './changes.js';
import type { FleetResult, StoreOutcome } from './fleet.js';
import type { Plan, PlanItem } from './planner.js';
import type { CanonicalMetafield, CanonicalMetaobject } from './schema.js';

export type ReportedItem = Omit<PlanItem, 'desired' | 'existing'>;
export type ReportedDrift = Omit<DriftItem, 'item'> & { identity: string };

export interface ReportedStore extends Omit<StoreOutcome, 'plan' | 'drift'> {
  plan?: Omit<Plan, 'items'> & { items: ReportedItem[] };
  drift?: Omit<DriftPlan, 'items'> & { items: ReportedDrift[] };
}

export interface FleetReport extends Omit<FleetResult, 'stores'> {
  stores: ReportedStore[];
}

export function fleetReport(result: FleetResult): FleetReport {
  return { ...result, stores: result.stores.map(reportedStore) };
}

function reportedStore(outcome: StoreOutcome): ReportedStore {
  const { plan, drift, ...rest } = outcome;
  return {
    ...rest,
    ...(plan && { plan: { ...plan, items: plan.items.map(reportedItem) } }),
    ...(drift && { drift: { ...drift, items: drift.items.map(reportedDrift) } }),
  };
}

function reportedItem(item: PlanItem): ReportedItem {
  const { desired, existing, ...rest } = item;
  return rest;
}

function reportedDrift(entry: DriftItem): ReportedDrift {
  const { item, ...rest } = entry;
  return { identity: item.identity, ...rest };
}

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
    // After apply re-reads, retain the action performed instead of reporting PRESENT.
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

function headline(label: string, item: PlanItem): string {
  return `${label} ${item.identity} ${shape(item.desired)}`;
}

function shape(desired: CanonicalMetaobject | CanonicalMetafield): string {
  return desired.kind === 'metafield' ? desired.type : `${String(desired.fields.length)} field(s)`;
}

function indented(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`);
}
