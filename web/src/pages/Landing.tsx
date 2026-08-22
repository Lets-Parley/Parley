import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Membership, type SpaceView } from "../lib/api";
import { useMe, useAuthMode, NameGate } from "../components/NameGate";
import { Logo, ThemeToggle } from "../components/AppShell";
import { buttonPrimary, buttonQuiet, inputClass, labelClass } from "../components/Modal";

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
  // The create is a round trip to somebody's own server, which may be a
  // Raspberry Pi. A control that stays live and silent through it reads as
  // broken even though the latch below makes a second press harmless.
  const [busy, setBusy] = useState(false);
  // Only a create that never reached the server is worth pressing again. Once
  // the space exists, the latch below is shut for good and a retry button would
  // be an inert control sitting next to an error — the list link is the way on.
  const [canRetry, setCanRetry] = useState(false);
  const fieldId = useId();
  const errorId = useId();

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
      setBusy(true);
      setError("");
      setCanRetry(false);
      let sp: SpaceView;
      try {
        sp = await api<SpaceView>("POST", "/api/spaces", { name: spaceName });
      } catch (e) {
        creating.current = false;
        setBusy(false);
        setCanRetry(true);
        setError(errorText(e));
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
        //
        // Nothing past a successful POST is the server talking, so there is no
        // authored message to pass on — only one of our own exceptions, whose
        // text names a field rather than a problem. The reader gets the
        // sentence that is true for them; the stack goes to the console for
        // whoever runs the server.
        console.error(e);
        qc.invalidateQueries({ queryKey: ["my-spaces"] });
        setBusy(false);
        setError("The space was created, but we couldn't open it. It's in your list below.");
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
      sessionStorage.setItem(
        pendingSpaceKey,
        JSON.stringify({ name: name.trim(), at: Date.now() }),
      );
      setNeedName(true);
      return;
    }
    doCreate(name.trim());
  }

  const known = spaces.length > 0;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-7 p-6 text-center">
      {/* The page corner, not the column's — main is capped at 2xl, so an
          absolute corner would strand this in dead space on a wide screen. */}
      <div className="fixed right-4 top-4">
        <ThemeToggle />
      </div>

      {/* Three cards off the top of a deck. The hand is the product's signature
          object, and this is the one screen with the room to hold one up —
          reusing the real hand-card geometry rather than drawing new art. */}
      {!known && (
        <div aria-hidden className="flex items-end gap-1.5">
          {["3", "5", "8"].map((v, i) => (
            <span
              key={v}
              className="hand-card flex h-[90px] w-16 items-center justify-center rounded-card border border-line bg-surface font-mono text-[2.2rem] text-ink shadow-rest"
              style={{ "--rot": `${((i - 1) * 6).toFixed(0)}deg` } as CSSProperties}
            >
              {v}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Logo size={known ? 20 : 26} />
        <h1 className={(known ? "text-2xl" : "text-4xl") + " font-extrabold tracking-tight"}>
          Parley
        </h1>
      </div>

      {/* The pitch is for someone deciding. Someone with spaces already decided,
          and their list should not sit below an advertisement for it. */}
      {!known && (
        <p className="max-w-md text-ink-soft text-pretty">
          Planning poker and daily standups for your team, at your table. A space
          is a room your team keeps — name one, share the link, start a round.
          {mode.data?.mode === "oidc"
            ? " Sign in with your usual account."
            : " Self-hosted, no accounts, no fuss."}
        </p>
      )}

      {mine.isLoading && (
        <div
          aria-hidden
          className="flex w-full max-w-md flex-col gap-2 rounded-panel border border-line bg-surface p-3"
        >
          <span className="h-9 rounded-panel bg-felt-deep" />
          <span className="h-9 w-2/3 rounded-panel bg-felt-deep" />
        </div>
      )}

      {mine.isError && (
        <p className="flex items-center gap-3 text-sm text-ink-soft">
          Couldn't load your spaces.
          <button type="button" className={buttonQuiet} onClick={() => mine.refetch()}>
            Try again
          </button>
        </p>
      )}

      {known && (
        <ul
          aria-label="Your spaces"
          className="flex w-full max-w-md flex-col gap-2 rounded-panel border border-line bg-surface p-3 text-left shadow-rest"
        >
          {spaces.map((sp) => (
            <li key={sp.slug}>
              <Link
                to={`/s/${sp.slug}`}
                className="flex items-center justify-between gap-3 rounded-panel px-3 py-2 font-bold hover:bg-felt-deep"
              >
                <span className="min-w-0 truncate">{sp.name}</span>
                {sp.protected && (
                  <span className="shrink-0 font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-ink-faint">
                    Passcode
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-panel border border-line bg-surface p-5 text-left shadow-rest sm:flex-row sm:items-end"
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={fieldId} className={labelClass + " mt-0"}>
            {known ? "Another space" : "Name your space"}
          </label>
          <input
            id={fieldId}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Platform Team"
            maxLength={64}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        <button
          type="submit"
          className={buttonPrimary + " shrink-0"}
          disabled={!name.trim() || busy}
        >
          {busy ? "Opening…" : known ? "Create a space" : "Open a space"}
        </button>
      </form>

      {error && (
        <p id={errorId} role="alert" className="flex items-center gap-3 font-bold text-stop">
          {error}
          {canRetry && (
            <button
              type="button"
              className={buttonQuiet + " font-bold"}
              onClick={() => doCreate(name.trim())}
              disabled={!name.trim() || busy}
            >
              Try again
            </button>
          )}
        </p>
      )}

      <p className="max-w-md text-sm text-ink-faint text-pretty">
        Got a link from a teammate? That link is your invite — just open it. A
        passcode alone won't do it; ask them for the link.
      </p>

      {needName && (
        <NameGate
          because={name.trim() ? `Before we open ${name.trim()}:` : undefined}
          // Escape and the ✕ both land here. Without it the dialog closes, the
          // gate believes itself open, and the button that raised it goes dead.
          onCancel={() => {
            setNeedName(false);
            sessionStorage.removeItem(pendingSpaceKey);
          }}
          onDone={() => {
            setNeedName(false);
            doCreate(takePending() ?? name.trim());
          }}
        />
      )}
    </main>
  );
}
