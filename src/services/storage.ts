/**
 * Storage operations for Durable Objects and R2 bucket
 */

import type {
  CreateRecordRequest,
  UpdateRecordRequest,
  RecordResponse,
} from "../types";
import {
  DURABLE_OBJECT_ROUTES,
  RESULTS_BUCKET_PREFIX,
  RESULTS_EXPIRY_DAYS,
} from "../constants";

/**
 * Gets the Durable Object stub for PageSpeed storage
 */
async function getDurableObjectStub(env: Env): Promise<DurableObjectStub> {
  const id = env.PAGE_SPEED.idFromName("pagespeed-storage");
  return env.PAGE_SPEED.get(id);
}

/**
 * Creates a new pending record in the Durable Object
 * Returns both internal id and publicId
 */
export async function createPendingRecord(
  request: CreateRecordRequest,
  env: Env
): Promise<{ id: number; publicId: string }> {
  const stub = await getDurableObjectStub(env);
  const response = await stub.fetch(
    `https://do.internal${DURABLE_OBJECT_ROUTES.CREATE}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object create error:", response.status, text);
    throw new Error(`Durable Object create error: ${response.status} ${text}`);
  }

  const result = await response.json<{ id: number; publicId: string }>();
  return result;
}

/**
 * Updates an existing record in the Durable Object
 */
export async function updateRecord(
  request: UpdateRecordRequest,
  env: Env
): Promise<number | null> {
  const stub = await getDurableObjectStub(env);
  const response = await stub.fetch(
    `https://do.internal${DURABLE_OBJECT_ROUTES.UPDATE}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object update error:", response.status, text);
    throw new Error(`Durable Object update error: ${response.status} ${text}`);
  }

  const result = await response.json<{ success: boolean }>();
  return result.success ? request.id : null;
}

/**
 * Retrieves a record by URL and time threshold
 */
export async function getRecordByUrl(
  requestUrl: string,
  timeThreshold: number,
  env: Env
): Promise<RecordResponse | null> {
  const stub = await getDurableObjectStub(env);
  const url = new URL(`https://do.internal${DURABLE_OBJECT_ROUTES.GET}`);
  url.searchParams.append("url", requestUrl);
  url.searchParams.append("time", timeThreshold.toString());

  const response = await stub.fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object get error:", response.status, text);
    return null;
  }

  const record = await response.json<RecordResponse | null>();
  if (!record) {
    return null;
  }

  // Load data from R2 if dataUrl is present
  if (record.dataUrl) {
    const bucketData = await env.RESULTS_BUCKET.get(record.dataUrl);
    if (bucketData) {
      const text = await bucketData.text();
      record.data = text;
    }
  }

  return record;
}

/**
 * Retrieves a record by internal ID (used internally)
 */
export async function getRecordById(
  id: number,
  env: Env
): Promise<RecordResponse | null> {
  const stub = await getDurableObjectStub(env);
  const url = new URL(`https://do.internal${DURABLE_OBJECT_ROUTES.GET_BY_ID}`);
  url.searchParams.append("id", id.toString());

  const response = await stub.fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object getById error:", response.status, text);
    return null;
  }

  const record = await response.json<RecordResponse | null>();
  if (!record) {
    return null;
  }

  // Load data from R2 if dataUrl is present
  if (record.dataUrl) {
    const bucketData = await env.RESULTS_BUCKET.get(record.dataUrl);
    if (bucketData) {
      const text = await bucketData.text();
      record.data = text;
    }
  }

  return record;
}

/**
 * Retrieves a record by public ID (UUID)
 */
export async function getRecordByPublicId(
  publicId: string,
  env: Env
): Promise<RecordResponse | null> {
  const stub = await getDurableObjectStub(env);
  const url = new URL(`https://do.internal${DURABLE_OBJECT_ROUTES.GET_BY_PUBLIC_ID}`);
  url.searchParams.append("publicId", publicId);

  const response = await stub.fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object getByPublicId error:", response.status, text);
    return null;
  }

  const record = await response.json<RecordResponse | null>();
  if (!record) {
    return null;
  }

  // Load data from R2 if dataUrl is present
  if (record.dataUrl) {
    const bucketData = await env.RESULTS_BUCKET.get(record.dataUrl);
    if (bucketData) {
      const text = await bucketData.text();
      record.data = text;
    }
  }

  return record;
}

/**
 * Lists all records in the Durable Object
 */
export async function listAllRecords(env: Env): Promise<any> {
  const stub = await getDurableObjectStub(env);
  const response = await stub.fetch(
    `https://do.internal${DURABLE_OBJECT_ROUTES.LIST}`
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object list error:", response.status, text);
    throw new Error(`Durable Object list error: ${response.status} ${text}`);
  }

  return response.json();
}

/**
 * Saves PageSpeed results to R2 bucket
 */
export async function saveResultsToBucket(
  recordId: number,
  url: string,
  results: any[],
  env: Env
): Promise<string> {
  const key = `${RESULTS_BUCKET_PREFIX}${recordId}-${encodeURIComponent(url)}.json`;
  const expiresAt = new Date(
    Date.now() + RESULTS_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  await env.RESULTS_BUCKET.put(key, JSON.stringify(results), {
    httpMetadata: {
      contentType: "application/json",
    },
    customMetadata: {
      expiresAt,
    },
  });

  return key;
}

/**
 * Deletes old records from the Durable Object
 * Defaults to 10 days if not specified
 */
export async function deleteOldRecordsFromStorage(
  daysOld: number = 10,
  env: Env
): Promise<{ success: boolean; deletedCount: number; daysOld: number }> {
  const stub = await getDurableObjectStub(env);
  const url = new URL(`https://do.internal${DURABLE_OBJECT_ROUTES.DELETE_OLD}`);
  url.searchParams.append("days", daysOld.toString());

  const response = await stub.fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object deleteOld error:", response.status, text);
    throw new Error(`Durable Object deleteOld error: ${response.status} ${text}`);
  }

  return response.json<{ success: boolean; deletedCount: number; daysOld: number }>();
}

/**
 * Gets records that are stuck in processing for more than the specified duration
 */
export async function getStuckProcessingRecords(
  maxProcessingDurationMs: number,
  env: Env
): Promise<Array<{ id: number; publicId: string; url: string; formFactor: string; date: number; status: string; processingStartedAt: number | null; data: any }>> {
  const stub = await getDurableObjectStub(env);
  const url = new URL(`https://do.internal${DURABLE_OBJECT_ROUTES.GET_STUCK_PROCESSING}`);
  url.searchParams.append("durationMs", maxProcessingDurationMs.toString());

  const response = await stub.fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    console.error("Durable Object getStuckProcessing error:", response.status, text);
    throw new Error(`Durable Object getStuckProcessing error: ${response.status} ${text}`);
  }

  const result = await response.json<{ count: number; records: Array<{ id: number; publicId: string; url: string; formFactor: string; date: number; status: string; processingStartedAt: number | null; data: any }> }>();
  return result.records;
}
