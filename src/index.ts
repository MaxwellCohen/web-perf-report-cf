type formFactor = "DESKTOP" | "MOBILE";
import { env } from "cloudflare:workers";
function getPageSpeedDataURl(testURL: string, formFactor: formFactor) {
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

async function fetchPageSpeedData(requestUrl: string, formFactor: formFactor) {
  const url = getPageSpeedDataURl(requestUrl, formFactor);
  const r = await fetch(url);
  if (!r.ok) {
    console.log(r.status);
    return { error: await r.text() };
  }
  return r.json();
}

async function makePendingRecord({
  requestUrl,
  formFactor,
  status,
  data,
}: {
  requestUrl: string;
  formFactor: string;
  status: "pending" | "processing" | "completed" | "failed";
  data: any;
}) {
  const stmt = env.DB.prepare(
    "INSERT INTO PageSpeedInsightsTable (url, formFactor, date, data, status) VALUES (?, ?, ?, ?, ?)"
  );
  const result = await stmt
    .bind(requestUrl, formFactor, Date.now(), JSON.stringify(data), status)
    .run();
  return result.meta.last_row_id;
}

async function updateRecordWithID({
  id,
  status,
  data,

  dataUrl,
}: {
  id: number;
  requestUrl: string;
  formFactor: string;
  status: "pending" | "processing" | "completed" | "failed";
  data: any;
  dataUrl: string;
}) {
  console.log("updating", id, status, data);
  const stmt = env.DB.prepare(
    "UPDATE PageSpeedInsightsTable SET data = ?, status = ?, dataUrl = ? WHERE id = ?"
  );
  const result = await stmt
    .bind(JSON.stringify(data), status, dataUrl, id)
    .run();
  return result.meta.last_row_id;
}

async function runFullReport({ url }: { url: string }) {
  console.log("running full report for", url);
  if (!url) {
    return Response.json({ error: "url is required" });
  }
  const id = await makePendingRecord({
    requestUrl: url,
    formFactor: "ALL",
    status: "pending",
    data: {},
  });
  console.log("id", id);

  try {
    const [mobile, desktop] = await Promise.all([
      fetchPageSpeedData(url, "MOBILE"),
      fetchPageSpeedData(url, "DESKTOP"),
    ]);
    const key = `results/${id}-${encodeURIComponent(url)}.json`;
    await env.RESULTS_BUCKET.put(key, JSON.stringify([mobile, desktop]), {
      httpMetadata: {
        contentType: "text/plain",
      },
      customMetadata: {
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await updateRecordWithID({
      id,
      requestUrl: url,
      formFactor: "ALL",
      status: "completed",
      data: [],
      dataUrl: `results/${id}-${encodeURIComponent(url)}.json`,
    });
    return true;
  } catch (e) {
    console.log(e);
    return updateRecordWithID({
      id,
      requestUrl: url,
      formFactor: "ALL",
      status: "failed",
      data: e,
      dataUrl: "",
    });
  }
}
async function getExistingData({
  requestURL,
  time,
}: {
  requestURL: string;
  time: number;
}) {
  const existingData = await env.DB.prepare(
    "SELECT url, status, dataUrl  FROM PageSpeedInsightsTable WHERE url = ? AND date >= ?"
  )
    .bind(requestURL, time)
    .first();

  if (typeof existingData?.dataUrl === "string" && existingData?.dataUrl) {
    const data = await env.RESULTS_BUCKET.get(existingData.dataUrl);
    if (data) {
      existingData.data = await data.text();
    }
  }
  return existingData;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      const requestURL = url.searchParams.get("url");
      if (!requestURL) {
        return new Response("Missing url", { status: 400 });
      }
      const time = new Date(Date.now() - 60 * 60 * 1000).getTime();
      // check database for existing date for for items in the last 16 min
      const existingData = await getExistingData({ requestURL, time });
      if (existingData) {
        return new Response(JSON.stringify(existingData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.searchParams.get("key") === env.PAGESPEED_INSIGHTS_API) {
        console.log("running full report");
        await runFullReport({ url: requestURL });
        const completedData = await getExistingData({ requestURL, time });
        console.log("done running the full report!");
        return new Response(JSON.stringify(completedData), {
          status: completedData ? 200 : 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
