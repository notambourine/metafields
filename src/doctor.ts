
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
        summary: `Shopify rejects API version ${version}`,
        details: [
          version === DEFAULT_API_VERSION
            ? 'DEFAULT_API_VERSION is unsupported; upgrade @notambourine/metafields'
            : 'pass a supported version with --api-version',
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
      // A nondefault version mismatch does not imply stale bundled metadata.
      details: types.matches ? [] : [...differences, version === DEFAULT_API_VERSION
        ? 'upgrade @notambourine/metafields or report stale metadata in the current release'
        : `bundled registry uses ${DEFAULT_API_VERSION}; requested ${version}`],
    },
  ]);
}

function detail(kind: string, noun: string, name: string, extra?: string): string {
  return `${kind} ${noun} ${name}${extra === undefined ? '' : `: ${extra}`}`;
}

export function doctorExitCode(report: DoctorReport): number {
  return report.healthy ? 0 : 1;
}
