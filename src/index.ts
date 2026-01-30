/**
 * Main entry point for the Cloudflare Worker
 * Routes requests to appropriate handlers
 */

import { handleReportRequest, handleGetByPublicId } from "./handlers/report-handler";
import { handleDebugList } from "./handlers/debug-handler";
import { handleDeleteOldRecords } from "./handlers/delete-handler";
import { handleStuckRequests } from "./handlers/stuck-requests-handler";
import { WORKER_ROUTES } from "./constants";

// Re-export types for external use
export type { PageSpeedRecord } from "./types";

// Stub so deploy passes while delete migration runs (can remove after deploy succeeds)
export { PageSpeedDurableObject } from "./durable-object-stub";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Route to appropriate handler
    if (url.pathname === WORKER_ROUTES.DEBUG_LIST) {
      return handleDebugList(env);
    }

    if (url.pathname === WORKER_ROUTES.DELETE_OLD) {
      return handleDeleteOldRecords(request, env);
    }

    if (url.pathname === WORKER_ROUTES.ROOT) {
      return handleReportRequest(request, env, ctx);
    }

    if (url.pathname === WORKER_ROUTES.GET_BY_PUBLIC_ID) {
      return handleGetByPublicId(request, env);
    }

    // 404 for unknown routes
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
