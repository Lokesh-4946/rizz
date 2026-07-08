import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface DbmsFileFact {
  readonly relativePath: string;
}

export interface DatabaseTableInference {
  readonly name: string;
  readonly kind: 'sql_table' | 'mongoose_model';
  readonly sourceFile: string;
  readonly declaration: string;
  readonly fields: readonly string[];
}

export function singularToken(value: string): string {
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}

export function routePrecisionTokens(value: string): string[] {
  return unique(
    value
      .toLowerCase()
      .replace(/controller|handler|route/g, ' ')
      .split(/[^a-z0-9]+/)
      .map(singularToken)
      .filter(
        (part) =>
          part.length > 1 &&
          ![
            'api',
            'app',
            'controller',
            'controllers',
            'handler',
            'handlers',
            'index',
            'route',
            'routes',
            'server',
            'src',
          ].includes(part),
      ),
  );
}

export function isRouteOrControllerFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(routes?|controllers?|handlers?)\//.test(lower) ||
    /(?:route|controller|handler)\.[cm]?[jt]sx?$/.test(lower)
  );
}

export function routeChangedFileMatchesRoutePath(
  file: string,
  routePath: string | undefined,
): boolean {
  if (routePath === undefined) return false;
  const fileTokens = routePrecisionTokens(file);
  const routeTokens = routePrecisionTokens(routePath);
  if (fileTokens.length === 0 || routeTokens.length === 0) return true;
  return fileTokens.some((token) => routeTokens.includes(token));
}

export function isUsableQualityCommand(command: string): boolean {
  if (!/test|check|lint|typecheck|vitest/i.test(command)) return false;
  return !/no test specified|exit\s+1|not implemented|todo|missing test/i.test(command);
}

export function detectPackageManagerFromFiles(files: readonly DbmsFileFact[]): string {
  const lockfiles = files
    .map((file) => file.relativePath)
    .filter((path) =>
      /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/.test(path),
    );
  const rootLocks = new Set(lockfiles.filter((path) => !path.includes('/')));
  if (rootLocks.has('pnpm-lock.yaml')) return 'pnpm';
  if (rootLocks.has('yarn.lock')) return 'yarn';
  if (rootLocks.has('package-lock.json')) return 'npm';
  if (rootLocks.has('bun.lockb') || rootLocks.has('bun.lock')) return 'bun';
  const nestedManagers = unique(
    lockfiles.map((path) => {
      const name = basename(path);
      if (name === 'pnpm-lock.yaml') return 'pnpm';
      if (name === 'yarn.lock') return 'yarn';
      if (name === 'package-lock.json') return 'npm';
      return 'bun';
    }),
  );
  if (nestedManagers.length === 1) return `${nestedManagers[0]} (nested)`;
  if (nestedManagers.length > 1) {
    return `${nestedManagers.sort((a, b) => a.localeCompare(b)).join('+')} (nested)`;
  }
  return 'unknown';
}

export function inferDatabaseTables(
  rootDir: string,
  files: readonly DbmsFileFact[],
): DatabaseTableInference[] {
  const tables: DatabaseTableInference[] = [];
  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    if (!/\.(sql|ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) continue;
    const text = readTextIfAvailable(rootDir, file.relativePath) ?? '';
    if (lower.endsWith('.sql')) {
      for (const match of text.matchAll(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?([`"[]?[\w.-]+[`"\]]?)/gi,
      )) {
        const name = dbEntityName(match[1] ?? 'unknown_table');
        tables.push({
          name,
          kind: 'sql_table',
          sourceFile: file.relativePath,
          declaration: (match[0] ?? `CREATE TABLE ${name}`).slice(0, 120),
          fields: [],
        });
      }
    }
    if (!/mongoose|Schema\s*\(|\.model\s*\(/.test(text)) continue;
    const schemaNames = new Set(
      [
        ...text.matchAll(
          /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:mongoose\.)?Schema/g,
        ),
      ].map((match) => match[1] ?? ''),
    );
    for (const match of text.matchAll(
      /(?:mongoose\.)?model\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)/g,
    )) {
      const modelName = match[1] ?? 'unknown_model';
      const schemaName = match[2] ?? '';
      tables.push({
        name: modelName,
        kind: 'mongoose_model',
        sourceFile: file.relativePath,
        declaration: `mongoose.model(${modelName})`,
        fields: mongooseSchemaFields(text, schemaName),
      });
      schemaNames.delete(schemaName);
    }
    for (const schemaName of schemaNames) {
      const modelName = schemaName.replace(/Schema$/, '');
      if (modelName === '') continue;
      tables.push({
        name: modelName,
        kind: 'mongoose_model',
        sourceFile: file.relativePath,
        declaration: `Mongoose schema ${schemaName}`,
        fields: mongooseSchemaFields(text, schemaName),
      });
    }
  }
  return uniqueBy(tables, (table) => `${table.kind}:${table.sourceFile}:${table.name}`);
}

function stripSqlIdentifier(value: string): string {
  return value.replaceAll('`', '').replaceAll('"', '').replaceAll('[', '').replaceAll(']', '');
}

function dbEntityName(value: string): string {
  const parts = stripSqlIdentifier(value).split('.');
  return parts[parts.length - 1] ?? value;
}

function mongooseSchemaFields(text: string, schemaName: string): string[] {
  const start = new RegExp(`${schemaName}\\s*=\\s*new\\s+(?:mongoose\\.)?Schema\\s*\\(`).exec(text);
  if (start === null) return [];
  const end = text.indexOf(');', start.index);
  const matchText = end === -1 ? text.slice(start.index) : text.slice(start.index, end);
  return unique(
    [...matchText.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((item) => item[1] ?? ''),
  ).slice(0, 20);
}

function readTextIfAvailable(rootDir: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(rootDir, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
