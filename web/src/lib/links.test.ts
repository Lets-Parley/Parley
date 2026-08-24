import { beforeEach, describe, expect, it } from "vitest";
import { forgetLinkGuest, linkGuestFor, rememberLinkGuest } from "./links";

const guest = {
  sessionId: "sess-1",
  me: { id: "guest-1", name: "Priya", avatarHue: 200 },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("the cached link identity", () => {
  // The guest's credential is now a session cookie, so it dies with the tab.
  // The cache next to it must die with the tab too: left in local storage it
  // would outlive the cookie by up to a day, and the next person on a borrowed
  // machine would open the room painted as the guest who left.
  it("lives in session storage, never local storage", () => {
    rememberLinkGuest(guest);

    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
    expect(linkGuestFor("sess-1")?.me.name).toBe("Priya");
  });

  // A refresh keeps both halves: session storage and a session cookie both
  // survive every navigation inside the browsing session.
  it("survives a reload, and is bound to its own room", () => {
    rememberLinkGuest(guest);

    expect(linkGuestFor("sess-1")?.me.id).toBe("guest-1");
    expect(linkGuestFor("sess-2")).toBeNull();
  });

  it("is dropped when the guest leaves", () => {
    rememberLinkGuest(guest);
    forgetLinkGuest();

    expect(linkGuestFor("sess-1")).toBeNull();
  });

  // A stale cache from a previous, longer-lived redemption must not paint a
  // room the cookie no longer answers for.
  it("ignores an expired identity", () => {
    rememberLinkGuest({ ...guest, expiresAt: "2000-01-01T00:00:00.000Z" });

    expect(linkGuestFor("sess-1")).toBeNull();
  });
});
