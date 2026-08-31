import { AdminError, applyPlan, planStore, type AdminClient } from './admin.js';
import { GrantError } from './auth.js';
import { assertDescriptionLengths } from './limits.js';
import { exitCodeForPlan, type Plan, type SyncMode } from './planner.js';
import { planRepair, withoutRepairs, type RepairPlan } from './repair.js';
import type { CompiledSchema } from './schema.js';

export interface StoreTarget {
  store: string;
  // A store the operator named fails loudly. Only a store reached by a sweep is
  // downgraded to a report, so a typo never passes as an absent store.
  explicit: boolean;
}

export interface StoreOutcome {
  store: string;
  status: 'planned' | 'not-installed' | 'unreachable';
  code?: string;
  reason?: string;
  plan?: Plan;
  repair?: RepairPlan;
  applied?: string[];
  repaired?: string[];
  refused?: string;
}

export interface FleetResult {
  mode: SyncMode;
  stores: StoreOutcome[];
}

export type Connect = (store: string) => Promise<AdminClient>;

export interface FleetOptions {
  // Opt-in only, never implied by --apply: the sole way a definition is rewritten is a
  // human typing the flag.
  repair?: boolean;
}

export async function synchronizeFleet(
  targets: readonly StoreTarget[],
  schema: CompiledSchema,
  mode: SyncMode,
  connect: Connect,
  options: FleetOptions = {},
): Promise<FleetResult> {
  assertDescriptionLengths(schema);
  const stores: StoreOutcome[] = [];
  const reached: { client: AdminClient; outcome: StoreOutcome & { plan: Plan } }[] = [];
  for (const target of targets) {
    try {
      const client = await connect(target.store);
      const plan = await planStore(client, schema);
      const outcome: StoreOutcome & { plan: Plan } = { store: target.store, status: 'planned', plan };
      if (options.repair) outcome.repair = planRepair(plan);
      stores.push(outcome);
      reached.push({ client, outcome });
    } catch (error) {
      if (target.explicit) throw error;
      stores.push(swept(target.store, error));
    }
  }
  if (reached.length === 0) throw new AdminError('no store could be planned');
  // Plan every store before writing to any: drift on one store that a repair cannot resolve
  // means the declared schema and that store disagree, and writing to the rest half-applies
  // the fleet.
  const blocked = reached.some(({ outcome }) => exitCodeForPlan(outstanding(outcome), mode) !== 0);
  if (mode !== 'apply' || blocked) return { mode, stores };
  // Per store, so one store refusing a write does not stop the next.
  for (const { client, outcome } of reached) {
    try {
      const result = await applyPlan(client, schema, outcome.plan, outcome.repair);
      outcome.plan = result.plan;
      outcome.applied = result.applied;
      outcome.repaired = result.repaired;
    } catch (error) {
      outcome.refused = error instanceof Error ? error.message : String(error);
    }
  }
  return { mode, stores };
}

function outstanding(outcome: StoreOutcome & { plan: Plan }): Plan {
  return outcome.repair ? withoutRepairs(outcome.plan, outcome.repair) : outcome.plan;
}

export function fleetExitCode(result: FleetResult, mode: SyncMode): number {
  let code = 0;
  for (const outcome of result.stores) {
    // A store that has simply not installed the app is not a failure; a fleet sweep stays green.
    if (outcome.status === 'unreachable' || outcome.refused !== undefined) code = Math.max(code, 2);
    else if (outcome.plan) code = Math.max(code, exitCodeForPlan(outcome.plan, mode));
  }
  return code;
}

function swept(store: string, error: unknown): StoreOutcome {
  const code = error instanceof GrantError ? error.code : 'unreachable';
  const reason = error instanceof Error ? error.message : String(error);
  return code === 'app_not_installed'
    ? { store, status: 'not-installed', code, reason }
    : { store, status: 'unreachable', code, reason };
}
