import type { Context } from "hono";
import { HttpError } from "./error-mapper.js";

/** Reads the `Idempotency-Key` header, required on every mutating route. */
export function requireIdempotencyKey(c: Context): string {
  const key = c.req.header("Idempotency-Key");
  if (key === undefined || key.trim() === "") {
    throw new HttpError(
      400,
      "missing_idempotency_key",
      "Idempotency-Key header is required",
    );
  }
  return key;
}

/**
 * Reads and parses the request body as JSON. An empty body is not an error —
 * a capture or cancel request may legitimately send none — and parses to
 * `{}`.
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
