import { DurableObject } from "cloudflare:workers";

type formFactor = "DESKTOP" | "MOBILE";

function getPageSpeedDataURl(testURL: string, formFactor: formFactor, env: Env) {
  const baseurl = new URL(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
  );
  baseurl.searchParams.append("url", encodeURI(testURL));
  ["ACCESSIBILITY", "BEST_PRACTICES", "PERFORMANCE", "SEO"].forEach(
    (category) => baseurl.searchParams.append("category", category)
  );
  baseurl.searchParams.append("key", env.PAGESPEED_INSIGHTS_API ?? "");
  if (formFactor) {
    baseurl.searchParams.append("strategy", formFactor);
  }
  return baseurl.toString();
}

async function fetchPageSpeedData(requestUrl: string, formFactor: formFactor, env: Env) {
  const url = getPageSpeedDataURl(requestUrl, formFactor, env);
  const r = await fetch(url);
  if (!r.ok) {
    console.log(r.status);
    return { error: await r.text() };
  }
  return r.json();
}

async function getDurableObject(env: Env): Promise<DurableObjectStub> {
  const id = env.PAGESPEED_DO.idFromName("pagespeed-storage");
  return env.PAGESPEED_DO.get(id);
}

async function makePendingRecord({
  requestUrl,
  formFactor,
  status,
  data,
  env,
}: {
  requestUrl: string;
  formFactor: string;
  status: "pending" | "processing" | "completed" | "failed";
  data: any;
  env: Env;
}) {
  const stub = await getDurableObject(env);
  const response = await stub.fetch("https://do.internal/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestUrl,
      formFactor,
      status,
      data,
    }),
  });
  const result = await response.json<{ id: number }>();
  return result.id;
}

async function updateRecordWithID({
  id,
  status,
  data,
  dataUrl,
  env,
}: {
  id: number;
  status: "pending" | "processing" | "completed" | "failed";
  data: any;
  dataUrl: string;
  env: Env;
}) {
  console.log("updating", id, status, data);
  const stub = await getDurableObject(env);
  const response = await stub.fetch("https://do.internal/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      status,
      data,
      dataUrl,
    }),
  });
  const result = await response.json<{ success: boolean }>();
  return result.success ? id : null;
}

async function runFullReport({ url, env, id }: { url: string; env: Env; id?: number }) {
  console.log("running full report for", url, "with id", id);
  if (!url) {
    console.error("runFullReport: url is required");
    return false;
  }
  
  let recordId = id;
  if (!recordId) {
    console.log("runFullReport: creating new pending record");
    recordId = await makePendingRecord({
      requestUrl: url,
      formFactor: "ALL",
      status: "pending",
      data: {},
      env,
    });
  }
  
  console.log("runFullReport: using record id", recordId);

  try {
    // Update status to processing
    console.log("runFullReport: updating status to processing for id", recordId);
    await updateRecordWithID({
      id: recordId,
      status: "processing",
      data: {},
      dataUrl: "",
      env,
    });
    console.log("runFullReport: status updated to processing");

    console.log("runFullReport: fetching PageSpeed data for mobile and desktop");
    const [mobile, desktop] = await Promise.all([
      fetchPageSpeedData(url, "MOBILE", env),
      fetchPageSpeedData(url, "DESKTOP", env),
    ]);
    
    // Check for errors in the responses
    if ((mobile && typeof mobile === 'object' && 'error' in mobile) || 
        (desktop && typeof desktop === 'object' && 'error' in desktop)) {
      const mobileError = (mobile && typeof mobile === 'object' && 'error' in mobile) ? mobile.error : '';
      const desktopError = (desktop && typeof desktop === 'object' && 'error' in desktop) ? desktop.error : '';
      throw new Error(`PageSpeed API error: ${mobileError || desktopError}`);
    }
    
    console.log("runFullReport: PageSpeed data fetched, saving to bucket");
    const key = `results/${recordId}-${encodeURIComponent(url)}.json`;
    await env.RESULTS_BUCKET.put(key, JSON.stringify([mobile, desktop]), {
      httpMetadata: {
        contentType: "text/plain",
      },
      customMetadata: {
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    console.log("runFullReport: data saved to bucket, updating record to completed");
    
    await updateRecordWithID({
      id: recordId,
      status: "completed",
      data: [],
      dataUrl: `results/${recordId}-${encodeURIComponent(url)}.json`,
      env,
    });
    console.log("runFullReport: record updated to completed for id", recordId);
    return true;
  } catch (e) {
    console.error("runFullReport: error occurred", e);
    const errorData = e instanceof Error ? { error: e.message, stack: e.stack } : { error: String(e) };
    console.log("runFullReport: updating record to failed with error", errorData);
    await updateRecordWithID({
      id: recordId,
      status: "failed",
      data: errorData,
      dataUrl: "",
      env,
    });
    console.log("runFullReport: record updated to failed for id", recordId);
    return false;
  }
}
async function getExistingData({
  requestURL,
  time,
  env,
}: {
  requestURL: string;
  time: number;
  env: Env;
}) {
  const stub = await getDurableObject(env);
  const response = await stub.fetch(
    `https://do.internal/get?url=${encodeURIComponent(requestURL)}&time=${time}`
  );
  const existingData = await response.json<{
    id: number;
    url: string;
    status: string;
    dataUrl: string;
    data: any;
  } | null>();

  if (existingData && typeof existingData.dataUrl === "string" && existingData.dataUrl) {
    const data = await env.RESULTS_BUCKET.get(existingData.dataUrl);
    if (data) {
      const text = await data.text();
      try {
        existingData.data = JSON.parse(text);
      } catch {
        existingData.data = text;
      }
    }
  }
  return existingData;
}

async function getRecordById({
  id,
  env,
}: {
  id: number;
  env: Env;
}) {
  const stub = await getDurableObject(env);
  const response = await stub.fetch(
    `https://do.internal/getById?id=${id}`
  );
  const record = await response.json<{
    id: number;
    url: string;
    status: string;
    dataUrl: string;
    data: any;
  } | null>();

  if (record && typeof record.dataUrl === "string" && record.dataUrl) {
    const data = await env.RESULTS_BUCKET.get(record.dataUrl);
    if (data) {
      const text = await data.text();
      try {
        record.data = JSON.parse(text);
      } catch {
        record.data = text;
      }
    }
  }
  return record;
}

async function listAllRecords(env: Env) {
  const stub = await getDurableObject(env);
  const response = await stub.fetch("https://do.internal/list");
  return await response.json();
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Debug endpoint to list all records in the Durable Object
    if (url.pathname === "/debug/list") {
      const records = await listAllRecords(env);
      return new Response(JSON.stringify(records, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/") {
      const requestURL = url.searchParams.get("url");
      if (!requestURL) {
        return new Response("Missing url", { status: 400 });
      }
      const time = new Date(Date.now() - 60 * 60 * 1000).getTime();
      // check durable object for existing data for items in the last hour
      const existingData = await getExistingData({ requestURL, time, env });
      
      // If we have completed data, return it
      if (existingData && existingData.status === "completed") {
        return new Response(JSON.stringify(existingData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // If there's a pending or processing record, return it
      if (existingData && (existingData.status === "pending" || existingData.status === "processing")) {
        return new Response(JSON.stringify(existingData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // No existing record, create a new pending one and return it immediately
      if (url.searchParams.get("key") === env.PAGESPEED_INSIGHTS_API) {
        console.log("creating pending report");
        const id = await makePendingRecord({
          requestUrl: requestURL,
          formFactor: "ALL",
          status: "pending",
          data: {},
          env,
        });
        
        // Get the pending record to return to user
        const pendingRecord = await getRecordById({ id, env });
        
        // Process the report in the background using waitUntil to ensure it completes
        ctx.waitUntil(
          runFullReport({ url: requestURL, env, id }).catch((error) => {
            console.error("Error processing report:", error);
          })
        );
        
        return new Response(JSON.stringify(pendingRecord), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;





 interface PageSpeedRecord {
  id: number;
  url: string;
  formFactor: string;
  date: number;
  data: any;
  status: "pending" | "processing" | "completed" | "failed";
  dataUrl: string;
}

export class PageSpeedDurableObject extends DurableObject<Env> {
  private state: DurableObjectState;
  private records: Map<number, PageSpeedRecord>;
  private nextId: number;
  private initialized: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  
    this.records = new Map();
    this.nextId = 1;
    
    // Load persisted data from storage
    this.initialized = this.loadPersistedData();
  }

  private async loadPersistedData(): Promise<void> {
    try {
      const recordsData = await this.state.storage.get<[number, PageSpeedRecord][]>("records");
      if (recordsData) {
        this.records = new Map(recordsData);
      }
      
      const nextIdData = await this.state.storage.get<number>("nextId");
      if (nextIdData) {
        this.nextId = nextIdData;
      }
    } catch (error) {
      console.error("Error loading persisted data:", error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Wait for initialization to complete
    await this.initialized;
    
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/create") {
        return this.handleCreate(request);
      } else if (path === "/update") {
        return this.handleUpdate(request);
      } else if (path === "/get") {
        return this.handleGet(request);
      } else if (path === "/getById") {
        return this.handleGetById(request);
      } else if (path === "/list") {
        return this.handleList(request);
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

  private async handleCreate(request: Request): Promise<Response> {
    const body = await request.json<{
      requestUrl: string;
      formFactor: string;
      status: "pending" | "processing" | "completed" | "failed";
      data: any;
    }>();

    const record: PageSpeedRecord = {
      id: this.nextId++,
      url: body.requestUrl,
      formFactor: body.formFactor,
      date: Date.now(),
      data: body.data,
      status: body.status,
      dataUrl: "",
    };

    this.records.set(record.id, record);
    await this.persist();

    return new Response(JSON.stringify({ id: record.id }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleUpdate(request: Request): Promise<Response> {
    const body = await request.json<{
      id: number;
      status: "pending" | "processing" | "completed" | "failed";
      data: any;
      dataUrl: string;
    }>();

    const record = this.records.get(body.id);
    if (!record) {
      return new Response(JSON.stringify({ error: "Record not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    record.status = body.status;
    record.data = body.data;
    record.dataUrl = body.dataUrl;

    this.records.set(body.id, record);
    await this.persist();

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGet(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestURL = url.searchParams.get("url");
    const time = parseInt(url.searchParams.get("time") || "0");

    if (!requestURL) {
      return new Response(JSON.stringify({ error: "url parameter required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Find the most recent record matching the URL and time criteria
    let matchingRecord: PageSpeedRecord | null = null;
    let latestDate = 0;

    for (const record of this.records.values()) {
      if (record.url === requestURL && record.date >= time) {
        if (record.date > latestDate) {
          latestDate = record.date;
          matchingRecord = record;
        }
      }
    }

    if (!matchingRecord) {
      return new Response(JSON.stringify(null), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = {
      id: matchingRecord.id,
      url: matchingRecord.url,
      status: matchingRecord.status,
      dataUrl: matchingRecord.dataUrl,
      data: matchingRecord.data,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetById(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const idParam = url.searchParams.get("id");
    
    if (!idParam) {
      return new Response(JSON.stringify({ error: "id parameter required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const id = parseInt(idParam);
    const record = this.records.get(id);

    if (!record) {
      return new Response(JSON.stringify(null), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = {
      id: record.id,
      url: record.url,
      status: record.status,
      dataUrl: record.dataUrl,
      data: record.data,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleList(request: Request): Promise<Response> {
    // Convert Map to array of records
    const allRecords = Array.from(this.records.values()).map(record => ({
      id: record.id,
      url: record.url,
      formFactor: record.formFactor,
      date: record.date,
      status: record.status,
      dataUrl: record.dataUrl,
      // Don't include full data to keep response size manageable
      hasData: !!record.data && (typeof record.data === 'object' ? Object.keys(record.data).length > 0 : true),
    }));

    // Sort by date (newest first)
    allRecords.sort((a, b) => b.date - a.date);

    return new Response(JSON.stringify({
      total: allRecords.length,
      nextId: this.nextId,
      records: allRecords,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async persist(): Promise<void> {
    // Persist records and nextId to durable storage
    await this.state.storage.put("records", Array.from(this.records.entries()));
    await this.state.storage.put("nextId", this.nextId);
  }
}
