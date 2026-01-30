/**
 * Stub export so deploy passes validation while delete migration runs.
 * Cloudflare validates that the script exports PageSpeedDurableObject before
 * applying migrations. This stub satisfies that check; the delete migration
 * in wrangler.toml removes all existing DO instances. After a successful
 * deploy, this file can be removed and the export dropped from index.ts.
 */
import { DurableObject } from "cloudflare:workers";

export class PageSpeedDurableObject extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env
  ) {
    super(ctx, env);
  }
}
