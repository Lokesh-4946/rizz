import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface DbmsFileFact {
  readonly relativePath: string;
}

export interface DatabaseTableInference {
  readonly name: string;
  readonly kind: 'sql_table' | 'mongoose_model' | 'sqlalchemy_model' | 'alembic_table';
  readonly sourceFile: string;
  readonly declaration: string;
  readonly fields: readonly string[];
  readonly relationships: readonly DatabaseTableRelationshipInference[];
  readonly modelName?: string;
}

export interface DatabaseTableRelationshipInference {
  readonly kind: 'foreign_key' | 'relationship';
  readonly sourceField: string;
  readonly targetTable: string;
  readonly targetField?: string;
  readonly targetModel?: string;
  readonly inverseField?: string;
  readonly declaration: string;
}

export interface DatabaseTableRelationshipData {
  readonly kind: 'foreign_key' | 'relationship';
  readonly source_field: string;
  readonly target_table: string;
  readonly target_field?: string;
  readonly target_model?: string;
  readonly inverse_field?: string;
  readonly declaration: string;
}

export interface DatabaseTableGraphIndex {
  readonly idsByName: ReadonlyMap<string, readonly string[]>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly idByTableKey: ReadonlyMap<string, string>;
}

export interface DatabaseTableFlowLabels {
  readonly labelsByFile: ReadonlyMap<string, readonly string[]>;
  readonly sourceByLabel: ReadonlyMap<string, string>;
}

export interface DatabaseTableRelationshipEdge {
  readonly from: string;
  readonly relation: 'depends_on' | 'used_by';
  readonly to: string;
  readonly evidenceFile: string;
  readonly confidence: 'verified' | 'inferred';
}

export interface DatabaseTableEntityData {
  readonly [key: string]: unknown;
  readonly kind: DatabaseTableInference['kind'];
  readonly declaration: string;
  readonly fields: readonly string[];
  readonly relationships: readonly DatabaseTableRelationshipData[];
}

export interface DbmsCommandFact {
  readonly name: string;
  readonly source_files: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
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
    /(?:route|controller|handler)\.[cm]?[jt]sx?$/.test(lower) ||
    /(?:route|controller|handler|views?)\.py$/.test(lower)
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

export function databaseTableDescription(table: DatabaseTableInference): string {
  const source = table.sourceFile;
  switch (table.kind) {
    case 'alembic_table':
      return `Alembic table ${table.name} inferred from ${source}.`;
    case 'mongoose_model':
      return `Mongoose model ${table.name} inferred from ${source}.`;
    case 'sql_table':
      return `SQL table ${table.name} inferred from ${source}.`;
    case 'sqlalchemy_model':
      return `SQLAlchemy model ${table.name} inferred from ${source}.`;
  }
}

export function requiredTestCommands(
  commands: readonly DbmsCommandFact[],
  changedFiles: readonly string[],
): string[] {
  const quality = commands
    .map((command) => {
      const text = typeof command.data?.command === 'string' ? command.data.command : undefined;
      if (text === undefined) return undefined;
      const manifest =
        typeof command.data?.manifest === 'string'
          ? command.data.manifest
          : command.source_files[0];
      return {
        command,
        manifest,
        scope: packageScope(manifest),
        text: `${command.name}: ${text}`,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .filter((item) => isUsableQualityCommand(item.text));
  if (quality.length === 0) {
    return changedFiles.some(isSourceLikePath)
      ? ['Run the project test command; none was detected in the brain.']
      : ['Review-only change: verify docs/report output manually.'];
  }
  const scoped = quality.filter(
    (item) =>
      item.scope !== undefined && changedFiles.some((file) => fileIsInScope(file, item.scope)),
  );
  if (scoped.length > 0) return scoped.map((item) => item.text).slice(0, 5);
  const rootScoped = quality.filter((item) => item.scope === undefined);
  if (rootScoped.length > 0) return rootScoped.map((item) => item.text).slice(0, 5);
  const changedHasNestedScope = changedFiles.some((file) => file.includes('/'));
  if (!changedHasNestedScope) return quality.map((item) => item.text).slice(0, 5);
  return changedFiles.some(isSourceLikePath)
    ? ['Run the project test command; none was detected in the brain.']
    : ['Review-only change: verify docs/report output manually.'];
}

export function stateOperationsFromText(text: string): string[] {
  const operations = new Set<string>();
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [
      /select|findMany|findUnique|findFirst|findOne|findById|\bfind\b|\bget\b|read|query|search|lookup/i,
      'read',
    ],
    [/insert|create|save|write|setItem|set\(|append|push/i, 'write'],
    [/update|upsert|mutate|patch|replace/i, 'update'],
    [/delete|remove|destroy|drop|truncate/i, 'delete'],
    [/schema|model|table|migration|migrate|prisma|zod|interface|type\s+\w+/i, 'schema'],
    [/redis|cache|ttl|expire|session/i, 'cache/session'],
    [/transaction|commit|rollback/i, 'transaction'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) operations.add(label);
  }
  return [...operations].sort((a, b) => a.localeCompare(b));
}

export function storageDependenciesFromText(text: string): string[] {
  const storage = new Set<string>();
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [/postgres|pg\.|psycopg|DATABASE_URL/i, 'postgres/database'],
    [/mysql|pymysql|mysqlclient/i, 'mysql/database'],
    [/sqlite|\.db\b/i, 'sqlite/database'],
    [/redis|ioredis/i, 'redis/cache'],
    [
      /SQLAlchemy|create_engine|prisma|typeorm|mongoose|sequelize|findOne|findById|findMany|\.save\(|\.create\(|\.update|\.delete|\.remove/i,
      'orm/database',
    ],
    [/chroma|pinecone|qdrant|weaviate|vector/i, 'vector/search store'],
    [/\/tmp\b|tmp\/|tempfile|NamedTemporaryFile/i, 'temporary filesystem'],
    [/writeFile|appendFile|fs\.|open\(|Path\(|pathlib/i, 'filesystem'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) storage.add(label);
  }
  return [...storage].sort((a, b) => a.localeCompare(b));
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
    if (!/\.(sql|ts|tsx|js|jsx|mjs|cjs|py)$/.test(lower)) continue;
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
          relationships: [],
        });
      }
    }
    if (lower.endsWith('.py')) {
      tables.push(...inferSqlAlchemyTables(file.relativePath, text));
      continue;
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
        relationships: [],
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
        relationships: [],
      });
    }
  }
  return uniqueBy(tables, (table) => `${table.kind}:${table.sourceFile}:${table.name}`);
}

export function databaseTableLookupKeys(table: DatabaseTableInference): string[] {
  return unique([table.name, ...(table.modelName === undefined ? [] : [table.modelName])]);
}

export function databaseTableGraphIndex(
  tables: readonly DatabaseTableInference[],
  entityIdForTable: (type: 'database/table', key: string) => string,
): DatabaseTableGraphIndex {
  const idsByName = new Map<string, string[]>();
  const nameById = new Map<string, string>();
  const idByTableKey = new Map<string, string>();
  for (const table of tables) {
    const tableId = databaseTableEntityId(table, entityIdForTable);
    idByTableKey.set(databaseTableKey(table), tableId);
    nameById.set(tableId, table.name);
    for (const key of databaseTableLookupKeys(table)) {
      idsByName.set(key, [...(idsByName.get(key) ?? []), tableId]);
    }
  }
  return { idsByName, nameById, idByTableKey };
}

export function databaseTableTargetIds(
  idsByName: ReadonlyMap<string, readonly string[]>,
  relationship: DatabaseTableRelationshipInference,
): string[] {
  return unique([
    ...(idsByName.get(relationship.targetTable) ?? []),
    ...(relationship.targetModel === undefined
      ? []
      : (idsByName.get(relationship.targetModel) ?? [])),
  ]);
}

export function databaseTableRelationshipData(params: {
  readonly table: DatabaseTableInference;
  readonly idsByName: ReadonlyMap<string, readonly string[]>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly sanitizeText: (value: string) => string;
}): DatabaseTableRelationshipData[] {
  return params.table.relationships.map((relationship) => {
    const targetTableId = databaseTableTargetIds(params.idsByName, relationship)[0];
    const targetTable =
      targetTableId === undefined
        ? relationship.targetTable
        : (params.nameById.get(targetTableId) ?? relationship.targetTable);
    return {
      kind: relationship.kind,
      source_field: params.sanitizeText(relationship.sourceField),
      target_table: params.sanitizeText(targetTable),
      ...(relationship.targetField !== undefined
        ? { target_field: params.sanitizeText(relationship.targetField) }
        : {}),
      ...(relationship.targetModel !== undefined
        ? { target_model: params.sanitizeText(relationship.targetModel) }
        : {}),
      ...(relationship.inverseField !== undefined
        ? { inverse_field: params.sanitizeText(relationship.inverseField) }
        : {}),
      declaration: params.sanitizeText(relationship.declaration),
    };
  });
}

export function databaseTableEntityData(params: {
  readonly table: DatabaseTableInference;
  readonly graphIndex: DatabaseTableGraphIndex;
  readonly sanitizeText: (value: string) => string;
}): DatabaseTableEntityData {
  return {
    kind: params.table.kind,
    declaration: params.sanitizeText(params.table.declaration),
    fields: params.table.fields.map(params.sanitizeText),
    relationships: databaseTableRelationshipData({
      table: params.table,
      idsByName: params.graphIndex.idsByName,
      nameById: params.graphIndex.nameById,
      sanitizeText: params.sanitizeText,
    }),
  };
}

export function databaseTableDependencyLabels(
  flows: readonly { readonly data_dependencies: readonly { readonly label: string }[] }[],
): string[] {
  return unique(
    flows
      .flatMap((flow) => flow.data_dependencies)
      .map((dependency) => dependency.label)
      .filter((label) => label.startsWith('database/table:')),
  );
}

export function databaseTableFlowLabels(params: {
  readonly tables: readonly DatabaseTableInference[];
  readonly flowFiles: readonly string[];
  readonly entityIdForTable: (type: 'database/table', key: string) => string;
}): DatabaseTableFlowLabels {
  const graphIndex = databaseTableGraphIndex(params.tables, params.entityIdForTable);
  const labelsByFile = new Map<string, string[]>();
  const sourceByLabel = new Map<string, string>();
  for (const table of params.tables) {
    sourceByLabel.set(databaseTableEntityId(table, params.entityIdForTable), table.sourceFile);
  }
  const flowFileSet = new Set(params.flowFiles);
  for (const table of params.tables.filter((item) => flowFileSet.has(item.sourceFile))) {
    const label = databaseTableEntityId(table, params.entityIdForTable);
    const relationshipLabels = table.relationships.flatMap((relationship) =>
      databaseTableTargetIds(graphIndex.idsByName, relationship),
    );
    labelsByFile.set(table.sourceFile, [
      ...(labelsByFile.get(table.sourceFile) ?? []),
      label,
      ...relationshipLabels,
    ]);
  }
  return { labelsByFile, sourceByLabel };
}

export function databaseTableRelationshipEdges(params: {
  readonly tables: readonly DatabaseTableInference[];
  readonly graphIndex: DatabaseTableGraphIndex;
}): DatabaseTableRelationshipEdge[] {
  const edges: DatabaseTableRelationshipEdge[] = [];
  for (const table of params.tables) {
    const tableId = params.graphIndex.idByTableKey.get(databaseTableKey(table));
    if (tableId === undefined) continue;
    for (const relationship of table.relationships) {
      for (const targetTableId of databaseTableTargetIds(
        params.graphIndex.idsByName,
        relationship,
      )) {
        if (targetTableId === tableId) continue;
        edges.push({
          from: tableId,
          relation: 'depends_on',
          to: targetTableId,
          evidenceFile: table.sourceFile,
          confidence: 'verified',
        });
        edges.push({
          from: targetTableId,
          relation: 'used_by',
          to: tableId,
          evidenceFile: table.sourceFile,
          confidence: 'inferred',
        });
      }
    }
  }
  return uniqueBy(edges, (edge) => `${edge.from}:${edge.relation}:${edge.to}:${edge.evidenceFile}`);
}

function databaseTableKey(table: DatabaseTableInference): string {
  return `${table.sourceFile}:${table.name}`;
}

function databaseTableEntityId(
  table: DatabaseTableInference,
  entityIdForTable: (type: 'database/table', key: string) => string,
): string {
  return entityIdForTable('database/table', databaseTableKey(table));
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
    [...matchText.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)]
      .map((item) => item[1] ?? '')
      .filter((field) => !MONGOOSE_OPTION_KEYS.has(field)),
  ).slice(0, 20);
}

const MONGOOSE_OPTION_KEYS = new Set([
  'default',
  'enum',
  'index',
  'maxlength',
  'minlength',
  'ref',
  'required',
  'select',
  'type',
  'unique',
  'validate',
]);

interface SqlAlchemyClassBlock {
  readonly className: string;
  readonly tableName: string;
  readonly classText: string;
}

function inferSqlAlchemyTables(sourceFile: string, text: string): DatabaseTableInference[] {
  const tables: DatabaseTableInference[] = [];
  const classBlocks = sqlAlchemyClassBlocks(text);
  const tableNameByClass = new Map(classBlocks.map((block) => [block.className, block.tableName]));
  for (const block of classBlocks) {
    const fields = unique(
      [
        ...block.classText.matchAll(
          /^\s*([A-Za-z_]\w*)\s*=\s*(?:db\.)?(?:Column|mapped_column)\s*\(/gm,
        ),
        ...block.classText.matchAll(
          /^\s*([A-Za-z_]\w*)\s*=\s*(?:db\.|sqlalchemy\.orm\.)?relationship\s*\(/gm,
        ),
      ]
        .map((item) => item[1] ?? '')
        .filter((field) => !field.startsWith('_')),
    );
    tables.push({
      name: block.tableName,
      kind: 'sqlalchemy_model',
      sourceFile,
      declaration: `class ${block.className}`,
      fields,
      relationships: sqlAlchemyRelationships(block, tableNameByClass),
      modelName: block.className,
    });
  }
  for (const match of text.matchAll(/op\.create_table\(\s*['"]([^'"]+)['"]/g)) {
    const name = match[1] ?? 'unknown_table';
    const start = match.index ?? 0;
    const tableText = text.slice(start, start + 1200);
    const fields = unique(
      [...tableText.matchAll(/sa\.Column\(\s*['"]([^'"]+)['"]/g)].map((item) => item[1] ?? ''),
    );
    tables.push({
      name,
      kind: 'alembic_table',
      sourceFile,
      declaration: `op.create_table(${name})`,
      fields,
      relationships: [],
    });
  }
  return tables;
}

function sqlAlchemyClassBlocks(text: string): SqlAlchemyClassBlock[] {
  return [
    ...text.matchAll(
      /class\s+([A-Za-z_]\w*)\s*\((?:[^)]*\.)?(?:Model|DeclarativeBase|Base)\)\s*:/g,
    ),
  ].map((match) => {
    const className = match[1] ?? 'UnknownModel';
    const classStart = match.index ?? 0;
    const nextClass = text.slice(classStart + 1).search(/\nclass\s+[A-Za-z_]\w*\s*\(/);
    const classText =
      nextClass < 0 ? text.slice(classStart) : text.slice(classStart, classStart + 1 + nextClass);
    const tableName = /__tablename__\s*=\s*['"]([^'"]+)['"]/.exec(classText)?.[1] ?? className;
    return { className, tableName, classText };
  });
}

function sqlAlchemyRelationships(
  block: SqlAlchemyClassBlock,
  tableNameByClass: ReadonlyMap<string, string>,
): DatabaseTableRelationshipInference[] {
  const relationships: DatabaseTableRelationshipInference[] = [];
  for (const assignment of sqlAlchemyAssignments(block.classText)) {
    const foreignKeyTarget = /(?:db\.)?ForeignKey\s*\(\s*['"]([^'"]+)['"]/.exec(
      assignment.declaration,
    )?.[1];
    if (foreignKeyTarget !== undefined) {
      const target = sqlAlchemyForeignKeyTarget(foreignKeyTarget);
      relationships.push({
        kind: 'foreign_key',
        sourceField: assignment.field,
        targetTable: target.table,
        ...(target.field !== undefined ? { targetField: target.field } : {}),
        declaration: assignment.declaration.slice(0, 160),
      });
    }
    if (!/(?:db\.|sqlalchemy\.orm\.)?relationship\s*\(/.test(assignment.declaration)) continue;
    const targetModel = /relationship\s*\(\s*['"]([^'"]+)['"]/.exec(assignment.declaration)?.[1];
    if (targetModel === undefined) continue;
    const inverseField = sqlAlchemyInverseRelationshipField(assignment.declaration);
    relationships.push({
      kind: 'relationship',
      sourceField: assignment.field,
      targetTable: tableNameByClass.get(targetModel) ?? targetModel,
      targetModel,
      ...(inverseField !== undefined ? { inverseField } : {}),
      declaration: assignment.declaration.slice(0, 160),
    });
  }
  return uniqueBy(
    relationships,
    (relationship) =>
      `${relationship.kind}:${relationship.sourceField}:${relationship.targetTable}:${
        relationship.targetField ?? ''
      }:${relationship.inverseField ?? ''}`,
  );
}

function sqlAlchemyAssignments(
  text: string,
): Array<{ readonly field: string; readonly declaration: string }> {
  const lines = text.split(/\r?\n/);
  const assignments: Array<{ readonly field: string; readonly declaration: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const field = match[1] ?? '';
    if (field.startsWith('_')) continue;
    const declarationLines = [line.trim()];
    let parenBalance = countChar(line, '(') - countChar(line, ')');
    for (
      let lookahead = index + 1;
      lookahead < lines.length && lookahead <= index + 8;
      lookahead += 1
    ) {
      if (parenBalance <= 0) break;
      const nextLine = lines[lookahead] ?? '';
      if (/^\s*[A-Za-z_]\w*\s*=/.test(nextLine)) break;
      declarationLines.push(nextLine.trim());
      parenBalance += countChar(nextLine, '(') - countChar(nextLine, ')');
    }
    const declaration = declarationLines.join(' ');
    if (/ForeignKey\s*\(|relationship\s*\(/.test(declaration)) {
      assignments.push({ field, declaration });
    }
  }
  return assignments;
}

function sqlAlchemyForeignKeyTarget(value: string): {
  readonly table: string;
  readonly field?: string;
} {
  const parts = stripSqlIdentifier(value)
    .split('.')
    .filter((part) => part !== '');
  if (parts.length >= 2) {
    const field = parts[parts.length - 1];
    return {
      table: parts[parts.length - 2] ?? value,
      ...(field !== undefined ? { field } : {}),
    };
  }
  return { table: dbEntityName(value) };
}

function sqlAlchemyInverseRelationshipField(declaration: string): string | undefined {
  return (
    /back_populates\s*=\s*['"]([^'"]+)['"]/.exec(declaration)?.[1] ??
    /backref\s*=\s*['"]([^'"]+)['"]/.exec(declaration)?.[1] ??
    /backref\s*\(\s*['"]([^'"]+)['"]/.exec(declaration)?.[1]
  );
}

function countChar(value: string, char: string): number {
  return [...value].filter((item) => item === char).length;
}

function packageScope(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  const dir = dirname(manifest).replace(/\\/g, '/');
  return dir === '.' ? undefined : dir;
}

function fileIsInScope(file: string, scope: string | undefined): boolean {
  if (scope === undefined) return true;
  return file === scope || file.startsWith(`${scope}/`);
}

function isSourceLikePath(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sql|prisma)$/i.test(path);
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
