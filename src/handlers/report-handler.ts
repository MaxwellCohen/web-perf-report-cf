/**
 * Handler for report-related routes
 */

import { CACHE_DURATION_MS, } from "../constants";
import { getRecordByUrl, createPendingRecord, getRecordById, getRecordByPublicId } from "../services/storage";
import { runFullReport } from "../services/report";
import { handleStuckRequests } from "./stuck-requests-handler";

/**
 * Handles the root route for creating and retrieving reports
 */
export async function handleReportRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const requestUrl = url.searchParams.get("url");

  if (!requestUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // Check for existing data within the cache duration
  const timeThreshold = Date.now() - CACHE_DURATION_MS;
  const existingRecord = await getRecordByUrl(requestUrl, timeThreshold, env);

  // Return existing completed record if available
  if (existingRecord?.status === "completed") {
    return new Response(JSON.stringify(existingRecord), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Return existing pending or processing record
  if (
    existingRecord &&
    (existingRecord.status === "pending" || existingRecord.status === "processing")
  ) {

    // Check for stuck requests in the background (non-blocking)
    ctx.waitUntil(
      handleStuckRequests(env, ctx).catch((error) => {
        console.error("Error checking for stuck requests:", error);
      })
    );

    return new Response(JSON.stringify(existingRecord), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify API key for creating new reports
  const apiKey = url.searchParams.get("key");
  if (apiKey !== env.PAGESPEED_INSIGHTS_API) {
    return new Response("Unauthorized", { status: 401 });
  }



  // Create new pending record
  console.log("Creating new pending report for", requestUrl);
  const { id: recordId, publicId } = await createPendingRecord(
    {
      requestUrl,
      formFactor: "ALL",
      status: "pending",
      data: {},
    },
    env
  );

  // Get the pending record to return to user
  const pendingRecord = await getRecordById(recordId, env);

  // Process the report in the background
  ctx.waitUntil(
    runFullReport(requestUrl, env, recordId).catch((error) => {
      console.error("Error processing report in background:", error);
    })
  );

  return new Response(JSON.stringify(pendingRecord), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handles requests to get report data by publicId
 */
export async function handleGetByPublicId(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const publicId = url.searchParams.get("id");

  if (!publicId) {
    return new Response(JSON.stringify({ error: "Missing publicId parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const record = await getRecordByPublicId(publicId, env);

  if (!record) {
    return new Response(JSON.stringify({ error: "Record not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(record), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
