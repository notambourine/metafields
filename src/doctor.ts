// What an adopting repo can check in CI without a store, a token, or an app.
//
// Every check answers the same question from a different side: does this installed release
// still describe the Shopify API you are pointing it at. A check that fails is a finding
// somebody can act on. A check that cannot run at all is not a finding, and throws instead.

import { DEFAULT_API_VERSION } from './admin.js';
import { compareRegistry } from './type-check.js';
import { fetchRegistry, RegistryError, type Registry } from './type-registry.js';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface DoctorReport {
  readonly version: string;
  readonly healthy: boolean;
  readonly checks: readonly DoctorCheck[];
}

export type FetchRegistry = (version: string) => Promise<Registry>;

function report(version: string, checks: DoctorCheck[]): DoctorReport {
  return { version, healthy: checks.every((check) => check.ok), checks };
}

export async function runDoctor(
  version: string = DEFAULT_API_VERSION,
  fetch: FetchRegistry = fetchRegistry,
): Promise<DoctorReport> {
  let registry: Registry;
  try {
    registry = await fetch(version);
  } catch (error) {
    if (error instanceof RegistryError && error.kind === 'unsupported-version') {
      return report(version, [{
        name: 'api-version',
        ok: false,
        summary: `api version ${version} is not one Shopify serves`,
        details: [
          version === DEFAULT_API_VERSION
            ? 'this release pins a version that has aged out; upgrade @notambourine/metafields'
            : 'pass --api-version with a version Shopify still supports',
        ],
      }]);
    }
    throw error;
  }

  const types = compareRegistry(registry);
  const differences = [
    ...types.types.map((difference) => detail(difference.kind, 'type', difference.name, difference.detail)),
    ...types.owners.map((difference) => detail(difference.kind, 'owner', difference.name, difference.detail)),
  ];
  return report(version, [
    {
      name: 'api-version',
      ok: true,
      summary: `api version ${version} is supported`,
      details: [],
    },
    {
      name: 'metafield-types',
      ok: types.matches,
      summary: types.matches
        ? `type table matches the Admin API ${version}`
        : `type table differs from the Admin API ${version}`,
      // No upgrade carries a table for a version this release was not generated against, so
      // saying "upgrade" off-version would send someone after a release that cannot exist.
      details: types.matches ? [] : [...differences, version === DEFAULT_API_VERSION
        ? 'upgrade @notambourine/metafields, or open an issue if it is already current'
        : `this release ships the table for ${DEFAULT_API_VERSION}, not ${version}`],
    },
  ]);
}

function detail(kind: string, noun: string, name: string, extra?: string): string {
  return `${kind} ${noun} ${name}${extra === undefined ? '' : `: ${extra}`}`;
}

export function doctorExitCode(report: DoctorReport): number {
  return report.healthy ? 0 : 1;
}
