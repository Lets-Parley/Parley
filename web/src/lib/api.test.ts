import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, action, api, errorText } from "./api";

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
    const err = await failure(api("POST", "/api/orgs/acme/spaces/x/join"));
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

  it("keeps a transport failure a TypeError, so callers discriminating on it still work", async () => {
    fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("GET", "/api/me")).rejects.toBeInstanceOf(TypeError);
  });

  it("retags a transport failure as NetworkError", async () => {
    fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("GET", "/api/me")).rejects.toBeInstanceOf(NetworkError);
  });

  it("is an Error, so existing catch blocks reading .message keep working", () => {
    const e = new ApiError(404, "gone");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("gone");
    expect(e.status).toBe(404);
  });
});

describe("errorText", () => {
  // Why this helper exists: fetch rejects with the browser's own TypeError when
  // the connection is dead, and every room renders .message straight to the
  // screen. That text differs per browser and tells the user nothing to do.
  it("never shows the browser's transport wording", async () => {
    for (const raw of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ]) {
      fetchMock().mockRejectedValue(new TypeError(raw));
      let thrown: unknown;
      try {
        await api("GET", "/api/me");
      } catch (e) {
        thrown = e;
      }
      const shown = errorText(thrown);
      expect(shown).not.toBe(raw);
      expect(shown).toBe("Can't reach the server — check your connection and try again.");
      vi.restoreAllMocks();
    }
  });

  it("passes the server's own message through untouched", () => {
    expect(errorText(new ApiError(403, "only the facilitator can do that"))).toBe(
      "only the facilitator can do that",
    );
  });

  // An ordinary TypeError from our own code — reading a field off a body that
  // came back without it — is a real bug. Blaming the network would hide it.
  it("does not blame the network for a plain TypeError from our own code", () => {
    const own = new TypeError("Cannot read properties of undefined (reading 'slug')");
    expect(errorText(own)).toBe(own.message);
  });

  it("falls back to actionable text for a non-Error throw", () => {
    expect(errorText("boom")).toBe("Something went wrong. Try again.");
    expect(errorText(undefined)).toBe("Something went wrong. Try again.");
    expect(errorText(new Error(""))).toBe("Something went wrong. Try again.");
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
      ["config", "PATCH"],
      ["standup", "PUT"],
      ["ready", "PUT"],
    ];
    for (const [name, method] of cases) {
      f.mockClear();
      await action("s1", name, {});
      expect(f.mock.calls[0][0]).toBe(`/api/sessions/s1/actions/${name}`);
      expect(f.mock.calls[0][1]!.method).toBe(method);
    }
  });
});
