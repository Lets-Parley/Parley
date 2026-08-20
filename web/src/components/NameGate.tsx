import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, type Me } from "../lib/api";
import { Modal, buttonPrimary, inputClass } from "./Modal";

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

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<Me>("GET", "/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
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
export function NameGate({ onDone }: { onDone: (me: Me) => void }) {
  const qc = useQueryClient();
  const mode = useAuthMode();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  if (mode.data?.mode === "oidc") return <SigninGate />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const me = await api<Me>("POST", "/api/me", { name });
      qc.setQueryData(["me"], me);
      onDone(me);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Modal title="What should we call you?">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={64}
          autoFocus
        />
        {error && <p className="text-sm font-bold text-stop">{error}</p>}
        <button type="submit" className={buttonPrimary} disabled={!name.trim()}>
          Take a seat
        </button>
      </form>
    </Modal>
  );
}

// A full page navigation, not fetch: the identity provider needs to own the
// browser for a moment, and it may want to show its own login screen.
function SigninGate() {
  const next = window.location.pathname + window.location.search;
  return (
    <Modal title="Sign in to take a seat">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft text-pretty">
          This Parley signs you in through your organisation. You'll come
          straight back here.
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
