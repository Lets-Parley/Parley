import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, action, api } from "./api";

function reply(status: number, body?: string, ok?: boolean) {
  return {
    status,
    ok: ok ?? (status >= 200 && status < 300),
    text: async () => body ?? "",
  } as Response;
}

const fetchMock = () => vi.spyOn(globalThis, "fetch");

/** Await a call that is supposed to fail, and hand back the error it threw. */
async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected the call to fail, but it resolved");
}

afterEach(() => vi.restoreAllMocks());

describe("api", () => {
  it("parses a JSON body", async () => {
    fetchMock().mockResolvedValue(reply(200, '{"id":"u1","name":"Dana"}'));
    await expect(api("GET", "/api/me")).resolves.toEqual({ id: "u1", name: "Dana" });
  });

  it("sends no body and no content type on a bare GET", async () => {
    const f = fetchMock().mockResolvedValue(reply(200, "{}"));
    await api("GET", "/api/me");
    const init = f.mock.calls[0][1]!;
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
    expect(init.credentials).toBe("same-origin");
  });

  it("serializes a body and declares its type", async () => {
    const f = fetchMock().mockResolvedValue(reply(200, "{}"));
    await api("POST", "/api/me", { name: "Dana" });
    const init = f.mock.calls[0][1]!;
    expect(init.body).toBe('{"name":"Dana"}');
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("returns without touching the body on 204", async () => {
    const text = vi.fn();
    fetchMock().mockResolvedValue({ status: 204, ok: true, text } as unknown as Response);
    await expect(api("DELETE", "/api/me")).resolves.toBeUndefined();
    expect(text).not.toHaveBeenCalled();
  });

  it("treats an empty 200 body as no data rather than a parse failure", async () => {
    fetchMock().mockResolvedValue(reply(200, ""));
    await expect(api("POST", "/api/sessions/1/actions/reveal")).resolves.toBeUndefined();
  });

  it("raises the server's own message, carrying the status", async () => {
    fetchMock().mockResolvedValue(reply(403, '{"error":"That code didn\'t match."}'));
    const err = await failure(api("POST", "/api/spaces/x/join"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("That code didn't match.");
  });

  it("falls back to a plain message when the error body is not JSON", async () => {
    fetchMock().mockResolvedValue(reply(502, "<html>bad gateway</html>"));
    const err = await failure(api("GET", "/api/me"));
    expect(err.status).toBe(502);
    expect(err.message).toBe("Something went wrong talking to the server.");
  });

  it("falls back when the error body is JSON without an error field", async () => {
    fetchMock().mockResolvedValue(reply(500, '{"detail":"nope"}'));
    const err = await failure(api("GET", "/api/me"));
    expect(err.message).toBe("Something went wrong talking to the server.");
  });

  it("falls back on an empty error body", async () => {
    fetchMock().mockResolvedValue(reply(401, ""));
    const err = await failure(api("GET", "/api/me"));
    expect(err.status).toBe(401);
    expect(err.message).toBe("Something went wrong talking to the server.");
  });

  it("lets a transport failure through as itself", async () => {
    fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("GET", "/api/me")).rejects.toBeInstanceOf(TypeError);
  });

  it("is an Error, so existing catch blocks reading .message keep working", () => {
    const e = new ApiError(404, "gone");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("gone");
    expect(e.status).toBe(404);
  });
});

describe("action", () => {
  it("sends each action with the verb the server routes it on", async () => {
    const f = fetchMock().mockResolvedValue(reply(204, "", true));
    const cases: [string, string][] = [
      ["reveal", "POST"],
      ["stories", "POST"],
      ["select", "POST"],
      ["reset", "POST"],
      ["vote", "POST"],
      ["start", "POST"],
      ["next", "POST"],
      ["skip", "POST"],
      ["story", "PATCH"],
      ["standup", "PUT"],
    ];
    for (const [name, method] of cases) {
      f.mockClear();
      await action("s1", name, {});
      expect(f.mock.calls[0][0]).toBe(`/api/sessions/s1/actions/${name}`);
      expect(f.mock.calls[0][1]!.method).toBe(method);
    }
  });
});
