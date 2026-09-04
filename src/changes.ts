import type { Plan, PlanItem } from './planner.js';

export interface DriftItem {
  item: PlanItem;
  applies: string[];
  needsForce: string[];
  blocked: string[];
}

export interface DriftPlan {
  items: DriftItem[];
  applies: number;
  needsForce: number;
  blocked: number;
}

export function classifyDrift(plan: Plan): DriftPlan {
  const items: DriftItem[] = [];
  for (const item of plan.items) {
    if (item.status === 'CREATE') continue;
    const buckets: Record<Bucket, string[]> = { apply: [], force: [], blocked: [] };
    // Labels remain notices so cosmetic drift exits 0.
    for (const reason of [...item.reasons, ...item.notices]) buckets[bucketFor(item, reason)].push(reason);
    const entry: DriftItem = { item, applies: buckets.apply, needsForce: buckets.force, blocked: buckets.blocked };
    if (entry.applies.length + entry.needsForce.length + entry.blocked.length > 0) items.push(entry);
  }
  return {
    items,
    applies: items.filter((entry) => writes(entry, false)).length,
    needsForce: items.filter((entry) => !writes(entry, false) && writes(entry, true)).length,
    blocked: items.filter((entry) => entry.blocked.length > 0).length,
  };
}

export function written(drift: DriftPlan, force: boolean): DriftItem[] {
  return drift.items.filter((entry) => writes(entry, force));
}

export function deferred(drift: DriftPlan, force: boolean): DriftItem[] {
  return drift.items.filter((entry) => !writes(entry, force));
}

export function changedPaths(entry: DriftItem, force: boolean): string[] {
  const reasons = force ? [...entry.applies, ...entry.needsForce] : entry.applies;
  return reasons.map((reason) => attribute(entry.item, reason));
}

export function attribute(item: PlanItem, reason: string): string {
  return reason.startsWith(`${item.identity}.`) ? reason.slice(item.identity.length + 1) : reason;
}

export function blockedAdvice(item: PlanItem, reason: string): string {
  const path = attribute(item, reason);
  if (/(^|\.)type: expected /.test(path)) {
    return 'Retyping definitions with stored values is unsupported. Use a migration.';
  }
  if (path.startsWith('stored values include ')) {
    return 'Invalid stored values block schema updates. Correct the values.';
  }
  if (item.status === 'INDETERMINATE') {
    return 'Shopify is validating stored values. Wait and rerun.';
  }
  return 'The stored definition lacks the ID required for updates.';
}

type Bucket = 'apply' | 'force' | 'blocked';

function writes(entry: DriftItem, force: boolean): boolean {
  return entry.blocked.length === 0 && (force || entry.needsForce.length === 0);
}

function bucketFor(item: PlanItem, reason: string): Bucket {
  // Do not write while validation is in progress.
  if (item.status === 'INDETERMINATE') return 'blocked';
  // Metaobject updates require the stored definition ID.
  if (item.kind === 'metaobject' && item.existing?.id === undefined) return 'blocked';
  const path = attribute(item, reason);
  // Retypes require a migration.
  if (/(^|\.)type: expected /.test(path)) return 'blocked';
  // Stored-value errors are data problems, not schema drift.
  if (path.startsWith('stored values include ')) return 'blocked';
  // Risk follows the attribute. Enabling a capability is the safe directional exception.
  if (/(^|\.)capabilities\.[^:]+: expected false/.test(path)) return 'force';
  if (/(^|\.)access\./.test(path)) return 'force';
  if (/(^|\.)(validations|constraints) differ$/.test(path)) return 'force';
  if (/(^|\.)required: expected true/.test(path)) return 'force';
  return 'apply';
}
