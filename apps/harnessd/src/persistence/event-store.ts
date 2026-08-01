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
const SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const MAX_DATABASE_PATH_BYTES = 1_024;
const MAX_EVENT_JSON_BYTES = 1024 * 1024;
const MAX_READ_LIMIT = 1_000;
const EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STREAM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
let expectedSchemaFingerprint: string | undefined;

export type EventStoreErrorCode =
  | "closed"
  | "conflict"
  | "corrupt_data"
  | "database_busy"
  | "invalid_configuration"
  | "invalid_event"
  | "invalid_query"
  | "migration_mismatch"
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

export type EventStoreInspection = Readonly<{
  schemaVersion: number;
  eventCount: number;
  lastSequence: number;
  journalMode: "wal";
  sqliteVersion: string;
}>;

export type EventStoreConfig = Readonly<{
  path: string;
  busyTimeoutMs?: number;
  now?: () => number;
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

export class HarnessEventStore {
  readonly #database: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #findByEventId: StatementSync;
  readonly #readAfter: StatementSync;
  #closed = false;

  private constructor(database: DatabaseSync) {
    this.#database = database;
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
      const store = new HarnessEventStore(database);
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
    this.#assertOpen();
    const event = normalizeEvent(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const existingRow = this.#findByEventId.get(event.eventId);
      if (existingRow !== undefined) {
        const existing = decodeStoredEvent(existingRow);
        if (!storedEventMatches(existing, event)) {
          throw new EventStoreError("conflict");
        }
        this.#database.exec("COMMIT");
        return Object.freeze({ event: existing, duplicate: true });
      }

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
      const stored = materializeEvent(sequence, event);
      this.#database.exec("COMMIT");
      return Object.freeze({ event: stored, duplicate: false });
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

  inspect(): EventStoreInspection {
    this.#assertOpen();
    try {
      verifyMigration(this.#database);
      verifySchemaObjects(this.#database);
      verifyQuickCheck(this.#database);
      verifyForeignKeys(this.#database);
      const { eventCount, lastSequence } = verifyEventSequenceAndRows(this.#database);
      verifyProjectionCheckpoints(this.#database, lastSequence);
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
}

async function validateStoreConfig(config: EventStoreConfig): Promise<
  Readonly<{
    path: string;
    busyTimeoutMs: number;
    appliedAtMs: number;
    existed: boolean;
    fileIdentity: FileIdentity;
  }>
> {
  let path: string;
  let busyTimeoutMs: number;
  let now: () => number;
  try {
    path = config.path;
    busyTimeoutMs = config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    now = config.now ?? Date.now;
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
  return Object.freeze({ path, busyTimeoutMs, appliedAtMs, existed, fileIdentity });
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
  if (userVersion === 0) {
    applyMigrationV1(database, now);
  } else if (userVersion !== SCHEMA_VERSION) {
    throw new EventStoreError("unsupported_database");
  }
  verifyMigration(database);
}

function applyMigrationV1(database: DatabaseSync, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new EventStoreError("invalid_configuration");
  }
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(MIGRATION_V1_SQL);
    database
      .prepare("INSERT INTO schema_migrations (version, checksum, applied_at_ms) VALUES (?, ?, ?)")
      .run(SCHEMA_VERSION, MIGRATION_V1_CHECKSUM, now);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error: unknown) {
    rollback(database);
    throw error;
  }
}

function verifyMigration(database: DatabaseSync): void {
  const userVersion = scalarInteger(database.prepare("PRAGMA user_version").get());
  if (userVersion !== SCHEMA_VERSION) {
    throw new EventStoreError("migration_mismatch");
  }
  const row = database
    .prepare("SELECT version, checksum, applied_at_ms FROM schema_migrations ORDER BY version")
    .get();
  if (
    row === undefined ||
    scalarIntegerValue(row.version) !== SCHEMA_VERSION ||
    row.checksum !== MIGRATION_V1_CHECKSUM ||
    safeInteger(row.applied_at_ms) < 0
  ) {
    throw new EventStoreError("migration_mismatch");
  }
  const count = scalarInteger(
    database.prepare("SELECT COUNT(*) AS value FROM schema_migrations").get(),
  );
  if (count !== 1) {
    throw new EventStoreError("migration_mismatch");
  }
}

function verifySchemaObjects(database: DatabaseSync): void {
  if (schemaFingerprint(database) !== getExpectedSchemaFingerprint()) {
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

function getExpectedSchemaFingerprint(): string {
  if (expectedSchemaFingerprint !== undefined) {
    return expectedSchemaFingerprint;
  }
  const expected = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    expected.exec(MIGRATION_V1_SQL);
    expectedSchemaFingerprint = schemaFingerprint(expected);
    return expectedSchemaFingerprint;
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

function verifyProjectionCheckpoints(database: DatabaseSync, lastEventSequence: number): void {
  for (const row of database
    .prepare(
      `SELECT projection_name, projection_version, last_sequence, updated_at_ms
       FROM projection_checkpoints ORDER BY projection_name`,
    )
    .iterate()) {
    if (
      typeof row.projection_name !== "string" ||
      !NamespacedTokenSchema.safeParse(row.projection_name).success ||
      safeInteger(row.projection_version) < 1 ||
      safeInteger(row.last_sequence) > lastEventSequence ||
      safeInteger(row.updated_at_ms) < 0
    ) {
      throw new EventStoreError("corrupt_data");
    }
  }
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
