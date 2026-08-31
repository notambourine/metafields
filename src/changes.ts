import type { Plan, PlanItem } from './planner.js';

export interface DriftItem {
  item: PlanItem;
  // Three buckets on one axis: what `--apply` writes, what it writes only under `--force`, and
  // what no flag reaches. A definition with anything blocked is skipped whole, and so is one
  // with anything needing force that was not forced: a partial update to a definition whose
  // type is wrong reads like progress and is not.
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
    // Notices as well as reasons: name and description are labels, so no stored value can be
    // lost by rewriting one. They stay out of the plan status, so a definition drifted only
    // cosmetically is still PRESENT and still exits 0.
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

// The definitions this run rewrites. Everything else is left exactly as the store has it.
export function written(drift: DriftPlan, force: boolean): DriftItem[] {
  return drift.items.filter((entry) => writes(entry, force));
}

// The drift still standing after this run: what force cannot reach, plus what it could have
// reached had it been passed. Post-apply verification ignores these; the exit code does not.
export function deferred(drift: DriftPlan, force: boolean): DriftItem[] {
  return drift.items.filter((entry) => !writes(entry, force));
}

// The attributes an update carries, so a write never states an opinion about something the
// operator did not declare drifted.
export function changedPaths(entry: DriftItem, force: boolean): string[] {
  const reasons = force ? [...entry.applies, ...entry.needsForce] : entry.applies;
  return reasons.map((reason) => attribute(entry.item, reason));
}

// Reasons carry the item identity for metafields but not for metaobjects, so strip it before
// matching an attribute path.
export function attribute(item: PlanItem, reason: string): string {
  return reason.startsWith(`${item.identity}.`) ? reason.slice(item.identity.length + 1) : reason;
}

// Why `--force` is the wrong reach. Someone hitting an unrelated refusal and typing `--force`
// is the one failure mode a generic flag name creates; saying so where they are looking closes it.
export function blockedAdvice(item: PlanItem, reason: string): string {
  const path = attribute(item, reason);
  if (/(^|\.)type: expected /.test(path)) {
    return 'Shopify will not retype a definition that holds values. --force cannot do this; use a migration.';
  }
  if (path.startsWith('stored values include ')) {
    return 'Invalid stored values are data, not shape. --force cannot do this; correct the values.';
  }
  if (item.status === 'INDETERMINATE') {
    return 'Shopify is still validating stored values. --force cannot do this; wait and re-run.';
  }
  return 'This definition cannot be read back for update. --force cannot do this.';
}

type Bucket = 'apply' | 'force' | 'blocked';

function writes(entry: DriftItem, force: boolean): boolean {
  return entry.blocked.length === 0 && (force || entry.needsForce.length === 0);
}

function bucketFor(item: PlanItem, reason: string): Bucket {
  // IN_PROGRESS validation: wait, do not write, not even a label.
  if (item.status === 'INDETERMINATE') return 'blocked';
  // A metaobject update needs the definition's Shopify id, which only a read supplies.
  if (item.kind === 'metaobject' && item.existing?.id === undefined) return 'blocked';
  const path = attribute(item, reason);
  // Shopify will not retype a definition that has stored values; that is what migrations are for.
  if (/(^|\.)type: expected /.test(path)) return 'blocked';
  // Invalid stored values are data, not shape.
  if (path.startsWith('stored values include ')) return 'blocked';
  // Bucketed by attribute, not by direction, so loosening a validation still asks for the flag.
  // Capabilities are the exception: the direction is already a boolean in the reason string,
  // and enabling one (adminFilterable, most often) is both common and harmless.
  if (/(^|\.)capabilities\.[^:]+: expected false/.test(path)) return 'force';
  if (/(^|\.)access\./.test(path)) return 'force';
  if (/(^|\.)(validations|constraints) differ$/.test(path)) return 'force';
  if (/(^|\.)required: expected true/.test(path)) return 'force';
  return 'apply';
}
