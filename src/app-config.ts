import { readFile } from 'node:fs/promises';

export interface AppConfig {
  clientId: string;
}

// Ignore section-scoped client IDs. A TOML dependency is unnecessary for one top-level string.
export async function readAppConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const line of text.split(/\r?\n/)) {
    const statement = withoutComment(line).trim();
    if (statement.startsWith('[')) break;
    const match = /^client_id\s*=\s*(.*)$/.exec(statement);
    if (!match) continue;
    const clientId = unquote((match[1] ?? '').trim());
    if (clientId === undefined || clientId.length === 0) {
      throw new Error(`${path}: client_id must be a non-empty quoted string`);
    }
    return { clientId };
  }
  throw new Error(`${path}: no top-level client_id; expected a Shopify app TOML`);
}

function withoutComment(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote.length > 0) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquote(value: string): string | undefined {
  const quote = value[0];
  if (value.length < 2 || (quote !== '"' && quote !== "'") || !value.endsWith(quote)) return undefined;
  return value.slice(1, -1);
}
