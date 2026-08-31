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
import { api, errorText, type Membership, type OrgMembership, type SpaceView } from "../lib/api";
import { orgPath, spacePath } from "../lib/paths";
import { useMe, useAuthMode, NameGate, clearSessionMemory } from "../components/NameGate";
import { isFullAccount } from "../lib/links";
import { Logo, ThemeToggle } from "../components/AppShell";
import { Avatar } from "../components/Avatar";
import { buttonPrimary, buttonQuiet, inputClass, labelClass } from "../components/Modal";
import { safeDisplayName } from "../lib/displayName";

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
  // Only ever asked for once there is a full account to ask about: a
  // signed-out visitor has no memberships and the route would only answer
  // 401, and a link guest is refused it too — that identity belongs to one
  // room, not to a list of spaces.
  const fullAccount = isFullAccount(me.data);
  const mine = useQuery({
    queryKey: ["my-spaces"],
    queryFn: () => api<Membership[]>("GET", "/api/spaces"),
    enabled: fullAccount,
    retry: false,
  });
  const spaces = mine.data ?? [];
  // The orgs the caller belongs to, asked alongside the spaces. An empty array
  // is a real answer and a different screen: someone whose identity provider
  // handed them no claim any org here registered has nowhere to put a space,
  // so offering them the create form would only produce a refusal.
  const myOrgs = useQuery({
    queryKey: ["my-orgs"],
    queryFn: () => api<OrgMembership[]>("GET", "/api/orgs"),
    enabled: fullAccount,
    retry: false,
  });
  const orgs = myOrgs.data ?? [];
  const noOrg = fullAccount && myOrgs.isSuccess && orgs.length === 0;
  // Which org the list is showing. Null is "all of them", which is what a
  // single-org instance always shows — there is nothing to switch between.
  const [orgFilter, setOrgFilter] = useState<string | null>(null);
  const qc = useQueryClient();
  const [error, setError] = useState("");
  // The create is a round trip to somebody's own server, which may be a
  // Raspberry Pi. A control that stays live and silent through it reads as
  // broken even though the latch below makes a second press harmless.
  const [busy, setBusy] = useState(false);
  // Only a create that never reached the server is worth pressing again. When
  // navigate fails after a successful create, the latch stays shut and a retry
  // button would be inert next to an error — the list link is the way on.
  const [canRetry, setCanRetry] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  // Both the resume effect and the gate can finish the same pending name, and
  // either can win the race. One shared latch makes the loser a no-op while a
  // create is in flight. The gate's onDone creates only from a pending value
  // it consumed — never from the typed name — so releasing the latch after a
  // success cannot reopen a duplicate through that path.
  //
  // Past a successful POST the space exists: if navigate then fails, the latch
  // stays shut so a second press cannot buy another. A clean success releases
  // it (and busy), which is the ordinary in-flight-guard behaviour.
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
        navigate(spacePath(sp.orgSlug ?? "", sp.slug));
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
        return;
      }
      creating.current = false;
      setBusy(false);
    },
    [navigate, qc],
  );

  // Signing in is a full page navigation, so the submit that triggered it never
  // ran. Coming back with a name still pending finishes that create instead of
  // asking for the same click a second time.
  useEffect(() => {
    if (!fullAccount) return;
    // The create lands in an org, and every call against the space afterwards
    // is org-gated — so resuming for an account in no org would silently make
    // them a space they cannot use. Wait for the org answer, then stand down
    // and leave the dead end below to explain it; the name stays in the field
    // to send once somebody has added them.
    if (myOrgs.isPending || noOrg) return;
    const pending = takePending();
    if (pending === null) return;
    doCreate(pending);
  }, [fullAccount, myOrgs.isPending, noOrg, doCreate]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!fullAccount) {
      sessionStorage.setItem(
        pendingSpaceKey,
        JSON.stringify({ name: name.trim(), at: Date.now() }),
      );
      setNeedName(true);
      return;
    }
    doCreate(name.trim());
  }

  // Grouped by org, in the switcher's order, because a slug is only unique
  // inside one org: two orgs can each have a "platform-team", and a flat list
  // would show the same name twice with nothing to tell them apart.
  const shown = orgFilter ? spaces.filter((sp) => sp.orgSlug === orgFilter) : spaces;
  // Grouped off the memberships themselves, not off the org list: the list is
  // where the display names come from, but a space already carries the org it
  // lives in, so a failed org read costs a heading its proper name rather than
  // hiding every space the caller has.
  const grouped = [...new Set(shown.map((sp) => sp.orgSlug))].map((slug) => ({
    slug,
    name: orgs.find((o) => o.slug === slug)?.name ?? slug,
    spaces: shown.filter((sp) => sp.orgSlug === slug),
  }));
  const known = spaces.length > 0;
  // Which orgs get a directory door. Straight off the org memberships, so it
  // survives an empty space list; narrowed by the switcher when one is set.
  const browsable = orgFilter ? orgs.filter((o) => o.slug === orgFilter) : orgs;
  const guestRoomId = me.data?.linkSessionId;

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

      {/* A link guest is not deciding whether to sign up — they already have a
          seat somewhere. Naming that, with the way back, beats leaving them to
          guess why the space list and the pitch below don't apply to them. */}
      {guestRoomId && (
        <p className="max-w-md text-ink-soft text-pretty">
          You're here as a guest, from a link — this page is for accounts, not
          your table.{" "}
          <Link to={`/session/${guestRoomId}`} className="font-bold underline">
            Back to your room
          </Link>
        </p>
      )}

      {/* The pitch is for someone deciding. Someone with spaces already decided,
          and their list should not sit below an advertisement for it. */}
      {!known && !guestRoomId && (
        <p className="max-w-md text-ink-soft text-pretty">
          Planning poker and daily standups for your team, at your table. A space
          is a room your team keeps — name one, share the link, start a round.
          {mode.data?.mode === "oidc"
            ? " Sign in with your usual account."
            : " Self-hosted, no accounts, no fuss."}
        </p>
      )}

      {/* Who the server thinks you are, and the way out. Without it a shared
          machine, or a second account, has no door on this page — the space
          list just silently belongs to somebody else. Signing back in as
          someone else is the Sign in link this leaves behind. */}
      {mode.data?.mode === "oidc" && fullAccount && me.data && (
        <p className="flex items-center gap-3 text-sm text-ink-soft">
          <Avatar name={me.data.name} hue={me.data.avatarHue} icon={me.data.avatarIcon} size="sm" />
          <span>
            Signed in as <span className="font-bold text-ink">{safeDisplayName(me.data.name)}</span>
          </span>
          <button
            type="button"
            className={buttonQuiet}
            onClick={async () => {
              // The cookie and its token row go; the identity provider's own
              // session is untouched, so this is "Sign out", not "everywhere".
              try {
                await api("DELETE", "/api/me");
              } finally {
                clearSessionMemory();
                window.location.href = "/";
              }
            }}
          >
            Sign out
          </button>
        </p>
      )}

      {/* Signing in is the only way to a space list, and until now the only
          door to it was the create form — so someone who already has spaces
          had to pretend to make a new one to reach their own. */}
      {mode.data?.mode === "oidc" && !fullAccount && !guestRoomId && !me.isLoading && (
        <a href="/auth/login?next=%2F" className={buttonPrimary + " text-center"}>
          Sign in
        </a>
      )}

      {/* A guest's writes are refused server-side, so the create form and the
          space list below (an account-scoped route) would both just fail for
          them. The room they already have is the "back to your room" link
          above — nothing else on this page is theirs to use. */}
      {!guestRoomId && noOrg && (
        <section
          aria-label="No org yet"
          className="w-full max-w-md rounded-card border border-line bg-surface px-5 py-4 text-left"
        >
          <h2 className="font-display text-xl">You're signed in, but not in an org yet</h2>
          <p className="mt-2 text-sm text-ink-soft text-pretty">
            Spaces live inside an org, and your account isn't in one. Ask an
            administrator to add you — they map your identity provider's groups
            onto the orgs on this instance.
          </p>
          <p className="mt-3 text-sm text-ink-soft text-pretty">
            Signed in as <span className="font-bold">{me.data?.name}</span>.
          </p>
        </section>
      )}

      {!guestRoomId && !noOrg && (
        <>
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

          {orgs.length > 1 && (
            /* Only worth showing when there is something to switch between.
               Plain buttons rather than a menu: they are in the tab order as
               they stand, and Enter or Space activates each one. */
            <nav
              aria-label="Your orgs"
              className="flex w-full max-w-md flex-wrap items-center gap-2"
            >
              <button
                type="button"
                aria-pressed={orgFilter === null}
                onClick={() => setOrgFilter(null)}
                className={orgFilter === null ? buttonPrimary : buttonQuiet}
              >
                All orgs
              </button>
              {orgs.map((o) => (
                <button
                  key={o.slug}
                  type="button"
                  aria-pressed={orgFilter === o.slug}
                  onClick={() => setOrgFilter(o.slug)}
                  className={orgFilter === o.slug ? buttonPrimary : buttonQuiet}
                >
                  {o.name}
                </button>
              ))}
            </nav>
          )}

          {known && (
            <div className="flex w-full max-w-md flex-col gap-3">
              {grouped.map((group) => (
                <section key={group.slug} className="flex flex-col gap-2">
                  {grouped.length > 1 && (
                    <h2 className="px-1 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      {group.name}
                    </h2>
                  )}
                  <ul
                    aria-label={`Your spaces in ${group.name}`}
                    className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3 text-left shadow-rest"
                  >
                    {group.spaces.map((sp) => (
                      <li key={sp.orgSlug + "/" + sp.slug}>
                        <Link
                          to={spacePath(sp.orgSlug, sp.slug)}
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
                </section>
              ))}
            </div>
          )}

          {/* The door to the directory, hung off org membership rather than
              off the space list above. Someone who has joined nothing yet has
              no rows for a link to sit in — and they are exactly who the
              directory is for, since the alternative is waiting for a
              teammate to send a URL. It follows the switcher's filter so the
              page never offers a door to an org it is not showing. */}
          {browsable.length > 0 && (
            <nav
              aria-label="Browse an org"
              className="flex w-full max-w-md flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm"
            >
              {browsable.map((o) => (
                <Link
                  key={o.slug}
                  to={orgPath(o.slug)}
                  className="text-ink-soft underline hover:text-ink"
                >
                  Browse {o.name}
                </Link>
              ))}
            </nav>
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
        </>
      )}

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
            // Create only from a pending value this handler consumed. The typed
            // name in React state is not a second source of truth: after the
            // resume effect has already taken the pending slot, falling back to
            // `name` would POST again and mint a duplicate space.
            const pending = takePending();
            if (pending === null) return;
            doCreate(pending);
          }}
        />
      )}
    </main>
  );
}
