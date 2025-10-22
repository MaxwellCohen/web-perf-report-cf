type formFactor = "DESKTOP" | "MOBILE";

function getPageSpeedDataURl(
  testURL: string,
  formFactor: formFactor,
  env: Env
) {
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

async function fetchPageSpeedData(
  requestUrl: string,
  formFactor: formFactor,
  env: Env
) {
  const url = getPageSpeedDataURl(requestUrl, formFactor, env);
  const r = await fetch(url);
  if (!r.ok) {
    console.log(r.status);
    return { error: await r.text() };
  }

  const data = await r.json();
  return data;
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
  const stmt = env.DB.prepare(
    "INSERT INTO PageSpeedInsightsTable (url, formFactor, date, data, status) VALUES (?, ?, ?, ?, ?)"
  );
  const result = await stmt
    .bind(
      requestUrl,
      formFactor,
      Date.now(),
      JSON.stringify(data),
      status
    )
    .run();
  return result.meta.last_row_id;
}

async function updateRecordWithID({
  id,
  status,
  data,
  env,
}: {
  id: number;
  requestUrl: string;
  formFactor: string;
  status: "pending" | "processing" | "completed" | "failed";
  data: any;
  env: Env;
}) {
  console.log('updating', id, status, data);
  const stmt = env.DB.prepare(
    "UPDATE PageSpeedInsightsTable SET data = ?, status = ? WHERE id = ?"
  );
  const result = await stmt.bind(JSON.stringify(data), status, id).run();
  return result.meta.last_row_id;
}

async function runFullReport({ url, env }: { url: string; env: Env }) {
  console.log('hi', url);
  if (!url) {
    return Response.json({ error: "url is required" });
  }
  console.log('hi2', url);
  const id = await makePendingRecord({
    requestUrl: url,
    formFactor: "ALL",
    status: "pending",
    data: {},
    env,
  });
  console.log('id', id);

  try {

    const [mobile, desktop] = await Promise.all([
      fetchPageSpeedData(url, "MOBILE", env),
      fetchPageSpeedData(url, "DESKTOP", env),
    ]);

    await updateRecordWithID({
      id,
      requestUrl: url,
      formFactor: "ALL",
      status: "completed",
      data: [mobile, desktop],
      env,
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
  console.log(time)
  const existingData = await env.DB.prepare(
    "SELECT url, status, data  FROM PageSpeedInsightsTable WHERE url = ? AND date >= ?"
  )
    .bind(requestURL, time)
    .first();
  return existingData;
}

export default {
  async fetch(req: Request, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      const requestURL = url.searchParams.get("url");
      if (!requestURL) {
        return new Response("Missing url", { status: 400 });
      }
      const time = new Date(Date.now() - 16 * 60 * 1000).getTime();
      // check database for existing date for for items in the last 16 min
      const existingData = await getExistingData({ requestURL, time, env });
      console.log('existingData', existingData, typeof existingData);
      if (existingData) {
        return new Response(JSON.stringify(existingData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if(url.searchParams.get("key") === env.PAGESPEED_INSIGHTS_API) {

        console.log('running full report');
        await runFullReport({ url: requestURL, env });
        const completedData = await getExistingData({ requestURL, time, env });
        
        return new Response(JSON.stringify(completedData), {
          status: completedData ? 200 : 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
