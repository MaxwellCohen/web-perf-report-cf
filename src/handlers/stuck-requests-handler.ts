/**
 * Handler for checking and rerunning stuck requests
 */

import { getStuckProcessingRecords } from "../services/storage";
import { runFullReport } from "../services/report";
import { updateRecord } from "../services/storage";

const STUCK_PROCESSING_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Checks for stuck requests and reruns them
 */
export async function handleStuckRequests(env: Env, ctx: ExecutionContext): Promise<void> {
  // console.log("Checking for stuck requests...");

  try {
    // Get records stuck in processing for more than 3 minutes
    const stuckRecords = await getStuckProcessingRecords(STUCK_PROCESSING_THRESHOLD_MS, env);

    if (stuckRecords.length === 0) {
      // console.log("No stuck requests found");
      return;
    }

    console.log(`Found ${stuckRecords.length} stuck request(s), rerunning...`);

    // Rerun each stuck request
    for (const record of stuckRecords) {
      try {
        console.log(`Rerunning stuck request: id=${record.id}, url=${record.url}`);

        // Reset status to pending, preserve data field, and clear processingStartedAt
        await updateRecord(
          {
            id: record.id,
            status: "pending",
            data: record.data || {},
            dataUrl: "",
            processingStartedAt: null,
          },
          env
        );

        // Rerun the report in the background
        ctx.waitUntil(
          runFullReport(record.url, env, record.id).catch((error) => {
            console.error(`Error rerunning stuck request ${record.id}:`, error);
          })
        );
      } catch (error) {
        console.error(`Error processing stuck request ${record.id}:`, error);
      }
    }

    console.log(`Successfully queued ${stuckRecords.length} stuck request(s) for rerun`);
  } catch (error) {
    console.error("Error checking for stuck requests:", error);
  }
}
