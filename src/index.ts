type formFactor = "DESKTOP" | "MOBILE";
import { PageSpeedDurableObject } from "./PageSpeedDO";

// Export the Durable Object class for Cloudflare Workers
export { PageSpeedDurableObject };
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
  console.log("running full report for", url);
  if (!url) {
    return Response.json({ error: "url is required" });
  }
  
  let recordId = id;
  if (!recordId) {
    recordId = await makePendingRecord({
      requestUrl: url,
      formFactor: "ALL",
      status: "pending",
      data: {},
      env,
    });
  }
  
  console.log("id", recordId);

  try {
    // Update status to processing
    await updateRecordWithID({
      id: recordId,
      status: "processing",
      data: {},
      dataUrl: "",
      env,
    });

    const [mobile, desktop] = await Promise.all([
      fetchPageSpeedData(url, "MOBILE", env),
      fetchPageSpeedData(url, "DESKTOP", env),
    ]);
    const key = `results/${recordId}-${encodeURIComponent(url)}.json`;
    await env.RESULTS_BUCKET.put(key, JSON.stringify([mobile, desktop]), {
      httpMetadata: {
        contentType: "text/plain",
      },
      customMetadata: {
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await updateRecordWithID({
      id: recordId,
      status: "completed",
      data: [],
      dataUrl: `results/${recordId}-${encodeURIComponent(url)}.json`,
      env,
    });
    return true;
  } catch (e) {
    console.log(e);
    return updateRecordWithID({
      id: recordId,
      status: "failed",
      data: e instanceof Error ? { error: e.message, stack: e.stack } : { error: String(e) },
      dataUrl: "",
      env,
    });
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
  async fetch(req: Request, env: Env): Promise<Response> {
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
        
        // Process the report in the background (don't await)
        runFullReport({ url: requestURL, env, id }).catch((error) => {
          console.error("Error processing report:", error);
        });
        
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
