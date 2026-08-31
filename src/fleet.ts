import { AdminError, applyPlan, planStore, type AdminClient } from './admin.js';
import { GrantError } from './auth.js';
import { assertDescriptionLengths } from './limits.js';
import { exitCodeForPlan, type Plan, type SyncMode } from './planner.js';
import { classifyDrift, deferred, type DriftPlan } from './changes.js';
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
  drift?: DriftPlan;
  created?: string[];
  updated?: string[];
  skipped?: string[];
  refused?: string;
}

export interface FleetResult {
  mode: SyncMode;
  stores: StoreOutcome[];
}

export type Connect = (store: string) => Promise<AdminClient>;

export interface FleetOptions {
  // Overrides the tool's own judgment about which updates can break something live. It never
  // overrides a Shopify constraint and never overrides a data problem.
  force?: boolean;
}

export async function synchronizeFleet(
  targets: readonly StoreTarget[],
  schema: CompiledSchema,
  mode: SyncMode,
  connect: Connect,
  options: FleetOptions = {},
): Promise<FleetResult> {
  assertDescriptionLengths(schema);
  const force = options.force ?? false;
  const stores: StoreOutcome[] = [];
  const reached: { client: AdminClient; outcome: StoreOutcome & { plan: Plan; drift: DriftPlan } }[] = [];
  for (const target of targets) {
    try {
      const client = await connect(target.store);
      const plan = await planStore(client, schema);
      const drift = classifyDrift(plan);
      const outcome: StoreOutcome & { plan: Plan; drift: DriftPlan } = {
        store: target.store,
        status: 'planned',
        plan,
        drift,
        skipped: deferred(drift, force).map((entry) => entry.item.identity),
      };
      stores.push(outcome);
      reached.push({ client, outcome });
    } catch (error) {
      if (target.explicit) throw error;
      stores.push(swept(target.store, error));
    }
  }
  if (reached.length === 0) throw new AdminError('no store could be planned');
  if (mode !== 'apply') return { mode, stores };
  // Identical per-store plans preserve uniformity without letting one refusal stop the fleet.
  for (const { client, outcome } of reached) {
    try {
      const result = await applyPlan(client, schema, outcome.plan, outcome.drift, force);
      outcome.plan = result.plan;
      outcome.created = result.created;
      outcome.updated = result.updated;
      outcome.skipped = result.skipped;
    } catch (error) {
      outcome.refused = error instanceof Error ? error.message : String(error);
    }
  }
  return { mode, stores };
}

export function fleetExitCode(result: FleetResult): number {
  let code = 0;
  for (const outcome of result.stores) {
    // A store that has simply not installed the app is not a failure; a fleet sweep stays green.
    if (outcome.status === 'unreachable' || outcome.refused !== undefined) code = Math.max(code, 2);
    else if (outcome.plan) code = Math.max(code, exitCodeForPlan(outcome.plan));
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
