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
import {
  api,
  errorText,
  type Membership,
  type OrgMembership,
  type Person,
  type SessionSummary,
  type SpaceView,
} from "../lib/api";
import { orgPath, pluginsPath, spaceApi, spacePath } from "../lib/paths";
import { kindLabel } from "../lib/kinds";
import { useMe, useAuthMode, NameGate, clearSessionMemory } from "../components/NameGate";
import { isFullAccount } from "../lib/links";
import { Logo, ThemeToggle } from "../components/AppShell";
import { PluginChrome } from "../components/PluginChrome";
import { Avatar } from "../components/Avatar";
import { KindChip } from "../components/KindChip";
import { buttonPrimary, buttonQuiet, inputClass, labelText } from "../components/Modal";
import { safeDisplayName } from "../lib/displayName";
import {
  CARD_DEAL_MS,
  CARD_HOP_MS,
  DEAL_STAGGER_MS,
  flipStartsAt,
  resultStampsAt,
} from "../lib/motion";

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

/**
 * One round of planning poker, resolving. Runs once on load and then rests.
 *
 * The hero used to be three cards held still — the product's signature object,
 * doing nothing, with a hover lift inherited from `.hand-card` that promised an
 * interaction these decorative spans never had. This is the same object doing
 * the thing the page is asking a stranger to believe in: five cards are dealt
 * face-down, they turn over, the majority stack settles, and the number the
 * room agreed on stamps in.
 *
 * Every keyframe, easing and duration here already existed for the real table —
 * deal-in, flip-in, stamp-in, the beat sheet in lib/motion/plan.ts — so the
 * moment is the product performing itself rather than bespoke landing-page art.
 * prefers-reduced-motion kills all of it globally in tokens.css and leaves the
 * settled end state, which is the correct still frame.
 */
const HERO_HAND = ["3", "5", "5", "8", "5"];
const HERO_RESULT = "5";

function DealAndReveal() {
  // The deal is over before the flip starts; the number lands after the last
  // card is face-up. Read from the same beat sheet the real table uses — these
  // were hardcoded literals, which reintroduced exactly the four-clocks drift
  // the beat sheet exists to prevent.
  const dealt = HERO_HAND.length * DEAL_STAGGER_MS;
  const flipBase = dealt + CARD_HOP_MS;

  return (
    <div aria-hidden className="flex flex-col items-center gap-5">
      <div className="flex items-end gap-1.5">
        {HERO_HAND.map((v, i) => {
          const rot = (i - (HERO_HAND.length - 1) / 2) * 1.6;
          return (
            <span
              key={i}
              className="relative flex h-[90px] w-16 items-center justify-center rounded-card border border-line bg-surface font-mono text-ink shadow-rest"
              style={
                {
                  "--rot": `${rot.toFixed(1)}deg`,
                  fontSize: "var(--text-num-card)",
                  animation:
                    `deal-in ${CARD_DEAL_MS}ms linear ${i * DEAL_STAGGER_MS}ms both, ` +
                    `flip-in var(--dur-flip) linear ${flipBase + flipStartsAt(i)}ms both`,
                } as CSSProperties
              }
            >
              {v}
            </span>
          );
        })}
      </div>
      {/* The one number the room agreed on. `settled` is the token for a
          decision at rest — not `go`, which is the act of confirming, and not
          `accent`, which is a live state. */}
      <span
        className="font-mono leading-none tabular-nums"
        style={{
          fontSize: "var(--text-num-result)",
          color: "var(--color-settled)",
          animation: `stamp-in 350ms var(--ease-settle) ${flipBase + resultStampsAt(HERO_HAND.length)}ms both`,
        }}
      >
        {HERO_RESULT}
      </span>
    </div>
  );
}

/** Drawn, not typed: a padlock in the KindChip line weight. */
function LockGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      <rect x="2.6" y="6.2" width="8.8" height="6.2" rx="1.2" />
      <path d="M4.6 6.2V4.4a2.4 2.4 0 0 1 4.8 0v1.8" />
    </svg>
  );
}

/**
 * Who is at one open table, in a sentence. Names come from the roster's seat
 * refs; `here` also counts link guests, who are not on the roster, so the
 * remainder is "others" rather than being dropped.
 */
function whoIsHere(session: SessionSummary, members: Person[]): string {
  const named = members
    .filter((m) => m.at?.sessionId === session.id)
    .map((m) => safeDisplayName(m.name).split(/\s+/)[0]);
  const others = Math.max(0, session.here - named.length);
  if (named.length === 0) {
    if (others === 0) return "Nobody at the table yet";
    return `${others} at the table`;
  }
  const shown = named.slice(0, 2);
  const rest = named.length - shown.length + others;
  if (rest === 0) {
    return (shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0]) + " at the table";
  }
  return `${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"} at the table`;
}

/**
 * One face-down card per person with a socket open on the round, dealt in with
 * the table's own deal. A card arriving after load is somebody sitting down:
 * the list refetches, the count grows, and only the new card is dealt, because
 * the ones already on the table keep their keys. Nobody here is drawn as an
 * empty seat — absence as an outline, the same as the table.
 */
const handCap = 6;
function SeatedCards({ here }: { here: number }) {
  if (here === 0) {
    return <span aria-hidden className="h-[30px] w-[22px] shrink-0 rounded-sm border-2 border-dashed border-line" />;
  }
  const shown = Math.min(here, handCap);
  return (
    <span aria-hidden className="flex shrink-0 items-end">
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className="-ml-2 flex h-[30px] w-[22px] items-center justify-center rounded-sm border border-surface bg-card-back shadow-rest first:ml-0"
          style={
            {
              "--rot": `${((i - (shown - 1) / 2) * 5).toFixed(1)}deg`,
              animation: `deal-in ${CARD_DEAL_MS}ms linear ${i * DEAL_STAGGER_MS}ms both`,
            } as CSSProperties
          }
        >
          <span className="h-1.5 w-1.5 rotate-45 border border-pip opacity-55" />
        </span>
      ))}
      {here > handCap && (
        <span className="ml-1.5 font-mono text-[11px] tabular-nums text-ink-faint">+{here - handCap}</span>
      )}
    </span>
  );
}

/**
 * The first thing a returning account sees: the table they last sat at, and
 * what is happening on it right now. The list is ordered by the server's
 * last_seen_at, so the first membership is that table — no new endpoint.
 *
 * It reads the space through the same query key the space page uses, so
 * following the link lands on a warm cache. It refetches on a short interval
 * because "two at the table" is a claim about now; a stale count is exactly the
 * disguised state PRODUCT.md rules out. If the read fails the heading and the
 * door still work — the live line is the only thing lost.
 */
function ReturnTable({ space, orgName }: { space: Membership; orgName: string | null }) {
  const headingId = useId();
  const detail = useQuery({
    queryKey: ["space", space.orgSlug, space.slug],
    queryFn: () => api<SpaceView>("GET", spaceApi(space.orgSlug, space.slug)),
    retry: false,
    refetchInterval: 15_000,
  });
  // Occupied tables first: a round people are sitting at is the one worth
  // joining. Stable sort, so equal counts keep the server's order.
  const open = (detail.data?.sessions ?? [])
    .filter((s) => s.endedAt === null)
    .sort((a, b) => b.here - a.here)
    .slice(0, 3);
  const members = detail.data?.members ?? [];

  return (
    <section
      aria-labelledby={headingId}
      className="w-full rounded-panel border border-line bg-surface px-6 py-6 shadow-rest sm:px-8"
    >
      <h1
        id={headingId}
        className="text-balance font-display text-[clamp(1.75rem,5vw,2.4rem)] font-bold leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]"
      >
        {space.name}
      </h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        The table you sat at last{orgName ? `, in ${orgName}` : ""}.
      </p>

      {open.length > 0 && (
        <ul aria-label="Rounds open now" className="mt-5 flex flex-col gap-2">
          {open.map((s) => (
            <li key={s.id}>
              <Link
                to={`/session/${s.id}`}
                className="flex items-center gap-4 rounded-card border border-line bg-surface-hi px-4 py-3 shadow-rest transition hover:shadow-lift"
              >
                <SeatedCards here={s.here} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 font-bold">{s.title || kindLabel(s.kind)}</span>
                  <span className="block text-sm text-ink-soft">{whoIsHere(s, members)}</span>
                </span>
                <span className="hidden sm:inline-flex">
                  <KindChip kind={s.kind} size="sm" />
                </span>
                <span className="shrink-0 text-sm font-bold text-accent">Join</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {detail.isSuccess && open.length === 0 && (
        <p className="mt-5 flex items-center gap-3 text-sm text-ink-soft">
          <SeatedCards here={0} />
          No round open. The table is quiet until someone deals.
        </p>
      )}

      <Link to={spacePath(space.orgSlug, space.slug)} className={buttonPrimary + " mt-6 inline-block max-w-full [overflow-wrap:anywhere]"}>
        Go to {space.name}
      </Link>
    </section>
  );
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
  // Where a new space goes when the page is showing every org. The switcher,
  // when set, answers it instead: a create should land in the org on screen.
  const [createOrg, setCreateOrg] = useState("");
  const [find, setFind] = useState("");
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
  const orgFieldId = useId();
  const errorId = useId();
  const findId = useId();

  // The org a create is sent to. Omitted when the page cannot say — the
  // server then uses the instance's default org, which is what it always did.
  const soleOrg = orgs.length === 1 ? orgs[0].slug : undefined;
  const targetOrg = orgFilter ?? soleOrg ?? (createOrg || orgs[0]?.slug);

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
    async (spaceName: string, org?: string) => {
      if (creating.current) return;
      creating.current = true;
      setBusy(true);
      setError("");
      setCanRetry(false);
      let sp: SpaceView;
      try {
        sp = await api<SpaceView>("POST", "/api/spaces", org ? { name: spaceName, org } : { name: spaceName });
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
    // A resumed create has no switcher choice behind it; a single-org account
    // still names its one org, so a member of only a non-default org can
    // finish what they started.
    doCreate(pending, soleOrg);
  }, [fullAccount, myOrgs.isPending, noOrg, doCreate, soleOrg]);

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
    doCreate(name.trim(), targetOrg);
  }

  // Until both answers are in, the page cannot know which of its two faces is
  // true. `data ?? []` used to read "still loading" as "no spaces", so every
  // signed-in load dealt the stranger's hand, printed the pitch, and then tore
  // both down a round trip later.
  const settling =
    me.isPending || (fullAccount && (mine.isPending || myOrgs.isPending));

  // Grouped by org, in the switcher's order, because a slug is only unique
  // inside one org: two orgs can each have a "platform-team", and a flat list
  // would show the same name twice with nothing to tell them apart.
  const needle = find.trim().toLowerCase();
  const shown = spaces.filter(
    (sp) =>
      (!orgFilter || sp.orgSlug === orgFilter) &&
      (!needle || sp.name.toLowerCase().includes(needle)),
  );
  const orgName = (slug: string) => orgs.find((o) => o.slug === slug)?.name ?? slug;
  // One panel per org the page is showing — hung off the org memberships, so
  // an org with no spaces of yours still has a panel to carry its directory
  // door. Orgs a space names that the org list did not (a failed org read)
  // still get a panel under their slug rather than hiding the space.
  const panelSlugs = [
    ...new Set([
      ...orgs.map((o) => o.slug),
      ...spaces.map((sp) => sp.orgSlug),
    ]),
  ].filter((slug) => !orgFilter || slug === orgFilter);
  const known = spaces.length > 0;
  // The stranger's page is for someone deciding: signed out, or an account
  // whose list answered and was empty. Everyone else — a full account still
  // loading, one whose list failed, one with tables — gets the signed-in
  // shell from the first paint, because swapping the narrow centred column
  // for the wide top-aligned one once the list lands was the page's biggest
  // layout shift, and a failed read is not evidence of having no tables.
  const stranger = !fullAccount || (mine.isSuccess && !known);
  const wide = !stranger;
  const multiOrg = orgs.length > 1;
  const guestRoomId = me.data?.linkSessionId;
  // Past a handful the list outgrows a glance, and typing four letters beats
  // scrolling for the one you want.
  const findable = spaces.length > 6;

  return (
    <div className="flex min-h-dvh flex-col">
      {/* The page corner, not the column's — main is capped, so an absolute
          corner would strand this in dead space on a wide screen. Absolute
          below sm: a fixed pill on a phone rides over the list as it scrolls. */}
      <div
        className="absolute z-10 sm:fixed"
        style={{ top: "calc(1rem + var(--safe-top))", right: "calc(1rem + var(--safe-right))" }}
      >
        <ThemeToggle />
      </div>

      {/* text-center used to cascade from here into every paragraph. Prose
          reads left; only the lockup and the CTA row are centred. A returning
          account's page is a list to act on, so it is top-aligned: a centred
          column re-centred itself on every filter click. */}
      <main
        className={
          "mx-auto flex w-full flex-1 flex-col items-center gap-7 px-4 py-6 sm:px-6 " +
          (wide ? "max-w-6xl justify-start pt-16 sm:pt-20" : "max-w-2xl justify-center")
        }
      >
        {!settling && stranger && <DealAndReveal />}

        {/* The wordmark is a brand mark, not the document's heading. */}
        <div className={"flex flex-col gap-3 " + (wide ? "items-start self-stretch" : "items-center")}>
          <div className="flex items-center gap-3">
            <Logo size={wide ? 30 : 26} />
            <span
              className={
                (wide ? "text-[1.7rem]" : "text-3xl") +
                " font-display font-bold tracking-[-0.02em]"
              }
            >
              Parley
            </span>
          </div>
          {!settling && stranger && !guestRoomId && (
            <h1 className="max-w-[18ch] text-balance text-center font-display text-[clamp(2rem,6vw,3.25rem)] font-bold leading-[1.05] tracking-[-0.02em]">
              Name a table. Share the link. Start the round.
            </h1>
          )}
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
        {!settling && stranger && !guestRoomId && (
          <p className="max-w-[68ch] text-pretty text-ink-soft">
            Planning poker and daily standups for your team, at your table. A space
            is a room your team keeps — name one, share the link, start a round.
            Self-hosted: one binary, your database, no seat counts.
          </p>
        )}

        {/* Who the server thinks you are, and the way out. Without it a shared
            machine, or a second account, has no door on this page — the space
            list just silently belongs to somebody else. */}
        {mode.data?.mode === "oidc" && fullAccount && me.data && (
          <p
            className={
              "flex items-center gap-3 text-sm text-ink-soft " + (wide ? "self-stretch" : "")
            }
          >
            <Avatar name={me.data.name} hue={me.data.avatarHue} icon={me.data.avatarIcon} size="sm" decorative />
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

        {!guestRoomId && noOrg && (
          <section
            aria-label="No org yet"
            className="w-full max-w-md rounded-card border border-line bg-surface px-5 py-4"
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
            {mine.isError && (
              <p className="flex items-center gap-3 text-sm text-ink-soft">
                Couldn't load your spaces.
                <button type="button" className={buttonQuiet} onClick={() => mine.refetch()}>
                  Try again
                </button>
              </p>
            )}

            {/* Past lg the page is two columns: the table you are going back
                to and the create form on the left, every space you have on the
                right. One column there left most of a wide screen empty. The
                list is placed on the grid explicitly, so the DOM can run hero,
                form, list — the order the left column is read and tabbed in —
                without the list moving. Below lg there is one column and no
                order-* reshuffling: what is read first, tabbed first and seen
                first stay the same thing (WCAG 1.3.2), at the cost of the list
                sitting under the form on a phone. The base template is
                minmax(0,1fr), not auto, so one long unbroken space name wraps
                instead of widening the page past the viewport (1.4.10). For a
                stranger the wrapper is `contents` and changes nothing. */}
            <div
              className={
                wide
                  ? "grid w-full grid-cols-[minmax(0,1fr)] items-start gap-7 lg:grid-cols-[minmax(0,7fr)_minmax(0,6fr)] lg:grid-rows-[auto_1fr]"
                  : "contents"
              }
            >
              {known && (
                <ReturnTable space={spaces[0]} orgName={multiOrg ? orgName(spaces[0].orgSlug) : null} />
              )}

              {/* The same two blocks the answer will fill, where it will fill
                  them, so nothing moves when it lands. */}
              {fullAccount && settling && (
                <>
                  <div aria-hidden className="flex h-56 flex-col gap-3 rounded-panel border border-line bg-surface p-6 lg:col-start-1 lg:row-start-1">
                    <span className="h-9 w-2/3 rounded-card bg-felt-deep" />
                    <span className="h-4 w-1/2 rounded-card bg-felt-deep" />
                  </div>
                  <div aria-hidden className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3 lg:col-start-2 lg:row-span-2 lg:row-start-1">
                    <span className="h-9 rounded-card bg-felt-deep" />
                    <span className="h-9 rounded-card bg-felt-deep" />
                    <span className="h-9 w-2/3 rounded-card bg-felt-deep" />
                  </div>
                </>
              )}

              <div className={wide ? "flex flex-col gap-4 lg:col-start-1 lg:row-start-2" : "contents"}>
                {!settling && (
                  <form
                    onSubmit={submit}
                    className={
                      "flex w-full flex-col gap-3 self-center rounded-panel border border-line bg-surface p-5 shadow-rest sm:flex-row sm:flex-wrap sm:items-end " +
                      (wide ? "" : "max-w-md")
                    }
                  >
                    <div className="min-w-0 flex-1 sm:min-w-48">
                      <label htmlFor={fieldId} className={"mb-2 block " + labelText}>
                        {known ? "New space" : "Name your space"}
                      </label>
                      <input
                        id={fieldId}
                        name="space-name"
                        autoComplete="off"
                        className={inputClass}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Platform Team"
                        maxLength={64}
                        aria-invalid={error && canRetry ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                      />
                    </div>
                    {/* Which org it lands in, asked only when the page cannot
                        tell: several orgs and no switcher choice. */}
                    {fullAccount && multiOrg && !orgFilter && (
                      <div className="sm:w-40">
                        <label htmlFor={orgFieldId} className={"mb-2 block " + labelText}>
                          In
                        </label>
                        <select
                          id={orgFieldId}
                          className={inputClass}
                          value={targetOrg}
                          onChange={(e) => setCreateOrg(e.target.value)}
                        >
                          {orgs.map((o) => (
                            <option key={o.slug} value={o.slug}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button
                      type="submit"
                      className={buttonPrimary + " shrink-0"}
                      disabled={!name.trim() || busy}
                    >
                      {busy ? "Opening…" : known ? "Create a space" : "Open a space"}
                    </button>
                    {fullAccount && multiOrg && orgFilter && (
                      <p className="w-full text-sm text-ink-soft sm:order-last">
                        It will be in {orgName(orgFilter)}.
                      </p>
                    )}
                  </form>
                )}

                {error && (
                  <p id={errorId} role="alert" className="flex items-center gap-3 font-bold text-stop">
                    {error}
                    {canRetry && (
                      <button
                        type="button"
                        className={buttonQuiet + " font-bold"}
                        onClick={() => doCreate(name.trim(), targetOrg)}
                        disabled={!name.trim() || busy}
                      >
                        Try again
                      </button>
                    )}
                  </p>
                )}

                {/* Worth saying until the list says it for them: once someone has
                    a few tables they know how they got there. */}
                {!settling && spaces.length <= 1 && (
                  <p className={"text-pretty text-sm text-ink-faint " + (wide ? "self-stretch px-1" : "max-w-md self-center")}>
                    Got a link from a teammate? That link is your invite — just open it. A
                    passcode alone won't do it; ask them for the link.
                  </p>
                )}
              </div>

              <div className={wide ? "lg:col-start-2 lg:row-span-2 lg:row-start-1" : "contents"}>
                {!settling && (known || orgs.length > 0) && (
                  <div className="flex w-full flex-col gap-4">
                    {(multiOrg || findable) && (
                      <div className="flex flex-wrap items-center gap-3">
                        {multiOrg && (
                          /* A filter, not navigation: pressing one changes what
                             this page shows and goes nowhere. Every state keeps
                             the same box so the row never reflows under the
                             pointer. */
                          <div
                            role="group"
                            aria-label="Show spaces from"
                            className="flex flex-wrap items-center gap-2"
                          >
                            {[{ slug: null as string | null, name: "All orgs" }, ...orgs].map((o) => {
                              const on = orgFilter === o.slug;
                              return (
                                <button
                                  key={o.slug ?? ""}
                                  type="button"
                                  aria-pressed={on}
                                  onClick={() => setOrgFilter(o.slug)}
                                  className={
                                    "rounded-full border px-3.5 py-1.5 text-sm font-bold transition " +
                                    (on
                                      ? "border-accent bg-accent-soft text-ink"
                                      : "border-line-strong text-ink-soft hover:bg-felt-deep")
                                  }
                                >
                                  {o.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {findable && (
                          <div className="min-w-48 flex-1">
                            <label htmlFor={findId} className="sr-only">
                              Find a space
                            </label>
                            <input
                              id={findId}
                              type="search"
                              autoComplete="off"
                              className={inputClass}
                              value={find}
                              onChange={(e) => setFind(e.target.value)}
                              onKeyDown={(e) => {
                                // Enter opens the one match, which is the whole
                                // point of typing four letters.
                                if (e.key === "Enter" && shown.length === 1) {
                                  e.preventDefault();
                                  navigate(spacePath(shown[0].orgSlug, shown[0].slug));
                                }
                              }}
                              placeholder="Find a space"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* One panel per org: its name, its spaces, and the doors that
                        belong to it — the directory, and the plugin surface for an
                        admin. Those doors used to float in two separate navs under
                        the list, detached from the org they opened. */}
                    {panelSlugs.map((slug) => {
                      const rows = shown.filter((sp) => sp.orgSlug === slug);
                      const org = orgs.find((o) => o.slug === slug);
                      // A filtered-out panel is noise; one with no spaces at all
                      // stays, because its directory door is how that member
                      // finds a room nobody sent them.
                      if (needle && rows.length === 0) return null;
                      const title = orgName(slug);
                      return (
                        <section
                          key={slug}
                          aria-label={title}
                          className="rounded-panel border border-line bg-surface shadow-rest"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3">
                            <h2 className="font-display text-[15px] font-bold">{title}</h2>
                            {org && (
                              <span className="flex items-center gap-4 text-sm">
                                <Link
                                  to={orgPath(slug)}
                                  aria-label={`Browse ${title}`}
                                  className="py-1 text-ink-soft underline underline-offset-2 hover:text-ink"
                                >
                                  Browse
                                </Link>
                                {org.role === "admin" && (
                                  <Link
                                    to={pluginsPath(slug)}
                                    aria-label={`Plugins in ${title}`}
                                    className="py-1 text-ink-soft underline underline-offset-2 hover:text-ink"
                                  >
                                    Plugins
                                  </Link>
                                )}
                              </span>
                            )}
                          </div>
                          {/* A plugin's nav slot for this org. Collapses when the
                              slot renders nothing, so an instance with no plugins
                              does not pay a gap for one. */}
                          {org && (
                            <div className="px-5 pt-3 empty:hidden">
                              <PluginChrome slot="nav" orgSlug={slug} />
                            </div>
                          )}
                          {rows.length > 0 ? (
                            <ul aria-label={`Your spaces in ${title}`} className="flex flex-col gap-0.5 p-2">
                              {rows.map((sp) => (
                                <li key={sp.orgSlug + "/" + sp.slug}>
                                  <Link
                                    to={spacePath(sp.orgSlug, sp.slug)}
                                    className="flex items-center justify-between gap-3 rounded-card px-3 py-2.5 font-bold hover:bg-felt-deep"
                                  >
                                    <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{sp.name}</span>
                                    {sp.protected && (
                                      <span className="flex shrink-0 items-center gap-1.5 text-ink-faint">
                                        <LockGlyph />
                                        <span className="font-mono text-[11px] font-normal tracking-[0.06em]">
                                          <span className="sr-only">, </span>passcode
                                        </span>
                                      </span>
                                    )}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            // A list that failed to load says so once, above;
                            // repeating "none here" in every panel would claim
                            // an answer the page never got.
                            !mine.isError && <p className="px-5 py-4 text-sm text-ink-soft">
                              No tables of yours here yet. Browse to find your team's, or name one below.
                            </p>
                          )}
                        </section>
                      );
                    })}
                    {needle && shown.length === 0 && (
                      <p role="status" className="px-1 text-sm text-ink-soft">
                        No space of yours matches “{find.trim()}”.
                      </p>
                    )}
                  </div>
                )}
              </div>

            </div>
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

      {/* A stranger had no way to learn more and no exit. These are the things
          that exist and are checkable — docs, source, licence, releases.
          Nothing here claims adoption, customers or benchmarks, because none
          exist. Outside main, so it is the page's contentinfo landmark. */}
      <footer className="flex flex-wrap items-center justify-center gap-x-5 px-4 pb-6 pt-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
        <a className="inline-block py-2 hover:text-ink" href="https://www.letsparley.io">
          Documentation
        </a>
        <a className="inline-block py-2 hover:text-ink" href="https://github.com/lets-parley/parley">
          Source · MIT
        </a>
        <a className="inline-block py-2 hover:text-ink" href="https://github.com/lets-parley/parley/releases">
          Releases
        </a>
      </footer>
    </div>
  );
}
