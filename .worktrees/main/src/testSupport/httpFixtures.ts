// Phase 20 test support - minimal VercelRequest/VercelResponse stand-ins
// for the handful of tests that exercise a real HTTP handler function
// end-to-end (api/webhooks/meta/handler.ts's default export) rather than
// the application-layer function underneath it. Deliberately not a full
// mock framework - just enough surface for the handlers this suite calls:
// req.method/query/headers, async-iterable body (for readRawBody's
// `for await (const chunk of req)`), and res.status/json/redirect/send/
// setHeader, each recorded into `res.calls` so a test can assert on
// exactly what the handler did.

export function fakeReq(opts: { method?: string; query?: Record<string, string>; headers?: Record<string, string>; rawBody?: string } = {}): any {
  const rawBody = opts.rawBody ?? "";
  return {
    method: opts.method ?? "GET",
    query: opts.query ?? {},
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (rawBody) yield Buffer.from(rawBody, "utf8");
    },
  };
}

export interface FakeResCall {
  status?: number;
  json?: unknown;
  redirectStatus?: number;
  redirectUrl?: string;
  sent?: string;
}

export interface FakeRes {
  calls: FakeResCall[];
  status(code: number): FakeRes;
  json(obj: unknown): FakeRes;
  redirect(status: number, url: string): FakeRes;
  send(body: string): FakeRes;
  setHeader(): FakeRes;
}

// Returned as `any` (rather than FakeRes) so it can be passed directly to a
// real Vercel handler's `(req: VercelRequest, res: VercelResponse)` — this
// object implements only the handful of response methods those handlers
// actually call, not the full ServerResponse surface.
export function fakeRes(): FakeRes & any {
  let currentStatus = 200;
  const calls: FakeResCall[] = [];
  const res: FakeRes = {
    calls,
    status(code: number) {
      currentStatus = code;
      return res;
    },
    json(obj: unknown) {
      calls.push({ status: currentStatus, json: obj });
      return res;
    },
    redirect(status: number, url: string) {
      calls.push({ redirectStatus: status, redirectUrl: url });
      return res;
    },
    send(body: string) {
      calls.push({ status: currentStatus, sent: body });
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return res;
}
