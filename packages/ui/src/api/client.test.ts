import { READ_TIMEOUT_MS, ReadTimeoutError } from "./read.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getDoc, listAllHeads, listHeadsPage, putDoc } from "./client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["headers", "body"])("bounds an unanswered document read through %s without retrying", async (phase) => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      if (phase === "headers") fetchMock.mockReturnValue(never);
      else {
        const response = jsonResponse(200, {}, { "X-Version": "sha256:abc" });
        vi.spyOn(response, "json").mockReturnValue(never);
        fetchMock.mockResolvedValue(response);
      }
      let outcome: unknown;
      void getDoc("tasks/a").catch((error) => { outcome = error; });
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(outcome).toBeInstanceOf(ReadTimeoutError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not turn an uncertain write into a read timeout or retry", async () => {
    vi.useFakeTimers();
    try {
      let reply!: (response: Response) => void;
      fetchMock.mockReturnValue(new Promise<Response>((resolve) => { reply = resolve; }));
      let settled = false;
      const writing = putDoc("tasks/a", { frontmatter: { type: "Task" }, body: "updated" }, "sha256:old").then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 2);
      expect(settled).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].signal).toBeUndefined();
      reply(jsonResponse(200, { ok: true }, { "X-Version": "sha256:new" }));
      await writing;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("listHeadsPage hits the bundle-scoped route with fields=frontmatter and the given type filter", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { count: 0, docs: [], next_cursor: null }));
    await listHeadsPage({ type: "Task" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v0/bundles/default/docs?fields=frontmatter&limit=50&malformed=skip&type=Task");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBeUndefined(); // GET — no CSRF header required
  });

  it("listHeadsPage supports a prefix filter instead of (or alongside) type — e.g. a page's conventions/ scan", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { count: 0, docs: [], next_cursor: null }));
    await listHeadsPage({ prefix: "conventions/", type: "Convention" });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/v0/bundles/default/docs?fields=frontmatter&limit=50&malformed=skip&type=Convention&prefix=conventions%2F");
  });

  it("listHeadsPage forwards a cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { count: 0, docs: [], next_cursor: null }));
    await listHeadsPage({ type: "Task" }, "tasks/z");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("cursor=tasks%2Fz");
  });

  it("listAllHeads follows next_cursor to exhaustion", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          count: 2,
          docs: [{ id: "tasks/a", version: "v1", frontmatter: { type: "Task", title: "A", status: "todo" } }],
          next_cursor: "tasks/a",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          count: 2,
          docs: [{ id: "tasks/b", version: "v2", frontmatter: { type: "Task", title: "B", status: "done" } }],
          next_cursor: null,
        }),
      );

    const all = await listAllHeads({ type: "Task" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(all.map((d) => d.id)).toEqual(["tasks/a", "tasks/b"]);
    const secondUrl = (fetchMock.mock.calls[1] as [string])[0];
    expect(secondUrl).toContain("cursor=tasks%2Fa");
  });

  it("getDoc reads the version off X-Version", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: "tasks/a", frontmatter: { type: "Task", title: "A" }, body: "x" }, { "X-Version": "sha256:abc" }),
    );
    const { doc, version } = await getDoc("tasks/a");
    expect(doc.id).toBe("tasks/a");
    expect(version).toBe("sha256:abc");
  });

  it("getDoc falls back to a quoted ETag when X-Version is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: "tasks/a", frontmatter: { type: "Task" }, body: "" }, { ETag: '"sha256:abc"' }),
    );
    const { version } = await getDoc("tasks/a");
    expect(version).toBe("sha256:abc");
  });

  it("getDoc throws when neither version header is present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "tasks/a", frontmatter: { type: "Task" }, body: "" }));
    await expect(getDoc("tasks/a")).rejects.toThrow(ApiError);
  });

  it("getDoc percent-encodes each id segment independently", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: "tasks/a b", frontmatter: { type: "Task" }, body: "" }, { "X-Version": "v1" }),
    );
    await getDoc("tasks/a b");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/v0/bundles/default/docs/tasks/a%20b");
  });

  it("putDoc sends If-Match, X-Requested-With, and a JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: "v2" }, { "X-Version": "v2" }));
    await putDoc("tasks/a", { frontmatter: { type: "Task", status: "done" }, body: "x" }, "v1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v0/bundles/default/docs/tasks/a");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["If-Match"]).toBe("v1");
    expect(headers["X-Requested-With"]).toBeTruthy();
    expect(JSON.parse(init.body as string)).toEqual({ frontmatter: { type: "Task", status: "done" }, body: "x" });
  });

  it("a non-2xx response throws an ApiError carrying the wire envelope's code/message/details", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(412, { error: { code: "VERSION_CONFLICT", message: "stale head", details: { expected: "v1", actual: "v2" } } }),
    );
    await expect(putDoc("tasks/a", { frontmatter: { type: "Task" }, body: "" }, "v1")).rejects.toMatchObject({
      status: 412,
      code: "VERSION_CONFLICT",
      details: { expected: "v1", actual: "v2" },
    });
  });

  it("a non-2xx response with an unparseable body still throws a usable ApiError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 500 }));
    await expect(listHeadsPage({ type: "Task" })).rejects.toMatchObject({ status: 500, code: "RUNTIME" });
  });
});
