/**
 * Durable Object for storing and managing PageSpeed report records
 * Uses SQLite storage for persistence and state management
 */

import { DurableObject } from "cloudflare:workers";
import type {
  CreateRecordRequest,
  UpdateRecordRequest,
} from "./types";
import { DURABLE_OBJECT_ROUTES } from "./constants";
import {
  createTable,
  addPublicIdColumn,
  addProcessingStartedAtColumn,
  createPublicIdUniqueIndex,
  createPublicIdIndex,
  updateMissingPublicIds,
  setPublicIdForRecord,
  insertRecord,
  updateRecordById,
  getRecordById,
  getRecordByPublicId,
  getRecordByUrlAndTime,
  listRecords,
  getNextId,
  deleteOldRecords,
  getStuckProcessingRecords,
  type PageSpeedRecordRow,
} from "./services/sql-helpers";

export class PageSpeedDurableObject extends DurableObject<Env> {


  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  /**
   * Ensures the table exists and has all required columns
   * Handles both new tables and existing tables that need the publicId column
   */
  private async ensureTableExists(): Promise<void> {
    const sql = this.ctx.storage.sql;

    // Create table if it doesn't exist (with publicId for new tables)
    await createTable(sql);

    // Try to add publicId column if it doesn't exist (for existing tables)
    // SQLite will throw an error if the column already exists, which we can ignore
    try {
      await addPublicIdColumn(sql);
    } catch (error: any) {
      // Column already exists - this is expected if the table was already migrated or is new
      // We can safely ignore this error
      const errorMsg = error.message || String(error);
      if (!errorMsg.includes("duplicate") && !errorMsg.includes("already exists")) {
        // If it's a different error, log it for debugging
        console.warn("Note when adding publicId column:", errorMsg);
      }
    }

    // Try to add processingStartedAt column if it doesn't exist (for existing tables)
    try {
      await addProcessingStartedAtColumn(sql);
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      if (!errorMsg.includes("duplicate") && !errorMsg.includes("already exists")) {
        console.warn("Note when adding processingStartedAt column:", errorMsg);
      }
    }
    
    // Generate UUIDs for any existing records that don't have one
    try {
      const existingRecordsCursor = updateMissingPublicIds(sql);
      const records = existingRecordsCursor.toArray();
      
      for (const record of records) {
        const newPublicId = crypto.randomUUID();
        await setPublicIdForRecord(sql, record.id, newPublicId);
      }
    } catch (error: any) {
      // If there's an error, log it but continue
      console.warn("Error populating publicId for existing records:", error.message);
    }

    // Ensure unique index exists on publicId
    try {
      await createPublicIdUniqueIndex(sql);
    } catch (error: any) {
      // Index might already exist or there might be duplicate NULLs, that's okay for now
      // We'll handle making it NOT NULL after all records have UUIDs
    }

    // Ensure regular index exists
    await createPublicIdIndex(sql);
  }

  /**
   * Main request handler - routes to appropriate handler based on path
   */
  async fetch(request: Request): Promise<Response> {
    await this.ensureTableExists();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === DURABLE_OBJECT_ROUTES.CREATE) {
        return this.handleCreate(request);
      } else if (path === DURABLE_OBJECT_ROUTES.UPDATE) {
        return this.handleUpdate(request);
      } else if (path === DURABLE_OBJECT_ROUTES.GET) {
        return this.handleGet(request);
      } else if (path === DURABLE_OBJECT_ROUTES.GET_BY_ID) {
        return this.handleGetById(request);
      } else if (path === DURABLE_OBJECT_ROUTES.GET_BY_PUBLIC_ID) {
        return this.handleGetByPublicId(request);
      } else if (path === DURABLE_OBJECT_ROUTES.LIST) {
        return this.handleList(request);
      } else if (path === DURABLE_OBJECT_ROUTES.DELETE_OLD) {
        return this.handleDeleteOld(request);
      } else if (path === DURABLE_OBJECT_ROUTES.GET_STUCK_PROCESSING) {
        return this.handleGetStuckProcessing(request);
      } else {
        return new Response("Not found", { status: 404 });
      }
    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /**
   * Creates a new PageSpeed record
   */
  private async handleCreate(request: Request): Promise<Response> {
    const body = await request.json<CreateRecordRequest>();
    const publicId = crypto.randomUUID();

    const cursor = insertRecord(this.ctx.storage.sql, {
      publicId,
      url: body.requestUrl,
      formFactor: body.formFactor,
      date: Date.now(),
      data: JSON.stringify(body.data),
      status: body.status,
      dataUrl: "",
    });

    const result = cursor.one();

    return new Response(JSON.stringify({ id: result.id, publicId: result.publicId }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Updates an existing PageSpeed record
   */
  private async handleUpdate(request: Request): Promise<Response> {
    const body = await request.json<UpdateRecordRequest>();

    const cursor = updateRecordById(this.ctx.storage.sql, body.id, {
      status: body.status,
      data: JSON.stringify(body.data),
      dataUrl: body.dataUrl,
      processingStartedAt: body.processingStartedAt,
    });

    if (cursor.rowsWritten === 0) {
      return new Response(JSON.stringify({ error: "Record not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Retrieves the most recent record matching URL and time threshold
   */
  private async handleGet(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestURL = url.searchParams.get("url");
    const time = +(url.searchParams.get("time") || "0");

    if (!requestURL) {
      return new Response(JSON.stringify({ error: "url parameter required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const cursor = getRecordByUrlAndTime(this.ctx.storage.sql, requestURL, time);
    const records = cursor.toArray();
    const record = records[0];

    if (!record) {
      return new Response(JSON.stringify(null), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse JSON data
    let parsedData: any;
    try {
      parsedData = JSON.parse(record.data);
    } catch {
      parsedData = record.data;
    }

    const result = {
      publicId: record.publicId,
      url: record.url,
      status: record.status,
      dataUrl: record.dataUrl,
      data: parsedData,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Retrieves a record by its internal ID (used internally)
   */
  private async handleGetById(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const idParam = url.searchParams.get("id");

    if (!idParam) {
      return new Response(JSON.stringify({ error: "id parameter required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const id = +(idParam);
    const cursor = getRecordById(this.ctx.storage.sql, id);
    const records = cursor.toArray();
    const record = records[0];

    if (!record) {
      return new Response(JSON.stringify(null), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse JSON data
    let parsedData: any;
    try {
      parsedData = JSON.parse(record.data);
    } catch {
      parsedData = record.data;
    }

    const result = {
      publicId: record.publicId,
      url: record.url,
      status: record.status,
      dataUrl: record.dataUrl,
      data: parsedData,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Retrieves a record by its public ID (UUID)
   */
  private async handleGetByPublicId(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const publicId = url.searchParams.get("publicId");

    if (!publicId) {
      return new Response(JSON.stringify({ error: "publicId parameter required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const cursor = getRecordByPublicId(this.ctx.storage.sql, publicId);
    const records = cursor.toArray();
    const record = records[0];

    if (!record) {
      return new Response(JSON.stringify(null), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse JSON data
    let parsedData: any;
    try {
      parsedData = JSON.parse(record.data);
    } catch {
      parsedData = record.data;
    }

    const result = {
      publicId: record.publicId,
      url: record.url,
      status: record.status,
      dataUrl: record.dataUrl,
      data: parsedData,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Lists all records (without full data payload)
   */
  private async handleList(request: Request): Promise<Response> {
    const cursor = listRecords(this.ctx.storage.sql);
    const records = cursor.toArray();

    // Get the next ID by finding the max ID
    const maxIdCursor = getNextId(this.ctx.storage.sql);
    const maxIdRecords = maxIdCursor.toArray();
    const nextId = maxIdRecords[0]?.nextId || 1;

    const allRecords = records.map((record: {
      id: number;
      publicId: string;
      url: string;
      formFactor: string;
      date: number;
      status: string;
      dataUrl: string;
      hasData: number;
    }) => ({
      publicId: record.publicId,
      url: record.url,
      formFactor: record.formFactor,
      date: record.date,
      status: record.status,
      dataUrl: record.dataUrl,
      hasData: record.hasData === 1,
    }));

    return new Response(
      JSON.stringify({
        total: allRecords.length,
        nextId,
        records: allRecords,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  /**
   * Deletes records older than 10 days
   */
  private async handleDeleteOld(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const daysParam = url.searchParams.get("days");
    const daysOld = daysParam ? +(daysParam) : 10;

    if (isNaN(daysOld) || daysOld < 0) {
      return new Response(
        JSON.stringify({ error: "Invalid days parameter. Must be a positive number." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const cursor = deleteOldRecords(this.ctx.storage.sql, daysOld);
    const deletedCount = cursor.rowsWritten;

    return new Response(
      JSON.stringify({
        success: true,
        deletedCount,
        daysOld,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  /**
   * Gets records that are stuck in processing for more than the specified duration
   */
  private async handleGetStuckProcessing(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const durationParam = url.searchParams.get("durationMs");
    const maxDurationMs = durationParam ? +(durationParam) : 3 * 60 * 1000; // Default 3 minutes

    if (isNaN(maxDurationMs) || maxDurationMs < 0) {
      return new Response(
        JSON.stringify({ error: "Invalid durationMs parameter. Must be a positive number." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const cursor = getStuckProcessingRecords(this.ctx.storage.sql, maxDurationMs);
    const records = cursor.toArray();

    const result = records.map((record: PageSpeedRecordRow) => {
      // Parse JSON data
      let parsedData: any;
      try {
        parsedData = JSON.parse(record.data as string);
      } catch {
        parsedData = record.data;
      }

      return {
        id: record.id,
        publicId: record.publicId,
        url: record.url,
        formFactor: record.formFactor,
        date: record.date,
        status: record.status,
        processingStartedAt: record.processingStartedAt,
        data: parsedData,
      };
    });

    return new Response(
      JSON.stringify({
        count: result.length,
        records: result,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
