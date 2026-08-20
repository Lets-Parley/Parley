import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Me, type Person, type SessionSummary } from "../lib/api";
import { kindLabel } from "../lib/kinds";
import type { ConnectionStatus } from "../lib/socket";
import { useMediaQuery, useTheme } from "../lib/ui";
import { Avatar } from "./Avatar";
import { ConnectionBanner } from "./ConnectionBanner";
import { KindChip } from "./KindChip";
import { MemberCard } from "./MemberCard";
import { Modal } from "./Modal";
import { useAuthMode } from "./NameGate";
import logoUrl from "../assets/logo.svg";

export function Logo({ size = 14 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      className="inline-block shrink-0"
      alt=""
      aria-hidden
    />
  );
}

const SIDEBAR_SESSIONS = 8;

const NEXT_THEME_WORD = { system: "light", light: "dark", dark: "system" } as const;

const RELEASES = "https://github.com/lets-parley/parley/releases";

/**
 * What this build calls itself. Asked once — a version cannot change without a
 * page load — and deliberately silent on failure: an old server without the
 * endpoint, or a blip, should cost the room nothing.
 */
export function BuildStamp() {
  const { data } = useQuery({
    queryKey: ["version"],
    queryFn: () => api<{ version: string }>("GET", "/version"),
    staleTime: Infinity,
    retry: false,
  });
  if (!data?.version) return null;
  // An unstamped build has no tag to link to, so it gets the releases index.
  const href = data.version === "dev" ? RELEASES : `${RELEASES}/tag/${data.version}`;
  return (
    <a
      href={href}
      target="_blank"
      aria-label={`Parley ${data.version} release notes`}
      rel="noreferrer"
      className="mt-auto border-t border-line pt-3 font-mono text-[11px] text-ink-soft hover:text-ink"
    >
      Parley {data.version}
    </a>
  );
}

// The wire calls these live/reconnecting/stale/removed. A room does not.
const STATUS_WORD: Record<ConnectionStatus, string> = {
  live: "live",
  reconnecting: "reconnecting",
  stale: "offline",
  removed: "no access",
};

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const color =
    status === "live" ? "bg-go" : status === "reconnecting" ? "bg-accent" : "bg-stop";
  return (
    <span
      aria-live="polite"
      className="flex items-center gap-1.5 font-mono text-[11px] text-ink-soft"
    >
      <span className={"h-2 w-2 rounded-full " + color} />
      {STATUS_WORD[status]}
    </span>
  );
}

type Props = {
  spaceSlug: string;
  spaceName: string;
  title?: string;
  me: Me | null;
  /** Omitted where there is no socket to report on — the dot must not claim
      "live" on a page that never opened one. */
  status?: ConnectionStatus;
  onRetry?: () => void;
  members?: Person[];
  presence?: string[];
  sessions?: SessionSummary[];
  activeSessionId?: string;
  /* Sidebar starts closed in a session — the table wants the width. */
  sidebarDefault?: boolean;
  actions?: ReactNode;
  children: ReactNode;
};

/**
 * The theme control, standing on its own so the landing page can mount it too.
 * Three themes are a product commitment, and a visitor who has never opened a
 * space still needs the switch.
 *
 * The palette says its own name. Encoding it in an inset shadow on a 12px dot
 * asked everyone to read a state only its author knew.
 */
export function ThemeToggle() {
  const { theme, isDark, cycle } = useTheme();
  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME_WORD[theme]}.`}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-felt-deep py-1 pl-1.5 pr-2.5 hover:bg-surface-hi"
    >
      <span
        aria-hidden
        className="h-3 w-3 shrink-0 rounded-full bg-ink-soft"
        style={{ boxShadow: isDark ? "inset 3px -2px 0 0 var(--color-surface)" : "none" }}
      />
      <span className="hidden font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint sm:inline">
        {theme}
      </span>
    </button>
  );
}

export function AppShell({
  spaceSlug,
  spaceName,
  title,
  me,
  status,
  onRetry,
  members,
  presence,
  sessions,
  activeSessionId,
  sidebarDefault = true,
  actions,
  children,
}: Props) {
  // Below md there is no room for a rail, so the same nav arrives as a sheet.
  // ponytail: one open flag for both presentations — resizing across the
  // breakpoint while it is open swaps rail for sheet, which is a shrug.
  const wide = useMediaQuery("(min-width: 768px)");
  const [sideOpen, setSideOpen] = useState(() => sidebarDefault && wide);
  const [who, setWho] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const mode = useAuthMode();
  // Only offered where it means something. In open mode the identity is just a
  // name in a cookie, and "sign out" would promise more than it does.
  const signedIn = mode.data?.mode === "oidc";

  // Local sign-out: the cookie and its token row go, the identity provider's
  // own session is left alone. Someone on a shared machine must sign out there
  // too, which is why this says "Sign out" and not "Sign out everywhere".
  async function signOut() {
    try {
      await api("DELETE", "/api/me");
    } finally {
      window.location.href = "/";
    }
  }
  // No presence feed means presence is unknown, which is not the same as
  // everyone being here: falling back to the whole roster lit a green dot
  // beside people who were nowhere near the space.
  const online = new Set(presence ?? []);
  const stack = (members ?? []).slice(0, 5);
  const overflow = (members?.length ?? 0) - stack.length;
  const whoMember = who ? members?.find((m) => m.userId === who) : undefined;

  /* One nav, two presentations: a rail where there is width for it, and the
     same content as a sheet where there is not. The hamburger must never
     report an expansion that cannot appear. */
  const navBody = (
    <>
          {sessions && (
            <section>
              <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Sessions
              </h2>
              <ul className="flex flex-col gap-0.5">
                {sessions.slice(0, SIDEBAR_SESSIONS).map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/session/${s.id}`}
                      /* Spelt out so the kind reaches the accessible name
                         separated from the title, rather than run together
                         with it as concatenated text would be. */
                      aria-label={`${kindLabel(s.kind)} · ${s.title}${s.endedAt ? " · ended" : ""}`}
                      className={
                        "flex items-center gap-2 rounded-chip px-2.5 py-1.5 hover:bg-felt-deep " +
                        (s.id === activeSessionId ? "bg-felt-deep" : "")
                      }
                    >
                      <span className="truncate text-[13px] font-semibold">{s.title}</span>
                      <span className="ml-auto">
                        <KindChip kind={s.kind} size="sm" />
                      </span>
                      {s.endedAt && (
                        <span className="shrink-0 font-mono text-[9px] text-ink-faint">ended</span>
                      )}
                    </Link>
                  </li>
                ))}
                {sessions.length === 0 && (
                  <li className="px-2.5 py-1.5 text-[13px] text-ink-faint">No sessions yet.</li>
                )}
                {sessions.length > SIDEBAR_SESSIONS && (
                  /* Silent truncation reads as "that is all there is", and a
                     facilitator hunting yesterday's round concludes it is gone. */
                  <li>
                    <Link
                      to={`/s/${spaceSlug}`}
                      className="block rounded-chip px-2.5 py-1.5 text-[13px] font-semibold text-accent hover:bg-felt-deep"
                    >
                      All {sessions.length} sessions
                    </Link>
                  </li>
                )}
              </ul>
            </section>
          )}

          {members && (
            <section>
              <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Members · {members.length}
              </h2>
              <ul className="flex flex-col gap-2">
                {members.map((m) => (
                  <li key={m.userId}>
                    <button
                      onClick={() => setWho(m.userId)}
                      className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-chip px-1 py-0.5 text-left hover:bg-felt-deep"
                    >
                    <span className="relative">
                      <Avatar
                        name={m.name}
                        hue={m.avatarHue}
                        size="sm"
                        dim={!online.has(m.userId)}
                        decorative
                      />
                      <span
                        className={
                          "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-surface " +
                          (online.has(m.userId) ? "bg-go" : "bg-ink-faint")
                        }
                      />
                    </span>
                    <span className="truncate text-[13px] font-semibold text-ink-soft">{m.name}</span>
                    <span className="sr-only">
                      {online.has(m.userId) ? "online" : "offline"}
                    </span>
                    {me?.id === m.userId && (
                      <span className="font-mono text-[9px] text-ink-faint">you</span>
                    )}
                    {m.at && (
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-go">
                        {m.at.sessionId === activeSessionId ? "here" : "in session"}
                      </span>
                    )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
      <BuildStamp />
    </>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      {/* First focusable thing on the page. Without it a keyboard voter walks
          the whole header and sidebar before reaching their hand, every round,
          against a 90-second turn. */}
      <a
        href="#main"
        className="sr-only rounded-full bg-accent px-4 py-2 text-[13px] font-bold text-accent-ink focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
      >
        Skip to the table
      </a>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:gap-4 sm:px-5">
        <button
          onClick={() => setSideOpen((v) => !v)}
          title="Toggle sidebar"
          aria-expanded={sideOpen}
          aria-label="Toggle sidebar"
          className="flex h-8 w-8 shrink-0 flex-col items-center justify-center gap-[3px] rounded-chip border border-line hover:bg-felt-deep"
        >
          <span className="h-0.5 w-3.5 rounded-full bg-ink-soft" />
          <span className="h-0.5 w-3.5 rounded-full bg-ink-soft" />
          <span className="h-0.5 w-3.5 rounded-full bg-ink-soft" />
        </button>

        {/* The room is the loudest thing in the header, because on a shared
            screen the header's job is to say which round the room is in — not
            whose software it is. The wordmark keeps the way home as a mark. */}
        <Link to="/" aria-label="Parley home" className="flex shrink-0 items-center">
          <Logo size={18} />
        </Link>

        <span className="hidden h-5 w-px bg-line sm:block" />

        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <h1 className="truncate text-[17px] font-extrabold tracking-tight sm:text-[19px]">
            {title ?? spaceName}
          </h1>
          {title && (
            <Link
              to={`/s/${spaceSlug}`}
              className="truncate text-[12px] font-semibold text-ink-soft hover:text-ink"
            >
              {spaceName}
            </Link>
          )}
        </span>

        <span className="flex-1" />

        {status && (
          <span className="hidden sm:block">
            <ConnectionDot status={status} />
          </span>
        )}

        {stack.length > 0 && (
          <span className="hidden items-center lg:flex">
            {stack.map((m, i) => (
              <button
                key={m.userId}
                title={m.name}
                aria-label={m.name}
                onClick={() => setWho(m.userId)}
                style={{ marginLeft: i ? -8 : 0 }}
                className="rounded-full ring-2 ring-surface"
              >
                <Avatar name={m.name} hue={m.avatarHue} size="sm" dim={!online.has(m.userId)} decorative />
              </button>
            ))}
            {overflow > 0 && (
              /* A count that raises "who else?" has to be able to answer it. */
              <button
                onClick={() => setRosterOpen(true)}
                aria-label={`Show all ${members?.length ?? 0} members`}
                className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full bg-felt-deep text-[10px] font-bold text-ink-soft ring-2 ring-surface hover:bg-surface-hi"
              >
                +{overflow}
              </button>
            )}
          </span>
        )}

        {actions}

        {me && (
          /* On a phone the room's name outranks your own — you already know
             who you are, and the chip still says it. */
          <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-felt-deep py-1 pl-1 sm:pr-3">
            <Avatar name={me.name} hue={me.avatarHue} size="sm" decorative />
            {/* Always in the accessible name; visible only where there is room
                for it beside the title. */}
            <span className="sr-only max-w-24 truncate text-[13px] font-bold sm:not-sr-only lg:max-w-48">
              {me.name}
            </span>
          </span>
        )}

        {me && signedIn && (
          <button
            onClick={signOut}
            className="hidden shrink-0 rounded-chip border border-line px-2.5 py-1.5 text-[12px] font-bold text-ink-soft hover:bg-felt-deep sm:block"
          >
            Sign out
          </button>
        )}

        <ThemeToggle />
      </header>

      {status && <ConnectionBanner status={status} onRetry={onRetry} />}

      <div className="flex flex-1 items-stretch">
        {sideOpen && wide && (
          <nav
            aria-label="Space"
            className="flex w-[250px] shrink-0 flex-col gap-6 border-r border-line bg-surface p-4"
          >
            {navBody}
          </nav>
        )}

        <main id="main" className="relative min-w-0 flex-1">{children}</main>
      </div>

      {sideOpen && !wide && (
        <Modal title={spaceName} onClose={() => setSideOpen(false)} width="20rem">
          <nav aria-label="Space" className="mt-4 flex flex-col gap-6">
            {navBody}
          </nav>
        </Modal>
      )}

      {rosterOpen && (
        <Modal title="Members" onClose={() => setRosterOpen(false)} width="20rem">
          <ul className="mt-4 flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {(members ?? []).map((m) => (
              <li key={m.userId} className="flex items-center gap-2.5">
                <Avatar
                  name={m.name}
                  hue={m.avatarHue}
                  size="sm"
                  dim={!online.has(m.userId)}
                  decorative
                />
                <span className="truncate text-[13px] font-semibold">{m.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
                  {online.has(m.userId) ? "online" : "offline"}
                </span>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {/* Looked up rather than asserted: a roster refresh can drop the member
          whose card is open, and a stale id must close the card, not crash. */}
      {whoMember && (
        <MemberCard
          member={whoMember}
          isYou={me?.id === whoMember.userId}
          activeSessionId={activeSessionId}
          onClose={() => setWho(null)}
        />
      )}
    </div>
  );
}
