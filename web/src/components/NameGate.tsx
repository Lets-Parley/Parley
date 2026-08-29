import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, type Me } from "../lib/api";
import {
  clearSessionMemory,
  noteSessionEnded,
  openSessionLapsed,
  rememberOpenSession,
} from "../lib/sessionMemory";
import { Modal, buttonPrimary, inputClass, labelClass } from "./Modal";

/**
 * Which sign-in flow this server uses. Asked once and cached: it is fixed at
 * boot, so re-fetching it would only add a round trip to every gate.
 */
export function useAuthMode() {
  return useQuery({
    queryKey: ["auth-mode"],
    queryFn: () => api<{ mode: "open" | "oidc" }>("GET", "/api/auth"),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Who the server says you are, or null when nobody. `enabled` is how a caller
 * that already holds a link-bound identity keeps this from asking a route it
 * knows it is refused.
 */
export function useMe(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const me = await api<Me>("GET", "/api/me");
        // Link guests are a one-room capability, not an open-mode seat to
        // recover into — remembering them would show the expired-session
        // gate after Leave room or link expiry.
        if (!me.linkSessionId) rememberOpenSession(me.name);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          if (e.message === "session ended") noteSessionEnded();
          return null;
        }
        throw e;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

// Asks for a display name the first time one is needed, then gets out of the
// way. On a server with an identity provider there is nothing to ask: the same
// gate sends people to sign in instead, so callers need no mode of their own.
//
// When this browser already held an open-mode seat and the cookie no longer
// resolves, the copy changes: continuing mints a *new* anonymous identity,
// and the previous memberships stay with the orphaned one. Pretending that is
// a first visit is how someone ends up a stranger at their own space.
export function NameGate({
  onDone,
  onCancel,
  because,
}: {
  onDone: (me: Me) => void;
  // Without a way out, Escape closes the dialog and leaves the caller believing
  // the gate is still up: the button that opened it goes dead and only a reload
  // recovers. A caller that can be returned to passes this, and Escape and the
  // ✕ then mean the same thing.
  onCancel?: () => void;
  // What the visitor was in the middle of. The gate interrupts something, and
  // saying what makes it read as a step rather than an ambush.
  because?: string;
}) {
  const qc = useQueryClient();
  const mode = useAuthMode();
  const { lapsed, lastName } = openSessionLapsed();
  const [name, setName] = useState(lapsed ? lastName : "");
  const [error, setError] = useState("");
  const fieldId = useId();
  const errorId = useId();

  if (mode.data?.mode === "oidc") return <SigninGate onCancel={onCancel} because={because} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const me = await api<Me>("POST", "/api/me", { name });
      rememberOpenSession(me.name);
      qc.setQueryData(["me"], me);
      onDone(me);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const title = lapsed ? "Your session ended" : "What should we call you?";
  const submitLabel = lapsed ? "Take a seat as a new guest" : "Take a seat";

  return (
    <Modal title={title} onClose={onCancel}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft text-pretty">
          {lapsed ? (
            <>
              {because ? `${because} ` : ""}
              This browser no longer has your seat — the cookie expired or was
              cleared. Taking a seat again makes a{" "}
              <strong className="font-bold text-ink">new guest</strong> identity
              on this device. Your previous name and memberships stay with the
              old one; there is no way back from here.
            </>
          ) : (
            <>
              {because ? `${because} ` : ""}It is the name your team sees at the
              table. Nothing leaves this server — no account, no email, just a
              cookie in this browser.
            </>
          )}
        </p>
        <div>
          <label htmlFor={fieldId} className={labelClass + " mt-0"}>
            Your name
          </label>
          <input
            id={fieldId}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={64}
            aria-describedby={error ? errorId : undefined}
            autoFocus
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-sm font-bold text-stop">
            {error}
          </p>
        )}
        <button type="submit" className={buttonPrimary} disabled={!name.trim()}>
          {submitLabel}
        </button>
      </form>
    </Modal>
  );
}

// A full page navigation, not fetch: the identity provider needs to own the
// browser for a moment, and it may want to show its own login screen.
function SigninGate({ onCancel, because }: { onCancel?: () => void; because?: string }) {
  const next = window.location.pathname + window.location.search;
  return (
    <Modal title="Sign in to take a seat" onClose={onCancel}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft text-pretty">
          {because ? `${because} ` : ""}This Parley signs you in through your
          organisation. You'll come straight back here, and what you have typed
          is held while you go.
        </p>
        <a
          href={`/auth/login?next=${encodeURIComponent(next)}`}
          className={buttonPrimary + " text-center"}
        >
          Continue to sign in
        </a>
      </div>
    </Modal>
  );
}

/** Drop the remembered seat. Call on intentional sign-out so the next visit
 *  is a first visit, not an "expired session" warning. */
export { clearSessionMemory };
