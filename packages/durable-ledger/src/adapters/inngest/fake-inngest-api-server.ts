import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Test support only — deliberately NOT exported from `src/index.ts`. A real
 * `node:http` fake of the two Inngest REST endpoints `InngestWorkflowRuns`
 * calls (`GET /v1/events/:eventId/runs`, `GET /v1/runs/:runId`), same style
 * as `../http/fake-pay-core-server.ts` (see ADR-0006 for why tests exercise
 * a real socket + real `fetch`/JSON parsing rather than a mocked client).
 * Every route defaults to a plain 404 — this fake has no built-in "Inngest
 * business logic" the way `fake-pay-core-server.ts` simulates payment
 * lifecycle, since every test scenario here (HTTP-200-with-error-envelope,
 * the two-hop precedence, timeouts, …) needs full control of the exact
 * envelope shape returned — `overrides` is expected to be supplied per test.
 */

export interface FakeInngestRequestContext {
  readonly method: string;
  readonly path: string;
  /** First-seen casing per header name, as received on the wire. */
  readonly headers: Record<string, string>;
  readonly eventId: string | undefined;
  readonly runId: string | undefined;
}

export type RouteHandler = (
  ctx: FakeInngestRequestContext,
  res: ServerResponse,
) => void | Promise<void>;

export interface RouteHandlers {
  listRunsForEvent: RouteHandler;
  getRun: RouteHandler;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
}

export interface FakeInngestApiServer {
  readonly baseUrl: string;
  close(): Promise<void>;
  readonly requests: RecordedRequest[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildHeaderRecord(rawHeaders: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && !(name in record)) {
      record[name] = value;
    }
  }
  return record;
}

function decodeSegment(segment: string | undefined): string | undefined {
  return segment === undefined ? undefined : decodeURIComponent(segment);
}

const defaultListRunsForEvent: RouteHandler = (_ctx, res) => {
  sendJson(res, 404, { data: null, error: "event not found", status: 404 });
};

const defaultGetRun: RouteHandler = (_ctx, res) => {
  sendJson(res, 404, { data: null, error: "run not found", status: 404 });
};

/**
 * Starts a real `node:http` server on an OS-assigned port (`0`) so tests can
 * run in parallel without port collisions.
 */
export function startFakeInngestApi(
  overrides?: Partial<RouteHandlers>,
): Promise<FakeInngestApiServer> {
  const handlers: RouteHandlers = {
    listRunsForEvent: overrides?.listRunsForEvent ?? defaultListRunsForEvent,
    getRun: overrides?.getRun ?? defaultGetRun,
  };
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res) => {
    void (async () => {
      const [rawPath = "/"] = (req.url ?? "/").split("?");
      const headers = buildHeaderRecord(req.rawHeaders);
      const method = req.method ?? "GET";

      requests.push({ method, path: rawPath, headers });

      const runsForEventMatch = /^\/v1\/events\/([^/]+)\/runs$/.exec(rawPath);
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(rawPath);

      try {
        if (method === "GET" && runsForEventMatch) {
          await handlers.listRunsForEvent(
            {
              method,
              path: rawPath,
              headers,
              eventId: decodeSegment(runsForEventMatch[1]),
              runId: undefined,
            },
            res,
          );
          return;
        }
        if (method === "GET" && runMatch) {
          await handlers.getRun(
            {
              method,
              path: rawPath,
              headers,
              eventId: undefined,
              runId: decodeSegment(runMatch[1]),
            },
            res,
          );
          return;
        }
        sendJson(res, 404, {
          data: null,
          error: "not found",
          status: 404,
        });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            data: null,
            error: String(err),
            status: 500,
          });
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(
          new Error("startFakeInngestApi: server did not bind to a TCP port"),
        );
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((closeErr) => {
              if (closeErr) {
                rejectClose(closeErr);
              } else {
                resolveClose();
              }
            });
          }),
      });
    });
  });
}
