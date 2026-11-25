import type { FetchLike } from "../adapters/http";
import { timing } from "../adapters/http";

/** A request a fake transport saw, with its body read. */
export type SeenRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  /** The body as JSON. */
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test bodies are read loosely
  /** The body as form fields. */
  form(): URLSearchParams;
};

export type Answer = Response | Error;
export type Handler = (request: SeenRequest) => Answer | Promise<Answer>;

/** A fetch that answers from `handler` and records every request in `.requests`. */
export type MockFetch = FetchLike & { requests: SeenRequest[] };

/**
 * The stand-in for httpx.MockTransport: adapters get it as their `fetch`.
 * A handler that returns an Error makes the request fail with it (e.g. a
 * refused connection: `connectError()`).
 */
export function mockFetch(handler: Handler): MockFetch {
  const requests: SeenRequest[] = [];
  const fake = (async (request: Request) => {
    const body = request.body ? await request.text() : "";
    const seen: SeenRequest = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body,
      json: () => JSON.parse(body),
      form: () => new URLSearchParams(body),
    };
    requests.push(seen);
    const answer = await handler(seen);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as MockFetch;
  fake.requests = requests;
  return fake;
}

/** A JSON answer. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An answer without a body (or with a text body). */
export function answer(status: number, text = "", headers: Record<string, string> = {}): Response {
  return new Response(status === 204 || status === 304 ? null : text, { status, headers });
}

/** Answers in turn, one per request; an Error makes that request fail. */
export function answers(...queue: Answer[]): Handler {
  return () => {
    const next = queue.shift();
    if (!next) throw new Error("No answer left");
    return next;
  };
}

/** A refused connection, as fetch reports it. */
export function connectError(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

/** A request that timed out, as fetch reports it. */
export function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * Pauses of retried reads, recorded instead of waited for. Call in
 * `beforeEach`; it returns the list the pauses go to and restores the real
 * pause with the returned `restore`.
 */
export function recordPauses(): { pauses: number[]; restore: () => void } {
  const pauses: number[] = [];
  const original = timing.pause;
  timing.pause = async (seconds: number) => {
    pauses.push(seconds);
  };
  return { pauses, restore: () => (timing.pause = original) };
}
