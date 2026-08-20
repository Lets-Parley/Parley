import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Membership, type SpaceView } from "../lib/api";
import { useMe, useAuthMode, NameGate } from "../components/NameGate";
import { Logo } from "../components/AppShell";
import { buttonPrimary, inputClass } from "../components/Modal";

// Deliberately sessionStorage, not localStorage: an abandoned space name should
// die with the tab rather than greet someone next week. The stamp narrows it
// further, to roughly one sign-in round trip, so a name abandoned at the login
// screen cannot resurface as a space hours later.
const pendingSpaceKey = "parley:pending-space";
const pendingMaxAgeMs = 15 * 60 * 1000;

function readPending(): string | null {
  const raw = sessionStorage.getItem(pendingSpaceKey);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { name, at } = parsed as { name?: unknown; at?: unknown };
    if (typeof name !== "string" || typeof at !== "number") return null;
    if (!Number.isFinite(at) || Date.now() - at > pendingMaxAgeMs) return null;
    return name;
  } catch {
    return null;
  }
}

// Read once and drop it, before anything is sent: a pending name gets exactly
// one attempt, so a failure surfaces as an error to retry by hand rather than
// as a create that fires again on the next mount.
function takePending(): string | null {
  const name = readPending();
  sessionStorage.removeItem(pendingSpaceKey);
  return name;
}

export function Landing() {
  const navigate = useNavigate();
  const me = useMe();
  const mode = useAuthMode();
  // Signing in leaves the page entirely, so the half-finished thought has to
  // outlive the round trip or the name typed here is gone on the way back.
  const [name, setName] = useState(() => readPending() ?? "");
  const [needName, setNeedName] = useState(false);
  // Only ever asked for once there is someone to ask about: a signed-out
  // visitor has no memberships and the route would only answer 401.
  const mine = useQuery({
    queryKey: ["my-spaces"],
    queryFn: () => api<Membership[]>("GET", "/api/spaces"),
    enabled: !!me.data,
    retry: false,
  });
  const spaces = mine.data ?? [];
  const qc = useQueryClient();
  const [error, setError] = useState("");

  // Both the resume effect and the gate can finish the same pending name, and
  // either can win the race. One shared latch makes the loser a no-op, so a
  // name buys exactly one space.
  //
  // The latch is deliberately one-way: only a failure releases it. A success
  // navigates away, and a create that has already succeeded must not be able to
  // fire again from a path that wakes up late — so a mounted Landing grants one
  // space and one only, and a retry is available exactly when there is
  // something to retry. Both halves of that contract are pinned by tests.
  const creating = useRef(false);
  const doCreate = useCallback(
    async (spaceName: string) => {
      if (creating.current) return;
      creating.current = true;
      let sp: SpaceView;
      try {
        sp = await api<SpaceView>("POST", "/api/spaces", { name: spaceName });
      } catch (e) {
        creating.current = false;
        setError(e instanceof Error ? e.message : "Could not create the space.");
        return;
      }
      // Past this line the space exists on the server. Anything that goes
      // wrong from here is a problem with showing it, not with making it, so
      // the latch stays shut: a second press must never buy a second space.
      try {
        navigate(`/s/${sp.slug}`);
      } catch (e) {
        // The space is real but we could not go there. Refresh the list so it
        // shows up as a link rather than leaving the visitor on a dead page
        // with an error and an inert button.
        qc.invalidateQueries({ queryKey: ["my-spaces"] });
        setError(e instanceof Error ? e.message : "Could not open the new space.");
      }
    },
    [navigate, qc],
  );

  // Signing in is a full page navigation, so the submit that triggered it never
  // ran. Coming back with a name still pending finishes that create instead of
  // asking for the same click a second time.
  useEffect(() => {
    if (!me.data) return;
    const pending = takePending();
    if (pending === null) return;
    doCreate(pending);
  }, [me.data, doCreate]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!me.data) {
      sessionStorage.setItem(pendingSpaceKey, JSON.stringify({ name, at: Date.now() }));
      setNeedName(true);
      return;
    }
    doCreate(name);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-7 p-6 text-center">
      <div className="flex items-center gap-3">
        <Logo size={26} />
        <h1 className="text-4xl font-extrabold tracking-tight">Parley</h1>
      </div>
      <p className="max-w-md text-ink-soft text-pretty">
        Planning poker and daily standups for your team, at your table.
        {mode.data?.mode === "oidc"
          ? " Sign in with your usual account."
          : " Self-hosted, no accounts, no fuss."}
      </p>
      {spaces.length > 0 && (
        <ul
          aria-label="Your spaces"
          className="flex w-full max-w-md flex-col gap-2 rounded-panel border border-line bg-surface p-3 text-left shadow-rest"
        >
          {spaces.map((sp) => (
            <li key={sp.slug}>
              <Link
                to={`/s/${sp.slug}`}
                className="block rounded-panel px-3 py-2 font-bold hover:bg-felt"
              >
                {sp.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-panel border border-line bg-surface p-5 shadow-rest sm:flex-row"
      >
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your space, e.g. Platform Team"
          maxLength={64}
        />
        <button type="submit" className={buttonPrimary + " shrink-0"} disabled={!name.trim()}>
          {spaces.length > 0 ? "Create a space" : "Open a space"}
        </button>
      </form>
      {error && <p className="font-bold text-stop">{error}</p>}
      <p className="text-sm text-ink-faint">
        Got a link from a teammate? That link is your invite — just open it.
      </p>
      {needName && (
        <NameGate
          onDone={() => {
            setNeedName(false);
            doCreate(takePending() ?? name);
          }}
        />
      )}
    </main>
  );
}
