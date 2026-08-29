import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSchema, type CompiledSchema } from './schema.js';

export async function loadDefault(path: string): Promise<unknown> {
  const absolute = resolve(process.cwd(), path);
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(absolute).href) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`could not load ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!('default' in module)) throw new Error(`${path}: module has no default export`);
  return module.default;
}

export async function loadSchema(path: string): Promise<CompiledSchema> {
  return compileSchema(await loadDefault(path));
}
