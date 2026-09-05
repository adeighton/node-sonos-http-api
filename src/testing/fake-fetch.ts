export interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

export interface FakeFetchReply {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded with an `application/json` content type. */
  body?: string | Record<string, unknown> | unknown[];
}

export type FakeFetchRoute =
  | FakeFetchReply
  | ((url: string, init: RequestInit | undefined) => FakeFetchReply | Promise<FakeFetchReply>);

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
}

function toResponse(reply: FakeFetchReply): Response {
  const headers = new Headers(reply.headers);
  let body: string | null = null;
  if (typeof reply.body === 'string') {
    body = reply.body;
  } else if (reply.body !== undefined) {
    body = JSON.stringify(reply.body);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  return new Response(body, { status: reply.status ?? 200, headers });
}

/**
 * A `fetch` stand-in for tests. Routes are keyed by exact URL, or by a prefix ending in `*`.
 * Requests that match no route reject, so a test can never silently hit the network.
 */
export function fakeFetch(routes: Record<string, FakeFetchRoute>): FakeFetch {
  const calls: FakeFetchCall[] = [];

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });

    const route =
      routes[url] ??
      Object.entries(routes).find(
        ([pattern]) => pattern.endsWith('*') && url.startsWith(pattern.slice(0, -1)),
      )?.[1];

    if (route === undefined) {
      throw new Error(`fakeFetch: no route for ${url}`);
    }

    const reply = typeof route === 'function' ? await route(url, init) : route;
    return toResponse(reply);
  };

  return { fetch: fetchImpl, calls };
}
