import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Me, Person, SessionSummary } from "../lib/api";
import type { ConnectionStatus } from "../lib/socket";
import { useTheme } from "../lib/ui";
import { Avatar } from "./Avatar";
import { ConnectionBanner } from "./ConnectionBanner";
import { MemberCard } from "./MemberCard";

export function Logo({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rotate-[8deg] rounded-[4px] bg-accent shadow-rest"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const color =
    status === "live" ? "bg-go" : status === "reconnecting" ? "bg-brass" : "bg-stop";
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-soft">
      <span className={"h-2 w-2 rounded-full " + color} />
      {status}
    </span>
  );
}

type Props = {
  spaceSlug: string;
  spaceName: string;
  title?: string;
  me: Me | null;
  status: ConnectionStatus;
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

export function AppShell({
  spaceSlug,
  spaceName,
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
  const [sideOpen, setSideOpen] = useState(sidebarDefault);
  const [who, setWho] = useState<string | null>(null);
  const { isDark, toggle } = useTheme();
  const online = new Set(presence ?? members?.map((m) => m.userId) ?? []);
  const stack = (members ?? []).slice(0, 5);
  const overflow = (members?.length ?? 0) - stack.length;

  return (
    <div className="flex min-h-dvh flex-col">
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

        <Link to="/" className="flex shrink-0 items-center gap-2">
          <Logo />
          <span className="text-lg font-extrabold tracking-tight">Parley</span>
        </Link>

        <span className="hidden h-5 w-px bg-line sm:block" />

        <Link to={`/s/${spaceSlug}`} className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-bold">{spaceName}</span>
          <span className="hidden rounded-chip bg-felt-deep px-2 py-0.5 font-mono text-[11px] text-ink-faint md:inline">
            /s/{spaceSlug}
          </span>
        </Link>

        <span className="flex-1" />

        <span className="hidden sm:block">
          <ConnectionDot status={status} />
        </span>

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
                <Avatar name={m.name} hue={m.avatarHue} size="sm" dim={!online.has(m.userId)} />
              </button>
            ))}
            {overflow > 0 && (
              <span className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full bg-felt-deep text-[10px] font-bold text-ink-soft ring-2 ring-surface">
                +{overflow}
              </span>
            )}
          </span>
        )}

        {actions}

        {me && (
          <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-felt-deep py-1 pl-1 pr-3">
            <Avatar name={me.name} hue={me.avatarHue} size="sm" />
            <span className="max-w-24 truncate text-[13px] font-bold">{me.name}</span>
          </span>
        )}

        <button
          onClick={toggle}
          title={isDark ? "Switch to light" : "Switch to dark"}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-felt-deep hover:bg-surface-hi"
        >
          <span
            className="h-3 w-3 rounded-full bg-ink-soft"
            style={{ boxShadow: isDark ? "inset 3px -2px 0 0 var(--color-surface)" : "none" }}
          />
        </button>
      </header>

      <ConnectionBanner status={status} onRetry={onRetry} />

      <div className="flex flex-1 items-stretch">
        {sideOpen && (
          <nav className="hidden w-[250px] shrink-0 flex-col gap-6 border-r border-line bg-surface p-4 md:flex">
            {sessions && (
              <section>
                <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Sessions
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {sessions.slice(0, 8).map((s) => (
                    <li key={s.id}>
                      <Link
                        to={`/session/${s.id}`}
                        className={
                          "flex items-center gap-2 rounded-chip px-2.5 py-1.5 hover:bg-felt-deep " +
                          (s.id === activeSessionId ? "bg-felt-deep" : "")
                        }
                      >
                        <span
                          className={
                            "h-[22px] w-4 shrink-0 rounded-[4px] border border-line " +
                            (s.kind === "poker" ? "bg-card-back" : "bg-felt-deep")
                          }
                        />
                        <span className="truncate text-[13px] font-semibold">{s.title}</span>
                        {s.endedAt && (
                          <span className="ml-auto shrink-0 font-mono text-[9px] text-ink-faint">ended</span>
                        )}
                      </Link>
                    </li>
                  ))}
                  {sessions.length === 0 && (
                    <li className="px-2.5 py-1.5 text-[13px] text-ink-faint">No sessions yet.</li>
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
                        <Avatar name={m.name} hue={m.avatarHue} size="sm" dim={!online.has(m.userId)} />
                        <span
                          className={
                            "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-surface " +
                            (online.has(m.userId) ? "bg-go" : "bg-ink-faint")
                          }
                        />
                      </span>
                      <span className="truncate text-[13px] font-semibold text-ink-soft">{m.name}</span>
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
          </nav>
        )}

        <main className="relative min-w-0 flex-1">{children}</main>
      </div>

      {who && members && (
        <MemberCard
          member={members.find((m) => m.userId === who)!}
          isYou={me?.id === who}
          activeSessionId={activeSessionId}
          onClose={() => setWho(null)}
        />
      )}
    </div>
  );
}
