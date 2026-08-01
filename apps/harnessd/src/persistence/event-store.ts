import { createHash } from "node:crypto";
import { chmod, lstat, open as openFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  NamespacedTokenSchema,
  RpcIdSchema,
  validateJsonValue,
  type JsonValue,
} from "@codex-harness/protocol";

const APPLICATION_ID = 0x43485831;
const SCHEMA_VERSION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const MAX_DATABASE_PATH_BYTES = 1_024;
const MAX_EVENT_JSON_BYTES = 1024 * 1024;
const MAX_APPEND_BATCH_SIZE = 16;
const MAX_APPEND_BATCH_EVENT_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTION_STATE_JSON_BYTES = 1024 * 1024;
const MAX_PROJECTION_STATE_BYTES_PER_EVENT = 4 * 1024 * 1024;
const MAX_PROJECTION_STATE_BYTES_PER_BATCH = 8 * 1024 * 1024;
const MAX_READ_LIMIT = 1_000;
const MAX_PROJECTIONS = 64;
const MAX_PROJECTION_KEYS_PER_EVENT = 1_000;
const MAX_PROJECTION_KEYS_PER_BATCH = 4_000;
const MAX_PROJECTION_KEY_BYTES = 256;
const EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STREAM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PROJECTION_KEY_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;

const MIGRATION_V1_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0)
) STRICT;

CREATE TABLE event_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) = 36),
  stream_type TEXT NOT NULL CHECK(length(stream_type) BETWEEN 1 AND 128),
  stream_id TEXT NOT NULL CHECK(length(stream_id) BETWEEN 1 AND 128),
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 128),
  event_version INTEGER NOT NULL CHECK(event_version BETWEEN 1 AND 2147483647),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object')
) STRICT;

CREATE TABLE projection_checkpoints (
  projection_name TEXT PRIMARY KEY CHECK(length(projection_name) BETWEEN 1 AND 128),
  projection_version INTEGER NOT NULL CHECK(projection_version >= 1),
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE TRIGGER event_log_no_update
BEFORE UPDATE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log_immutable');
END;

CREATE TRIGGER event_log_no_delete
BEFORE DELETE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log_immutable');
END;

CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations_immutable');
END;

CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations_immutable');
END;
`;

const MIGRATION_V1_CHECKSUM = createHash("sha256").update(MIGRATION_V1_SQL).digest("hex");

const MIGRATION_V2_SQL = `
CREATE TABLE projection_state (
  projection_name TEXT NOT NULL CHECK(length(projection_name) BETWEEN 1 AND 128),
  projection_key TEXT NOT NULL CHECK(length(projection_key) BETWEEN 1 AND 256),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  source_sequence INTEGER NOT NULL CHECK(source_sequence >= 1),
  PRIMARY KEY (projection_name, projection_key),
  FOREIGN KEY (projection_name) REFERENCES projection_checkpoints(projection_name) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
`;

const MIGRATION_V2_CHECKSUM = createHash("sha256").update(MIGRATION_V2_SQL).digest("hex");
const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, sql: MIGRATION_V1_SQL, checksum: MIGRATION_V1_CHECKSUM }),
  Object.freeze({ version: 2, sql: MIGRATION_V2_SQL, checksum: MIGRATION_V2_CHECKSUM }),
]);
const expectedSchemaFingerprints = new Map<number, string>();

export type EventStoreErrorCode =
  | "closed"
  | "conflict"
  | "corrupt_data"
  | "database_busy"
  | "invalid_configuration"
  | "invalid_event"
  | "invalid_query"
  | "migration_mismatch"
  | "projection_failure"
  | "storage_failure"
  | "unsupported_database";

const ERROR_MESSAGES: Readonly<Record<EventStoreErrorCode, string>> = Object.freeze({
  closed: "The Harness event store is closed.",
  conflict: "The event identifier conflicts with different event content.",
  corrupt_data: "The Harness event store contains invalid data.",
  database_busy: "The Harness event store is already owned by another writer.",
  invalid_configuration: "The Harness event store configuration is invalid.",
  invalid_event: "The Harness event is invalid.",
  invalid_query: "The Harness event query is invalid.",
  migration_mismatch: "The Harness event store schema does not match its migration history.",
  projection_failure: "The Harness event projection failed.",
  storage_failure: "The Harness event store operation failed.",
  unsupported_database: "The database does not belong to this Harness schema.",
});

export class EventStoreError extends Error {
  readonly code: EventStoreErrorCode;

  constructor(code: EventStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "EventStoreError";
    this.code = code;
  }
}

export type EventMetadata = Readonly<{
  correlationId?: string;
  causationEventId?: string;
  actor?: string;
}>;

export type EventToAppend = Readonly<{
  eventId: string;
  streamType: string;
  streamId: string;
  eventType: string;
  eventVersion: number;
  occurredAtMs: number;
  payload: JsonValue;
  metadata?: EventMetadata;
}>;

export type StoredEvent = Readonly<{
  sequence: number;
  eventId: string;
  streamType: string;
  streamId: string;
  eventType: string;
  eventVersion: number;
  occurredAtMs: number;
  payload: JsonValue;
  metadata: EventMetadata;
}>;

export type AppendEventResult = Readonly<{
  event: StoredEvent;
  duplicate: boolean;
}>;

export type AppendEventBatchResult = Readonly<{
  events: readonly StoredEvent[];
  duplicate: boolean;
}>;

export type ProjectionMutation =
  | Readonly<{ type: "keep" }>
  | Readonly<{ type: "set"; state: JsonValue }>
  | Readonly<{ type: "delete" }>;

export type ProjectionReducerInput = Readonly<{
  key: string;
  current: JsonValue | undefined;
  event: StoredEvent;
}>;

export type ProjectionDefinition = Readonly<{
  name: string;
  version: number;
  selectKeys: (event: StoredEvent) => readonly string[];
  reduce: (input: ProjectionReducerInput) => ProjectionMutation;
}>;

export type ProjectionState = Readonly<{
  projectionName: string;
  key: string;
  sourceSequence: number;
  state: JsonValue;
}>;

export type EventStoreInspection = Readonly<{
  schemaVersion: number;
  eventCount: number;
  lastSequence: number;
  journalMode: "wal";
  projectionCount: number;
  sqliteVersion: string;
}>;

export type EventStoreConfig = Readonly<{
  path: string;
  busyTimeoutMs?: number;
  now?: () => number;
  projections?: readonly ProjectionDefinition[];
}>;

type NormalizedEvent = Readonly<{
  eventId: string;
  streamType: string;
  streamId: string;
  eventType: string;
  eventVersion: number;
  occurredAtMs: number;
  payloadJson: string;
  metadataJson: string;
}>;

type FileIdentity = Readonly<{ device: number; inode: number }>;

type NormalizedProjectionDefinition = Readonly<{
  name: string;
  version: number;
  selectKeys: (event: StoredEvent) => readonly string[];
  reduce: (input: ProjectionReducerInput) => ProjectionMutation;
}>;

type ProjectionCheckpoint = Readonly<{
  name: string;
  version: number;
  lastSequence: number;
  updatedAtMs: number;
}>;

type ProjectionApplyBudget = {
  remainingKeys: number;
  remainingStateBytes: number;
};

type ProjectionApplyUsage = Readonly<{
  keys: number;
  stateBytes: number;
}>;

export class HarnessEventStore {
  readonly #database: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #findByEventId: StatementSync;
  readonly #readAfter: StatementSync;
  readonly #projections: ReadonlyMap<string, NormalizedProjectionDefinition>;
  #closed = false;

  private constructor(
    database: DatabaseSync,
    projections: readonly NormalizedProjectionDefinition[],
  ) {
    this.#database = database;
    this.#projections = new Map(projections.map((projection) => [projection.name, projection]));
    this.#insertEvent = database.prepare(`
      INSERT INTO event_log (
        event_id, stream_type, stream_id, event_type, event_version,
        occurred_at_ms, payload_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#findByEventId = database.prepare(`
      SELECT sequence, event_id, stream_type, stream_id, event_type, event_version,
             occurred_at_ms, payload_json, metadata_json
      FROM event_log
      WHERE event_id = ?
    `);
    this.#readAfter = database.prepare(`
      SELECT sequence, event_id, stream_type, stream_id, event_type, event_version,
             occurred_at_ms, payload_json, metadata_json
      FROM event_log
      WHERE sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
  }

  static async open(config: EventStoreConfig): Promise<HarnessEventStore> {
    const normalized = await validateStoreConfig(config);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(normalized.path, {
        allowExtension: false,
        defensive: true,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        readBigInts: true,
        timeout: normalized.busyTimeoutMs,
      });
      database.enableDefensive(true);
      database.enableLoadExtension(false);
      await chmod(normalized.path, 0o600);
      await validateDatabaseFile(normalized.path, normalized.fileIdentity);
      initializeDatabase(database, normalized.existed, normalized.appliedAtMs);
      await validateDatabaseSidecars(normalized.path, true);
      verifyStorageBeforeRecovery(database);
      reconcileProjections(database, normalized.projections, normalized.appliedAtMs);
      const store = new HarnessEventStore(database, normalized.projections);
      store.inspect();
      return store;
    } catch (error: unknown) {
      try {
        database?.close();
      } catch {
        // The fixed public error below is authoritative.
      }
      throw mapStorageError(error);
    }
  }

  append(input: EventToAppend): AppendEventResult {
    const appended = this.appendBatch([input]);
    const event = appended.events[0];
    if (event === undefined) {
      throw new EventStoreError("storage_failure");
    }
    return Object.freeze({ event, duplicate: appended.duplicate });
  }

  appendBatch(input: readonly EventToAppend[]): AppendEventBatchResult {
    this.#assertOpen();
    const events = normalizeEventBatch(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const existing = events.map((event) => {
        const row = this.#findByEventId.get(event.eventId);
        return row === undefined ? undefined : decodeStoredEvent(row);
      });
      const existingCount = existing.filter((event) => event !== undefined).length;
      if (existingCount > 0) {
        if (existingCount !== events.length) {
          throw new EventStoreError("conflict");
        }
        const stored = existing as StoredEvent[];
        if (
          stored.some((event, index) => !storedEventMatches(event, events[index]!)) ||
          stored.some(
            (event, index) => index > 0 && event.sequence !== stored[index - 1]!.sequence + 1,
          )
        ) {
          throw new EventStoreError("conflict");
        }
        this.#database.exec("COMMIT");
        return Object.freeze({ events: Object.freeze(stored), duplicate: true });
      }

      const stored: StoredEvent[] = [];
      let projectionKeys = 0;
      let projectionStateBytes = 0;
      for (const event of events) {
        const inserted = this.#insertEvent.run(
          event.eventId,
          event.streamType,
          event.streamId,
          event.eventType,
          event.eventVersion,
          event.occurredAtMs,
          event.payloadJson,
          event.metadataJson,
        );
        const sequence = safeInteger(inserted.lastInsertRowid);
        const appended = materializeEvent(sequence, event);
        const usage = applyEventToProjections(
          this.#database,
          [...this.#projections.values()],
          appended,
        );
        projectionKeys += usage.keys;
        projectionStateBytes += usage.stateBytes;
        if (
          projectionKeys > MAX_PROJECTION_KEYS_PER_BATCH ||
          projectionStateBytes > MAX_PROJECTION_STATE_BYTES_PER_BATCH
        ) {
          throw new EventStoreError("projection_failure");
        }
        stored.push(appended);
      }
      this.#database.exec("COMMIT");
      return Object.freeze({ events: Object.freeze(stored), duplicate: false });
    } catch (error: unknown) {
      rollback(this.#database);
      if (error instanceof EventStoreError) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  readAfter(sequence: number, limit = 100): readonly StoredEvent[] {
    this.#assertOpen();
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_READ_LIMIT
    ) {
      throw new EventStoreError("invalid_query");
    }
    try {
      return Object.freeze(this.#readAfter.all(sequence, limit).map(decodeStoredEvent));
    } catch (error: unknown) {
      if (error instanceof EventStoreError) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  readProjectionState(projectionName: string, key: string): ProjectionState | undefined {
    this.#assertOpen();
    this.#assertRegisteredProjection(projectionName);
    if (!isValidProjectionKey(key)) {
      throw new EventStoreError("invalid_query");
    }
    try {
      const row = this.#database
        .prepare(
          `SELECT projection_name, projection_key, state_json, source_sequence
           FROM projection_state WHERE projection_name = ? AND projection_key = ?`,
        )
        .get(projectionName, key);
      return row === undefined ? undefined : decodeProjectionState(row);
    } catch (error: unknown) {
      if (error instanceof EventStoreError) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  listProjectionStates(
    projectionName: string,
    afterKey = "",
    limit = 100,
  ): readonly ProjectionState[] {
    this.#assertOpen();
    this.#assertRegisteredProjection(projectionName);
    if (
      (afterKey !== "" && !isValidProjectionKey(afterKey)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_READ_LIMIT
    ) {
      throw new EventStoreError("invalid_query");
    }
    try {
      return Object.freeze(
        this.#database
          .prepare(
            `SELECT projection_name, projection_key, state_json, source_sequence
             FROM projection_state
             WHERE projection_name = ? AND projection_key > ?
             ORDER BY projection_key ASC LIMIT ?`,
          )
          .all(projectionName, afterKey, limit)
          .map(decodeProjectionState),
      );
    } catch (error: unknown) {
      if (error instanceof EventStoreError) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  inspect(): EventStoreInspection {
    this.#assertOpen();
    try {
      verifyMigrations(this.#database);
      verifySchemaObjects(this.#database);
      verifyQuickCheck(this.#database);
      verifyForeignKeys(this.#database);
      const { eventCount, lastSequence } = verifyEventSequenceAndRows(this.#database);
      const projectionCount = verifyProjectionData(this.#database, lastSequence, this.#projections);
      const journalMode = scalarString(this.#database.prepare("PRAGMA journal_mode").get());
      if (journalMode !== "wal") {
        throw new EventStoreError("corrupt_data");
      }
      const sqliteVersion = scalarString(this.#database.prepare("SELECT sqlite_version()").get());
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        eventCount,
        lastSequence,
        journalMode,
        projectionCount,
        sqliteVersion,
      });
    } catch (error: unknown) {
      if (error instanceof EventStoreError) {
        throw error;
      }
      throw mapStorageError(error);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    let failed = false;
    try {
      this.#database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch {
      failed = true;
    }
    try {
      this.#database.close();
    } catch {
      failed = true;
    }
    if (failed) {
      throw new EventStoreError("storage_failure");
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EventStoreError("closed");
    }
  }

  #assertRegisteredProjection(projectionName: string): void {
    if (
      typeof projectionName !== "string" ||
      !NamespacedTokenSchema.safeParse(projectionName).success ||
      !this.#projections.has(projectionName)
    ) {
      throw new EventStoreError("invalid_query");
    }
  }
}

async function validateStoreConfig(config: EventStoreConfig): Promise<
  Readonly<{
    path: string;
    busyTimeoutMs: number;
    appliedAtMs: number;
    existed: boolean;
    fileIdentity: FileIdentity;
    projections: readonly NormalizedProjectionDefinition[];
  }>
> {
  let path: string;
  let busyTimeoutMs: number;
  let now: () => number;
  let rawProjections: unknown;
  try {
    path = config.path;
    busyTimeoutMs = config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    now = config.now ?? Date.now;
    rawProjections = config.projections;
  } catch {
    throw new EventStoreError("invalid_configuration");
  }
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.includes("\0") ||
    basename(path) !== "harness.db" ||
    Buffer.byteLength(path, "utf8") > MAX_DATABASE_PATH_BYTES ||
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 1 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS ||
    typeof now !== "function"
  ) {
    throw new EventStoreError("invalid_configuration");
  }
  let appliedAtMs: number;
  try {
    appliedAtMs = now();
  } catch {
    throw new EventStoreError("invalid_configuration");
  }
  if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
    throw new EventStoreError("invalid_configuration");
  }
  const projections = normalizeProjectionDefinitions(rawProjections);

  await validatePrivateDirectory(dirname(path));
  let existed = false;
  let fileIdentity: FileIdentity | undefined;
  try {
    const metadata = await lstat(path);
    existed = true;
    const getuid = process.getuid;
    if (
      !metadata.isFile() ||
      getuid === undefined ||
      metadata.uid !== getuid() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new EventStoreError("invalid_configuration");
    }
    fileIdentity = Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new EventStoreError("invalid_configuration");
    }
  }
  await validateDatabaseSidecars(path, existed);
  if (!existed) {
    fileIdentity = await createExclusiveDatabaseFile(path);
  }
  if (fileIdentity === undefined) {
    throw new EventStoreError("invalid_configuration");
  }
  return Object.freeze({
    path,
    busyTimeoutMs,
    appliedAtMs,
    existed,
    fileIdentity,
    projections,
  });
}

function normalizeProjectionDefinitions(input: unknown): readonly NormalizedProjectionDefinition[] {
  if (input === undefined) {
    return Object.freeze([]);
  }
  try {
    if (!Array.isArray(input) || input.length > MAX_PROJECTIONS) {
      throw new EventStoreError("invalid_configuration");
    }
    const arrayKeys = Reflect.ownKeys(input);
    if (
      arrayKeys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)),
      )
    ) {
      throw new EventStoreError("invalid_configuration");
    }

    const normalized: NormalizedProjectionDefinition[] = [];
    const names = new Set<string>();
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new EventStoreError("invalid_configuration");
      }
      const candidate = descriptor.value as unknown;
      if (!isPlainDataRecord(candidate, ["name", "reduce", "selectKeys", "version"])) {
        throw new EventStoreError("invalid_configuration");
      }
      const values = candidate as Record<string, unknown>;
      const name = values.name;
      const version = values.version;
      const selectKeys = values.selectKeys;
      const reduce = values.reduce;
      if (
        typeof name !== "string" ||
        !NamespacedTokenSchema.safeParse(name).success ||
        names.has(name) ||
        !Number.isSafeInteger(version) ||
        (version as number) < 1 ||
        (version as number) > 2_147_483_647 ||
        typeof selectKeys !== "function" ||
        typeof reduce !== "function"
      ) {
        throw new EventStoreError("invalid_configuration");
      }
      names.add(name);
      normalized.push(
        Object.freeze({
          name,
          version: version as number,
          selectKeys: selectKeys as NormalizedProjectionDefinition["selectKeys"],
          reduce: reduce as NormalizedProjectionDefinition["reduce"],
        }),
      );
    }
    normalized.sort((left, right) => left.name.localeCompare(right.name));
    return Object.freeze(normalized);
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("invalid_configuration");
  }
}

function isPlainDataRecord(input: unknown, exactKeys: readonly string[]): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== exactKeys.length ||
    keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
  ) {
    return false;
  }
  return exactKeys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

async function createExclusiveDatabaseFile(path: string): Promise<FileIdentity> {
  let handle;
  try {
    handle = await openFile(path, "wx", 0o600);
    const metadata = await handle.stat();
    const getuid = process.getuid;
    if (
      !metadata.isFile() ||
      getuid === undefined ||
      metadata.uid !== getuid() ||
      metadata.nlink !== 1
    ) {
      throw new EventStoreError("invalid_configuration");
    }
    const identity = Object.freeze({ device: metadata.dev, inode: metadata.ino });
    await handle.close();
    handle = undefined;
    return identity;
  } catch (error: unknown) {
    try {
      await handle?.close();
    } catch {
      // The fixed configuration error below remains authoritative.
    }
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("invalid_configuration");
  }
}

async function validatePrivateDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    const getuid = process.getuid;
    if (
      !metadata.isDirectory() ||
      getuid === undefined ||
      metadata.uid !== getuid() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new EventStoreError("invalid_configuration");
    }
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("invalid_configuration");
  }
}

async function validateDatabaseFile(path: string, expectedIdentity: FileIdentity): Promise<void> {
  try {
    const metadata = await lstat(path);
    const getuid = process.getuid;
    if (
      !metadata.isFile() ||
      getuid === undefined ||
      metadata.uid !== getuid() ||
      metadata.nlink !== 1 ||
      metadata.dev !== expectedIdentity.device ||
      metadata.ino !== expectedIdentity.inode ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new EventStoreError("invalid_configuration");
    }
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("storage_failure");
  }
}

async function validateDatabaseSidecars(path: string, databaseExists: boolean): Promise<void> {
  for (const suffix of ["-journal", "-shm", "-wal"] as const) {
    try {
      const metadata = await lstat(`${path}${suffix}`);
      const getuid = process.getuid;
      if (
        !databaseExists ||
        !metadata.isFile() ||
        getuid === undefined ||
        metadata.uid !== getuid() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new EventStoreError("invalid_configuration");
      }
    } catch (error: unknown) {
      if (error instanceof EventStoreError) {
        throw error;
      }
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new EventStoreError("invalid_configuration");
      }
    }
  }
}

function initializeDatabase(database: DatabaseSync, existed: boolean, now: number): void {
  const applicationId = scalarInteger(database.prepare("PRAGMA application_id").get());
  if (existed && applicationId !== APPLICATION_ID) {
    throw new EventStoreError("unsupported_database");
  }
  if (!existed) {
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  }

  const journalMode = scalarString(database.prepare("PRAGMA journal_mode = WAL").get());
  if (journalMode !== "wal") {
    throw new EventStoreError("storage_failure");
  }
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA locking_mode = EXCLUSIVE;
  `);
  database.exec("BEGIN EXCLUSIVE; COMMIT");

  const userVersion = scalarInteger(database.prepare("PRAGMA user_version").get());
  if (userVersion > SCHEMA_VERSION) {
    throw new EventStoreError("unsupported_database");
  }
  verifyMigrationPrefix(database, userVersion);
  verifySchemaObjectsForVersion(database, userVersion);
  for (const migration of MIGRATIONS) {
    if (migration.version > userVersion) {
      applyMigration(database, migration, now);
    }
  }
  verifyMigrations(database);
}

function verifyMigrationPrefix(database: DatabaseSync, currentVersion: number): void {
  if (currentVersion === 0) {
    return;
  }
  try {
    const rows = database
      .prepare("SELECT version, checksum, applied_at_ms FROM schema_migrations ORDER BY version")
      .all();
    if (rows.length !== currentVersion) {
      throw new EventStoreError("migration_mismatch");
    }
    for (let index = 0; index < currentVersion; index += 1) {
      const row = rows[index];
      const migration = MIGRATIONS[index];
      if (
        row === undefined ||
        migration === undefined ||
        scalarIntegerValue(row.version) !== migration.version ||
        row.checksum !== migration.checksum ||
        safeInteger(row.applied_at_ms) < 0
      ) {
        throw new EventStoreError("migration_mismatch");
      }
    }
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("migration_mismatch");
  }
}

function applyMigration(
  database: DatabaseSync,
  migration: (typeof MIGRATIONS)[number],
  now: number,
): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new EventStoreError("invalid_configuration");
  }
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(migration.sql);
    database
      .prepare("INSERT INTO schema_migrations (version, checksum, applied_at_ms) VALUES (?, ?, ?)")
      .run(migration.version, migration.checksum, now);
    database.exec(`PRAGMA user_version = ${migration.version}`);
    database.exec("COMMIT");
  } catch (error: unknown) {
    rollback(database);
    throw error;
  }
}

function verifyMigrations(database: DatabaseSync): void {
  const userVersion = scalarInteger(database.prepare("PRAGMA user_version").get());
  if (userVersion !== SCHEMA_VERSION) {
    throw new EventStoreError("migration_mismatch");
  }
  const rows = database
    .prepare("SELECT version, checksum, applied_at_ms FROM schema_migrations ORDER BY version")
    .all();
  if (rows.length !== MIGRATIONS.length) {
    throw new EventStoreError("migration_mismatch");
  }
  for (const [index, migration] of MIGRATIONS.entries()) {
    const row = rows[index];
    if (
      row === undefined ||
      scalarIntegerValue(row.version) !== migration.version ||
      row.checksum !== migration.checksum ||
      safeInteger(row.applied_at_ms) < 0
    ) {
      throw new EventStoreError("migration_mismatch");
    }
  }
}

function verifySchemaObjects(database: DatabaseSync): void {
  verifySchemaObjectsForVersion(database, SCHEMA_VERSION);
}

function verifySchemaObjectsForVersion(database: DatabaseSync, version: number): void {
  if (schemaFingerprint(database) !== getExpectedSchemaFingerprint(version)) {
    throw new EventStoreError("migration_mismatch");
  }
}

function schemaFingerprint(database: DatabaseSync): string {
  const definitions = database
    .prepare(
      `SELECT name, type, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'trigger')
       ORDER BY name, type`,
    )
    .all()
    .map((row) => {
      if (
        typeof row.name !== "string" ||
        typeof row.type !== "string" ||
        typeof row.sql !== "string"
      ) {
        throw new EventStoreError("migration_mismatch");
      }
      return Object.freeze({ name: row.name, type: row.type, sql: row.sql });
    });
  return createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}

function getExpectedSchemaFingerprint(version: number): string {
  const cached = expectedSchemaFingerprints.get(version);
  if (cached !== undefined) {
    return cached;
  }
  const expected = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) {
        expected.exec(migration.sql);
      }
    }
    const fingerprint = schemaFingerprint(expected);
    expectedSchemaFingerprints.set(version, fingerprint);
    return fingerprint;
  } finally {
    expected.close();
  }
}

function verifyQuickCheck(database: DatabaseSync): void {
  const result = scalarString(database.prepare("PRAGMA quick_check").get());
  if (result !== "ok") {
    throw new EventStoreError("corrupt_data");
  }
}

function verifyForeignKeys(database: DatabaseSync): void {
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new EventStoreError("corrupt_data");
  }
}

function verifyEventSequenceAndRows(
  database: DatabaseSync,
): Readonly<{ eventCount: number; lastSequence: number }> {
  const summary = database
    .prepare(
      `SELECT COUNT(*) AS event_count, MIN(sequence) AS first_sequence,
              MAX(sequence) AS last_sequence FROM event_log`,
    )
    .get();
  if (summary === undefined) {
    throw new EventStoreError("corrupt_data");
  }
  const eventCount = safeInteger(summary.event_count);
  const firstSequence = nullableSafeInteger(summary.first_sequence);
  const lastSequence = nullableSafeInteger(summary.last_sequence);
  if (
    (eventCount === 0 && (firstSequence !== null || lastSequence !== null)) ||
    (eventCount > 0 && (firstSequence !== 1 || lastSequence !== eventCount))
  ) {
    throw new EventStoreError("corrupt_data");
  }
  for (const row of database
    .prepare(
      `SELECT sequence, event_id, stream_type, stream_id, event_type, event_version,
              occurred_at_ms, payload_json, metadata_json
       FROM event_log ORDER BY sequence`,
    )
    .iterate()) {
    decodeStoredEvent(row);
  }
  return Object.freeze({ eventCount, lastSequence: lastSequence ?? 0 });
}

function verifyStorageBeforeRecovery(database: DatabaseSync): void {
  verifyMigrations(database);
  verifySchemaObjects(database);
  verifyQuickCheck(database);
  verifyForeignKeys(database);
  const { lastSequence } = verifyEventSequenceAndRows(database);
  verifyProjectionData(database, lastSequence, new Map());
}

function verifyProjectionData(
  database: DatabaseSync,
  lastEventSequence: number,
  registered: ReadonlyMap<string, NormalizedProjectionDefinition>,
): number {
  const checkpoints = new Map<string, ProjectionCheckpoint>();
  for (const row of database
    .prepare(
      `SELECT projection_name, projection_version, last_sequence, updated_at_ms
       FROM projection_checkpoints ORDER BY projection_name`,
    )
    .iterate()) {
    const checkpoint = decodeProjectionCheckpoint(row);
    if (checkpoint.lastSequence > lastEventSequence || checkpoints.has(checkpoint.name)) {
      throw new EventStoreError("corrupt_data");
    }
    checkpoints.set(checkpoint.name, checkpoint);
  }

  for (const row of database
    .prepare(
      `SELECT projection_name, projection_key, state_json, source_sequence
       FROM projection_state ORDER BY projection_name, projection_key`,
    )
    .iterate()) {
    const state = decodeProjectionState(row);
    const checkpoint = checkpoints.get(state.projectionName);
    if (checkpoint === undefined || state.sourceSequence > checkpoint.lastSequence) {
      throw new EventStoreError("corrupt_data");
    }
  }

  for (const definition of registered.values()) {
    const checkpoint = checkpoints.get(definition.name);
    if (
      checkpoint === undefined ||
      checkpoint.version !== definition.version ||
      checkpoint.lastSequence !== lastEventSequence
    ) {
      throw new EventStoreError("corrupt_data");
    }
  }
  return checkpoints.size;
}

function decodeProjectionCheckpoint(row: Record<string, unknown>): ProjectionCheckpoint {
  const name = row.projection_name;
  const version = safeInteger(row.projection_version);
  const lastSequence = safeInteger(row.last_sequence);
  const updatedAtMs = safeInteger(row.updated_at_ms);
  if (typeof name !== "string" || !NamespacedTokenSchema.safeParse(name).success || version < 1) {
    throw new EventStoreError("corrupt_data");
  }
  return Object.freeze({ name, version, lastSequence, updatedAtMs });
}

function decodeProjectionState(row: Record<string, unknown>): ProjectionState {
  try {
    const projectionName = row.projection_name;
    const key = row.projection_key;
    const stateJson = row.state_json;
    const sourceSequence = safeInteger(row.source_sequence);
    if (
      typeof projectionName !== "string" ||
      !NamespacedTokenSchema.safeParse(projectionName).success ||
      typeof key !== "string" ||
      !isValidProjectionKey(key) ||
      typeof stateJson !== "string" ||
      sourceSequence < 1 ||
      Buffer.byteLength(stateJson) > MAX_PROJECTION_STATE_JSON_BYTES
    ) {
      throw new EventStoreError("corrupt_data");
    }
    const state = JSON.parse(stateJson) as unknown;
    if (!validateJsonValue(state).ok || canonicalJson(state as JsonValue) !== stateJson) {
      throw new EventStoreError("corrupt_data");
    }
    return Object.freeze({
      projectionName,
      key,
      sourceSequence,
      state: deepFreezeJson(state as JsonValue),
    });
  } catch (error: unknown) {
    if (error instanceof EventStoreError && error.code === "corrupt_data") {
      throw error;
    }
    throw new EventStoreError("corrupt_data");
  }
}

function reconcileProjections(
  database: DatabaseSync,
  definitions: readonly NormalizedProjectionDefinition[],
  recoveryAtMs: number,
): void {
  if (definitions.length === 0) {
    return;
  }
  try {
    database.exec("BEGIN IMMEDIATE");
    let firstSequenceToReplay = Number.MAX_SAFE_INTEGER;
    for (const definition of definitions) {
      let checkpoint = readProjectionCheckpoint(database, definition.name);
      if (checkpoint === undefined) {
        database
          .prepare(
            `INSERT INTO projection_checkpoints (
               projection_name, projection_version, last_sequence, updated_at_ms
             ) VALUES (?, ?, 0, ?)`,
          )
          .run(definition.name, definition.version, recoveryAtMs);
        checkpoint = Object.freeze({
          name: definition.name,
          version: definition.version,
          lastSequence: 0,
          updatedAtMs: recoveryAtMs,
        });
      } else if (checkpoint.version !== definition.version) {
        database
          .prepare("DELETE FROM projection_state WHERE projection_name = ?")
          .run(definition.name);
        database
          .prepare(
            `UPDATE projection_checkpoints
             SET projection_version = ?, last_sequence = 0, updated_at_ms = ?
             WHERE projection_name = ?`,
          )
          .run(definition.version, recoveryAtMs, definition.name);
        checkpoint = Object.freeze({
          name: definition.name,
          version: definition.version,
          lastSequence: 0,
          updatedAtMs: recoveryAtMs,
        });
      }
      firstSequenceToReplay = Math.min(firstSequenceToReplay, checkpoint.lastSequence + 1);
    }

    for (const row of database
      .prepare(
        `SELECT sequence, event_id, stream_type, stream_id, event_type, event_version,
                occurred_at_ms, payload_json, metadata_json
         FROM event_log WHERE sequence >= ? ORDER BY sequence`,
      )
      .iterate(firstSequenceToReplay)) {
      const event = decodeStoredEvent(row);
      const budget = createProjectionApplyBudget();
      for (const definition of definitions) {
        const checkpoint = readProjectionCheckpoint(database, definition.name);
        if (checkpoint === undefined) {
          throw new EventStoreError("corrupt_data");
        }
        if (checkpoint.lastSequence < event.sequence) {
          applyEventToProjection(database, definition, event, budget);
        }
      }
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    rollback(database);
    throw error;
  }
}

function applyEventToProjections(
  database: DatabaseSync,
  definitions: readonly NormalizedProjectionDefinition[],
  event: StoredEvent,
): ProjectionApplyUsage {
  const budget = createProjectionApplyBudget();
  for (const definition of definitions) {
    applyEventToProjection(database, definition, event, budget);
  }
  return Object.freeze({
    keys: MAX_PROJECTION_KEYS_PER_EVENT - budget.remainingKeys,
    stateBytes: MAX_PROJECTION_STATE_BYTES_PER_EVENT - budget.remainingStateBytes,
  });
}

function applyEventToProjection(
  database: DatabaseSync,
  definition: NormalizedProjectionDefinition,
  event: StoredEvent,
  budget: ProjectionApplyBudget,
): void {
  const checkpoint = readProjectionCheckpoint(database, definition.name);
  if (
    checkpoint === undefined ||
    checkpoint.version !== definition.version ||
    checkpoint.lastSequence !== event.sequence - 1
  ) {
    throw new EventStoreError("corrupt_data");
  }

  const keys = selectProjectionKeys(definition, event);
  if (keys.length > budget.remainingKeys) {
    throw new EventStoreError("projection_failure");
  }
  budget.remainingKeys -= keys.length;
  for (const key of keys) {
    const currentRow = database
      .prepare(
        `SELECT projection_name, projection_key, state_json, source_sequence
         FROM projection_state WHERE projection_name = ? AND projection_key = ?`,
      )
      .get(definition.name, key);
    const current = currentRow === undefined ? undefined : decodeProjectionState(currentRow).state;
    const mutation = reduceProjection(definition, key, current, event);
    if (mutation.type === "set") {
      const stateBytes = Buffer.byteLength(mutation.stateJson);
      if (stateBytes > budget.remainingStateBytes) {
        throw new EventStoreError("projection_failure");
      }
      budget.remainingStateBytes -= stateBytes;
      database
        .prepare(
          `INSERT INTO projection_state (
             projection_name, projection_key, state_json, source_sequence
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT (projection_name, projection_key) DO UPDATE SET
             state_json = excluded.state_json,
             source_sequence = excluded.source_sequence`,
        )
        .run(definition.name, key, mutation.stateJson, event.sequence);
    } else if (mutation.type === "delete") {
      database
        .prepare("DELETE FROM projection_state WHERE projection_name = ? AND projection_key = ?")
        .run(definition.name, key);
    }
  }

  const updated = database
    .prepare(
      `UPDATE projection_checkpoints
       SET last_sequence = ?, updated_at_ms = ?
       WHERE projection_name = ? AND projection_version = ? AND last_sequence = ?`,
    )
    .run(
      event.sequence,
      Math.max(checkpoint.updatedAtMs, event.occurredAtMs),
      definition.name,
      definition.version,
      checkpoint.lastSequence,
    );
  if (safeInteger(updated.changes) !== 1) {
    throw new EventStoreError("corrupt_data");
  }
}

function createProjectionApplyBudget(): ProjectionApplyBudget {
  return {
    remainingKeys: MAX_PROJECTION_KEYS_PER_EVENT,
    remainingStateBytes: MAX_PROJECTION_STATE_BYTES_PER_EVENT,
  };
}

function readProjectionCheckpoint(
  database: DatabaseSync,
  name: string,
): ProjectionCheckpoint | undefined {
  const row = database
    .prepare(
      `SELECT projection_name, projection_version, last_sequence, updated_at_ms
       FROM projection_checkpoints WHERE projection_name = ?`,
    )
    .get(name);
  return row === undefined ? undefined : decodeProjectionCheckpoint(row);
}

function selectProjectionKeys(
  definition: NormalizedProjectionDefinition,
  event: StoredEvent,
): readonly string[] {
  let selected: unknown;
  try {
    selected = Reflect.apply(definition.selectKeys, undefined, [event]);
  } catch {
    throw new EventStoreError("projection_failure");
  }
  try {
    if (!Array.isArray(selected) || selected.length > MAX_PROJECTION_KEYS_PER_EVENT) {
      throw new EventStoreError("projection_failure");
    }
    const arrayKeys = Reflect.ownKeys(selected);
    if (
      arrayKeys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= selected.length)),
      )
    ) {
      throw new EventStoreError("projection_failure");
    }
    const keys: string[] = [];
    const unique = new Set<string>();
    for (let index = 0; index < selected.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(selected, String(index));
      const key =
        descriptor !== undefined && "value" in descriptor && descriptor.enumerable
          ? descriptor.value
          : undefined;
      if (typeof key !== "string" || !isValidProjectionKey(key) || unique.has(key)) {
        throw new EventStoreError("projection_failure");
      }
      unique.add(key);
      keys.push(key);
    }
    return Object.freeze(keys);
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("projection_failure");
  }
}

function reduceProjection(
  definition: NormalizedProjectionDefinition,
  key: string,
  current: JsonValue | undefined,
  event: StoredEvent,
): Readonly<{ type: "keep" } | { type: "delete" } | { type: "set"; stateJson: string }> {
  let output: unknown;
  try {
    output = Reflect.apply(definition.reduce, undefined, [Object.freeze({ key, current, event })]);
  } catch {
    throw new EventStoreError("projection_failure");
  }
  try {
    if (isPlainDataRecord(output, ["type"])) {
      const type = (output as Record<string, unknown>).type;
      if (type === "keep" || type === "delete") {
        return Object.freeze({ type });
      }
    }
    if (isPlainDataRecord(output, ["state", "type"])) {
      const candidate = output as Record<string, unknown>;
      if (candidate.type === "set" && validateJsonValue(candidate.state).ok) {
        const stateJson = canonicalJson(candidate.state as JsonValue);
        if (Buffer.byteLength(stateJson) <= MAX_PROJECTION_STATE_JSON_BYTES) {
          return Object.freeze({ type: "set", stateJson });
        }
      }
    }
    throw new EventStoreError("projection_failure");
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("projection_failure");
  }
}

function isValidProjectionKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    PROJECTION_KEY_PATTERN.test(key) &&
    Buffer.byteLength(key, "utf8") <= MAX_PROJECTION_KEY_BYTES
  );
}

function normalizeEvent(input: unknown): NormalizedEvent {
  try {
    if (!isPlainEventInput(input)) {
      throw new EventStoreError("invalid_event");
    }
    const candidate = input as Partial<EventToAppend>;
    if (
      typeof candidate.eventId !== "string" ||
      !EVENT_ID_PATTERN.test(candidate.eventId) ||
      typeof candidate.streamType !== "string" ||
      !NamespacedTokenSchema.safeParse(candidate.streamType).success ||
      typeof candidate.streamId !== "string" ||
      !STREAM_ID_PATTERN.test(candidate.streamId) ||
      typeof candidate.eventType !== "string" ||
      !NamespacedTokenSchema.safeParse(candidate.eventType).success ||
      !Number.isSafeInteger(candidate.eventVersion) ||
      (candidate.eventVersion ?? 0) < 1 ||
      (candidate.eventVersion ?? 0) > 2_147_483_647 ||
      !Number.isSafeInteger(candidate.occurredAtMs) ||
      (candidate.occurredAtMs ?? -1) < 0 ||
      !validateJsonValue(candidate.payload).ok
    ) {
      throw new EventStoreError("invalid_event");
    }
    const metadata = normalizeMetadata(candidate.metadata);
    const payloadJson = canonicalJson(candidate.payload as JsonValue);
    const metadataJson = canonicalJson(metadata as JsonValue);
    if (Buffer.byteLength(payloadJson) + Buffer.byteLength(metadataJson) > MAX_EVENT_JSON_BYTES) {
      throw new EventStoreError("invalid_event");
    }
    return Object.freeze({
      eventId: candidate.eventId,
      streamType: candidate.streamType,
      streamId: candidate.streamId,
      eventType: candidate.eventType,
      eventVersion: candidate.eventVersion as number,
      occurredAtMs: candidate.occurredAtMs as number,
      payloadJson,
      metadataJson,
    });
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("invalid_event");
  }
}

function normalizeEventBatch(input: unknown): readonly NormalizedEvent[] {
  try {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < 1 ||
      input.length > MAX_APPEND_BATCH_SIZE
    ) {
      throw new EventStoreError("invalid_event");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(["length"]);
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const key = String(index);
      allowed.add(key);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new EventStoreError("invalid_event");
      }
      values.push(descriptor.value);
    }
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      allowed.size !== keys.length
    ) {
      throw new EventStoreError("invalid_event");
    }
    const normalized = values.map((event) => normalizeEvent(event));
    if (new Set(normalized.map((event) => event.eventId)).size !== normalized.length) {
      throw new EventStoreError("invalid_event");
    }
    const totalJsonBytes = normalized.reduce(
      (total, event) =>
        total + Buffer.byteLength(event.payloadJson) + Buffer.byteLength(event.metadataJson),
      0,
    );
    if (totalJsonBytes > MAX_APPEND_BATCH_EVENT_JSON_BYTES) {
      throw new EventStoreError("invalid_event");
    }
    return Object.freeze(normalized);
  } catch (error: unknown) {
    if (error instanceof EventStoreError) {
      throw error;
    }
    throw new EventStoreError("invalid_event");
  }
}

function isPlainEventInput(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const allowed = new Set([
    "eventId",
    "eventType",
    "eventVersion",
    "metadata",
    "occurredAtMs",
    "payload",
    "streamId",
    "streamType",
  ]);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(input)).every(
    (descriptor) =>
      descriptor.enumerable && descriptor.get === undefined && descriptor.set === undefined,
  );
}

function normalizeMetadata(input: unknown): EventMetadata {
  if (input === undefined) {
    return Object.freeze({});
  }
  if (
    !validateJsonValue(input).ok ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new EventStoreError("invalid_event");
  }
  const metadata = input as Record<string, JsonValue>;
  const keys = Object.keys(metadata).sort();
  if (keys.some((key) => !["actor", "causationEventId", "correlationId"].includes(key))) {
    throw new EventStoreError("invalid_event");
  }
  if (
    metadata.correlationId !== undefined &&
    !RpcIdSchema.safeParse(metadata.correlationId).success
  ) {
    throw new EventStoreError("invalid_event");
  }
  if (
    metadata.causationEventId !== undefined &&
    (typeof metadata.causationEventId !== "string" ||
      !EVENT_ID_PATTERN.test(metadata.causationEventId))
  ) {
    throw new EventStoreError("invalid_event");
  }
  if (metadata.actor !== undefined && !NamespacedTokenSchema.safeParse(metadata.actor).success) {
    throw new EventStoreError("invalid_event");
  }
  return Object.freeze({
    ...(typeof metadata.correlationId === "string"
      ? { correlationId: metadata.correlationId }
      : {}),
    ...(typeof metadata.causationEventId === "string"
      ? { causationEventId: metadata.causationEventId }
      : {}),
    ...(typeof metadata.actor === "string" ? { actor: metadata.actor } : {}),
  });
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function decodeStoredEvent(row: Record<string, unknown>): StoredEvent {
  try {
    const payloadJson = row.payload_json;
    const metadataJson = row.metadata_json;
    if (typeof payloadJson !== "string" || typeof metadataJson !== "string") {
      throw new EventStoreError("corrupt_data");
    }
    const payload = JSON.parse(payloadJson) as unknown;
    const metadata = JSON.parse(metadataJson) as unknown;
    const normalized = normalizeEvent({
      eventId: row.event_id,
      streamType: row.stream_type,
      streamId: row.stream_id,
      eventType: row.event_type,
      eventVersion: safeInteger(row.event_version),
      occurredAtMs: safeInteger(row.occurred_at_ms),
      payload,
      metadata,
    });
    if (normalized.payloadJson !== payloadJson || normalized.metadataJson !== metadataJson) {
      throw new EventStoreError("corrupt_data");
    }
    return materializeEvent(safeInteger(row.sequence), normalized);
  } catch (error: unknown) {
    if (error instanceof EventStoreError && error.code === "corrupt_data") {
      throw error;
    }
    throw new EventStoreError("corrupt_data");
  }
}

function materializeEvent(sequence: number, event: NormalizedEvent): StoredEvent {
  const payload = JSON.parse(event.payloadJson) as JsonValue;
  const metadata = JSON.parse(event.metadataJson) as EventMetadata;
  return Object.freeze({
    sequence,
    eventId: event.eventId,
    streamType: event.streamType,
    streamId: event.streamId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAtMs: event.occurredAtMs,
    payload: deepFreezeJson(payload),
    metadata: deepFreezeJson(metadata as JsonValue) as EventMetadata,
  });
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJson(item);
    }
  } else {
    for (const item of Object.values(value)) {
      deepFreezeJson(item);
    }
  }
  return Object.freeze(value);
}

function storedEventMatches(existing: StoredEvent, event: NormalizedEvent): boolean {
  return (
    existing.eventId === event.eventId &&
    existing.streamType === event.streamType &&
    existing.streamId === event.streamId &&
    existing.eventType === event.eventType &&
    existing.eventVersion === event.eventVersion &&
    existing.occurredAtMs === event.occurredAtMs &&
    canonicalJson(existing.payload) === event.payloadJson &&
    canonicalJson(existing.metadata as JsonValue) === event.metadataJson
  );
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The original fixed error is authoritative when no transaction is active.
  }
}

function safeInteger(value: unknown): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (typeof converted !== "number" || !Number.isSafeInteger(converted) || converted < 0) {
    throw new EventStoreError("corrupt_data");
  }
  return converted;
}

function nullableSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function scalarInteger(row: Record<string, unknown> | undefined): number {
  if (row === undefined) {
    throw new EventStoreError("corrupt_data");
  }
  return scalarIntegerValue(Object.values(row)[0]);
}

function scalarIntegerValue(value: unknown): number {
  return safeInteger(value);
}

function scalarString(row: Record<string, unknown> | undefined): string {
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "string") {
    throw new EventStoreError("corrupt_data");
  }
  return value;
}

function mapStorageError(error: unknown): EventStoreError {
  if (error instanceof EventStoreError) {
    return error;
  }
  if (
    error instanceof Error &&
    "errcode" in error &&
    (error.errcode === 5 || error.errcode === 6)
  ) {
    return new EventStoreError("database_busy");
  }
  return new EventStoreError("storage_failure");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
