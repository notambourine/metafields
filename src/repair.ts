import { planFrom, type Plan, type PlanItem } from './planner.js';

export interface RepairItem {
  item: PlanItem;
  // The drift `--repair` will resolve, and the drift nothing can. An item with any blocker is
  // reported and skipped whole: a partial update to a definition whose type is wrong reads
  // like progress and is not.
  repairs: string[];
  blockers: string[];
}

export interface RepairPlan {
  items: RepairItem[];
  repairable: number;
  blocked: number;
}

export function planRepair(plan: Plan): RepairPlan {
  const items: RepairItem[] = [];
  for (const item of plan.items) {
    if (item.status !== 'CONFLICT' && item.status !== 'INDETERMINATE') continue;
    const repairs: string[] = [];
    const blockers: string[] = [];
    for (const reason of item.reasons) {
      (isRepairable(item, reason) ? repairs : blockers).push(reason);
    }
    if (repairs.length === 0 && blockers.length === 0) continue;
    items.push({ item, repairs, blockers });
  }
  return {
    items,
    repairable: items.filter((entry) => entry.blockers.length === 0).length,
    blocked: items.filter((entry) => entry.blockers.length > 0).length,
  };
}

// The plan items `--repair` can resolve, so a store still holding unrepairable drift keeps
// blocking every write in the fleet.
export function withoutRepairs(plan: Plan, repair: RepairPlan): Plan {
  const resolved = new Set(repair.items.filter((entry) => entry.blockers.length === 0)
    .map((entry) => entry.item.identity));
  return planFrom(plan.items.filter((item) => !resolved.has(item.identity)));
}

export function repairedIdentities(repair: RepairPlan): RepairItem[] {
  return repair.items.filter((entry) => entry.blockers.length === 0);
}

// Reasons carry the item identity for metafields but not for metaobjects, so strip it before
// matching an attribute path.
export function attribute(item: PlanItem, reason: string): string {
  return reason.startsWith(`${item.identity}.`) ? reason.slice(item.identity.length + 1) : reason;
}

function isRepairable(item: PlanItem, reason: string): boolean {
  // IN_PROGRESS validation: wait, do not write.
  if (item.status === 'INDETERMINATE') return false;
  const path = attribute(item, reason);
  // Shopify will not retype a definition that has stored values; that is what migrations are for.
  if (/(^|\.)type: expected /.test(path)) return false;
  // Invalid stored values are data, not shape.
  if (path.startsWith('stored values include ')) return false;
  // A metaobject update needs the definition's Shopify id, which only a read supplies.
  if (item.kind === 'metaobject' && item.existing?.id === undefined) return false;
  return true;
}
