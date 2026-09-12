import type { Context } from "hono";
import { HttpError } from "./server-error-mapper.js";

/**
 * Reads and parses the request body as JSON. An empty body is not an error
 * — a route with no required body fields may legitimately receive none —
 * and parses to `{}`. Copied from pay-core's own `request.ts`
 * (`packages/pay-core/src/adapters/http/request.ts`); same contract, same
 * `HttpError` shape.
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}
