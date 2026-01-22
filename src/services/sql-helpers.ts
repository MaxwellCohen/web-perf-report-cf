/**
 * SQL helper functions for PageSpeed records
 * All functions work with SqlStorage type from Cloudflare Durable Objects
 * SqlStorage and SqlStorageCursor are global types defined in worker-configuration.d.ts
 */

const TABLE_NAME = "PageSpeedInsightsTable";

/**
 * Record types for SQL operations
 * SqlStorageValue = ArrayBuffer | string | number | null
 */
export interface PageSpeedRecordRow extends Record<string, SqlStorageValue> {
  id: number;
  publicId: string;
  url: string;
  formFactor: string;
  date: number;
  data: string;
  status: string;
  dataUrl: string;
}

export interface PageSpeedRecordInsert {
  publicId: string;
  url: string;
  formFactor: string;
  date: number;
  data: string;
  status: string;
  dataUrl: string;
}

export interface PageSpeedRecordUpdate {
  status?: string;
  data?: string;
  dataUrl?: string;
}

/**
 * Creates the PageSpeedInsightsTable if it doesn't exist
 */
export async function createTable(sql: SqlStorage): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      publicId TEXT,
      url TEXT NOT NULL,
      formFactor TEXT NOT NULL,
      date INTEGER,
      data BLOB NOT NULL,
      status TEXT CHECK (status IN ('pending', 'processing', 'completed', 'failed')) DEFAULT 'pending' NOT NULL,
      dataUrl TEXT
    )
  `);
}

/**
 * Adds the publicId column to an existing table
 * Returns true if successful, false if column already exists
 */
export async function addPublicIdColumn(sql: SqlStorage): Promise<boolean> {
  try {
    await sql.exec(`
      ALTER TABLE ${TABLE_NAME} ADD COLUMN publicId TEXT
    `);
    return true;
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    if (errorMsg.includes("duplicate") || errorMsg.includes("already exists")) {
      return false;
    }
    throw error;
  }
}

/**
 * Creates a unique index on publicId
 */
export async function createPublicIdUniqueIndex(sql: SqlStorage): Promise<void> {
  await sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publicId_unique ON ${TABLE_NAME}(publicId)
  `);
}

/**
 * Creates a regular index on publicId
 */
export async function createPublicIdIndex(sql: SqlStorage): Promise<void> {
  await sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_publicId ON ${TABLE_NAME}(publicId)
  `);
}

/**
 * Inserts a new record and returns the inserted id and publicId
 */
export function insertRecord(
  sql: SqlStorage,
  record: PageSpeedRecordInsert
): SqlStorageCursor<{ id: number; publicId: string }> {
  return sql.exec<{ id: number; publicId: string }>(
    `INSERT INTO ${TABLE_NAME} (publicId, url, formFactor, date, data, status, dataUrl) 
     VALUES (?, ?, ?, ?, ?, ?, ?) 
     RETURNING id, publicId`,
    record.publicId,
    record.url,
    record.formFactor,
    record.date,
    record.data,
    record.status,
    record.dataUrl || ""
  );
}

/**
 * Updates a record by id
 * Returns the number of rows affected
 */
export function updateRecordById(
  sql: SqlStorage,
  id: number,
  updates: PageSpeedRecordUpdate
): SqlStorageCursor<never> {
  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.data !== undefined) {
    setClauses.push("data = ?");
    values.push(updates.data);
  }
  if (updates.dataUrl !== undefined) {
    setClauses.push("dataUrl = ?");
    values.push(updates.dataUrl);
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }

  values.push(id);

  return sql.exec(
    `UPDATE ${TABLE_NAME} 
     SET ${setClauses.join(", ")} 
     WHERE id = ?`,
    ...values
  );
}

/**
 * Updates a record by publicId
 * Returns the number of rows affected
 */
export function updateRecordByPublicId(
  sql: SqlStorage,
  publicId: string,
  updates: PageSpeedRecordUpdate
): SqlStorageCursor<never> {
  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.data !== undefined) {
    setClauses.push("data = ?");
    values.push(updates.data);
  }
  if (updates.dataUrl !== undefined) {
    setClauses.push("dataUrl = ?");
    values.push(updates.dataUrl);
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }

  values.push(publicId);

  return sql.exec(
    `UPDATE ${TABLE_NAME} 
     SET ${setClauses.join(", ")} 
     WHERE publicId = ?`,
    ...values
  );
}

/**
 * Updates publicId for records that don't have one
 */
export function updateMissingPublicIds(
  sql: SqlStorage,
  publicIdGenerator: () => string = () => crypto.randomUUID()
): SqlStorageCursor<{ id: number }> {
  return sql.exec<{ id: number }>(
    `SELECT id FROM ${TABLE_NAME} WHERE publicId IS NULL OR publicId = ''`
  );
}

/**
 * Sets publicId for a specific record by id
 */
export function setPublicIdForRecord(
  sql: SqlStorage,
  id: number,
  publicId: string
): SqlStorageCursor<never> {
  return sql.exec(
    `UPDATE ${TABLE_NAME} SET publicId = ? WHERE id = ?`,
    publicId,
    id
  );
}

/**
 * Gets a record by id
 */
export function getRecordById(
  sql: SqlStorage,
  id: number
): SqlStorageCursor<PageSpeedRecordRow> {
  return sql.exec<PageSpeedRecordRow>(
    `SELECT id, publicId, url, formFactor, date, data, status, dataUrl 
     FROM ${TABLE_NAME} 
     WHERE id = ?`,
    id
  );
}

/**
 * Gets a record by publicId
 */
export function getRecordByPublicId(
  sql: SqlStorage,
  publicId: string
): SqlStorageCursor<PageSpeedRecordRow> {
  return sql.exec<PageSpeedRecordRow>(
    `SELECT id, publicId, url, formFactor, date, data, status, dataUrl 
     FROM ${TABLE_NAME} 
     WHERE publicId = ?`,
    publicId
  );
}

/**
 * Gets the most recent record matching URL and time threshold
 */
export function getRecordByUrlAndTime(
  sql: SqlStorage,
  url: string,
  timeThreshold: number
): SqlStorageCursor<PageSpeedRecordRow> {
  return sql.exec<PageSpeedRecordRow>(
    `SELECT id, publicId, url, formFactor, date, data, status, dataUrl 
     FROM ${TABLE_NAME} 
     WHERE url = ? AND date >= ? 
     ORDER BY date DESC 
     LIMIT 1`,
    url,
    timeThreshold
  );
}

/**
 * Lists all records without the full data payload
 */
export function listRecords(
  sql: SqlStorage
): SqlStorageCursor<{
  id: number;
  publicId: string;
  url: string;
  formFactor: string;
  date: number;
  status: string;
  dataUrl: string;
  hasData: number;
}> {
  return sql.exec<{
    id: number;
    publicId: string;
    url: string;
    formFactor: string;
    date: number;
    status: string;
    dataUrl: string;
    hasData: number;
  }>(
    `SELECT id, publicId, url, formFactor, date, status, dataUrl, 
            CASE WHEN data IS NULL OR data = '' THEN 0 ELSE 1 END as hasData
     FROM ${TABLE_NAME} 
     ORDER BY date DESC`
  );
}

/**
 * Gets the next available ID (max id + 1)
 */
export function getNextId(sql: SqlStorage): SqlStorageCursor<{ nextId: number }> {
  return sql.exec<{ nextId: number }>(
    `SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM ${TABLE_NAME}`
  );
}

/**
 * Deletes a record by id
 */
export function deleteRecordById(
  sql: SqlStorage,
  id: number
): SqlStorageCursor<never> {
  return sql.exec(`DELETE FROM ${TABLE_NAME} WHERE id = ?`, id);
}

/**
 * Deletes a record by publicId
 */
export function deleteRecordByPublicId(
  sql: SqlStorage,
  publicId: string
): SqlStorageCursor<never> {
  return sql.exec(`DELETE FROM ${TABLE_NAME} WHERE publicId = ?`, publicId);
}

/**
 * Gets records by status
 */
export function getRecordsByStatus(
  sql: SqlStorage,
  status: string
): SqlStorageCursor<PageSpeedRecordRow> {
  return sql.exec<PageSpeedRecordRow>(
    `SELECT id, publicId, url, formFactor, date, data, status, dataUrl 
     FROM ${TABLE_NAME} 
     WHERE status = ? 
     ORDER BY date DESC`,
    status
  );
}

/**
 * Gets records by formFactor
 */
export function getRecordsByFormFactor(
  sql: SqlStorage,
  formFactor: string
): SqlStorageCursor<PageSpeedRecordRow> {
  return sql.exec<PageSpeedRecordRow>(
    `SELECT id, publicId, url, formFactor, date, data, status, dataUrl 
     FROM ${TABLE_NAME} 
     WHERE formFactor = ? 
     ORDER BY date DESC`,
    formFactor
  );
}

/**
 * Counts total records
 */
export function countRecords(sql: SqlStorage): SqlStorageCursor<{ count: number }> {
  return sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM ${TABLE_NAME}`);
}

/**
 * Counts records by status
 */
export function countRecordsByStatus(
  sql: SqlStorage,
  status: string
): SqlStorageCursor<{ count: number }> {
  return sql.exec<{ count: number }>(
    `SELECT COUNT(*) as count FROM ${TABLE_NAME} WHERE status = ?`,
    status
  );
}

/**
 * Deletes records older than the specified number of days
 * Returns the number of rows deleted
 */
export function deleteOldRecords(
  sql: SqlStorage,
  daysOld: number
): SqlStorageCursor<never> {
  const cutoffDate = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  return sql.exec(
    `DELETE FROM ${TABLE_NAME} WHERE date < ?`,
    cutoffDate
  );
}
