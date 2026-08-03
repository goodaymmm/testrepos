import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type WorkflowCheckpointRecord,
  type WorkflowCheckpointScanResult,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointWrite
} from "./checkpoint-store.js";

const sqliteSchemaVersion = "1";

type CheckpointRow = {
  workflow_id: string;
  sequence: number;
  state_hash: string;
  fencing_token: string;
  checkpoint_path: string;
  recorded_at: string;
};

export class SqliteWorkflowCheckpointStore implements WorkflowCheckpointStore {
  readonly adapter = "sqlite" as const;

  private constructor(
    private readonly databasePath: string,
    private readonly database: DatabaseSync
  ) {}

  static async open(
    databasePath: string,
    options: { busyTimeoutMs: number; create?: boolean }
  ): Promise<SqliteWorkflowCheckpointStore> {
    if (options.create === false) {
      await access(databasePath);
    } else {
      await mkdir(path.dirname(databasePath), { recursive: true });
    }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath, {
      timeout: options.busyTimeoutMs,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    try {
      database.exec("PRAGMA journal_mode = WAL;");
      database.exec("PRAGMA synchronous = NORMAL;");
      initializeSchema(database);
      return new SqliteWorkflowCheckpointStore(databasePath, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async upsert(write: WorkflowCheckpointWrite): Promise<void> {
    upsertRecord(this.database, write.record);
  }

  async scan(): Promise<WorkflowCheckpointScanResult> {
    const rows = this.database
      .prepare(
        `SELECT workflow_id, sequence, state_hash, fencing_token,
                checkpoint_path, recorded_at
           FROM workflow_checkpoints
          ORDER BY workflow_id, sequence`
      )
      .all() as CheckpointRow[];
    return {
      adapter: this.adapter,
      records: rows.map(rowToRecord),
      issues: []
    };
  }

  async replace(records: WorkflowCheckpointRecord[]): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.exec("DELETE FROM workflow_checkpoints;");
      for (const record of records) {
        upsertRecord(this.database, record);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }

  get path(): string {
    return this.databasePath;
  }
}

export async function isNodeSqliteAvailable(): Promise<boolean> {
  try {
    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(":memory:");
    database.close();
    return true;
  } catch {
    return false;
  }
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_store_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      workflow_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      state_hash TEXT NOT NULL,
      fencing_token TEXT NOT NULL,
      checkpoint_path TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, sequence)
    );
  `);
  const expectedColumns = [
    "workflow_id",
    "sequence",
    "state_hash",
    "fencing_token",
    "checkpoint_path",
    "recorded_at"
  ];
  const actualColumns = (
    database.prepare("PRAGMA table_info(workflow_checkpoints)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
  if (
    expectedColumns.length !== actualColumns.length ||
    expectedColumns.some((column) => !actualColumns.includes(column))
  ) {
    throw new Error(
      "Unsupported workflow checkpoint SQLite schema: incompatible columns"
    );
  }
  const metadata = database
    .prepare(
      "SELECT value FROM checkpoint_store_metadata WHERE key = 'schema_version'"
    )
    .get() as { value: string } | undefined;
  if (metadata === undefined) {
    database
      .prepare(
        "INSERT INTO checkpoint_store_metadata (key, value) VALUES ('schema_version', ?)"
      )
      .run(sqliteSchemaVersion);
    return;
  }
  if (metadata.value !== sqliteSchemaVersion) {
    throw new Error(
      `Unsupported workflow checkpoint SQLite schema: ${metadata.value}`
    );
  }
}

function upsertRecord(
  database: DatabaseSync,
  record: WorkflowCheckpointRecord
): void {
  database
    .prepare(
      `INSERT INTO workflow_checkpoints (
         workflow_id, sequence, state_hash, fencing_token,
         checkpoint_path, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, sequence) DO UPDATE SET
         state_hash = excluded.state_hash,
         fencing_token = excluded.fencing_token,
         checkpoint_path = excluded.checkpoint_path,
         recorded_at = excluded.recorded_at`
    )
    .run(
      record.workflow_id,
      record.sequence,
      record.state_hash,
      record.fencing_token,
      record.checkpoint_path,
      record.recorded_at
    );
}

function rowToRecord(row: CheckpointRow): WorkflowCheckpointRecord {
  return {
    schema_version: "0.1",
    workflow_id: row.workflow_id,
    sequence: Number(row.sequence),
    state_hash: row.state_hash,
    fencing_token: row.fencing_token,
    checkpoint_path: row.checkpoint_path,
    recorded_at: row.recorded_at
  };
}
