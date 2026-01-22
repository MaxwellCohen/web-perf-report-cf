import { DurableObject } from "cloudflare:workers";

export interface PageSpeedRecord {
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
