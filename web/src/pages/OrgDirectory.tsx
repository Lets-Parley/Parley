import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, ApiError, errorText, type OrgSpacePage } from "../lib/api";
import { orgSpacesApi, spacePath } from "../lib/paths";
import { Logo, ThemeToggle } from "../components/AppShell";
import { NameGate } from "../components/NameGate";
import { buttonQuiet } from "../components/Modal";

/**
 * The org directory: how somebody finds their team's room without being sent
 * a link.
 *
 * It lists what the server decided this caller may see — every org-visible
 * space, plus the ones they already belong to — and nothing more. The page
 * never filters for privacy itself: a private space someone else keeps never
 * arrives here at all, so there is no client-side rule to get wrong.
 *
 * Each row is a link to the space rather than a join button. Being listed is
 * discovery, not entry: an open space admits an org member on arrival, and a
 * passcode-protected one puts them in front of its gate — both of which the
 * space page already knows how to do. The "Passcode" badge is the honest
 * warning that the second is what will happen.
 *
 * It arrives a page at a time, and the rest is asked for by a button rather
 * than by scrolling. An org that has been running for a year has more rooms
 * than anybody wants sent at once, and this is the page a new member is
 * pointed at from the landing page — the first thing they load and the one
 * most likely to be large. A button is the accessible half of that bargain:
 * it is in the tab order, it says what it does, and nothing loads because
 * somebody's finger slipped on a trackpad.
 */
export function OrgDirectory() {
  const { org = "" } = useParams();
  const spaces = useInfiniteQuery({
    queryKey: ["org-spaces", org],
    queryFn: ({ pageParam }) => api<OrgSpacePage>("GET", orgSpacesApi(org, pageParam)),
    initialPageParam: "",
    // The cursor is opaque and absent at the end of the list, which is what
    // tells react-query there is no further page to offer.
    getNextPageParam: (last: OrgSpacePage) => last.next || undefined,
    retry: false,
  });

  // This URL is the advertised address of the directory, so it is opened from
  // a bookmark or a pasted link by somebody with no session at all. A 401 is
  // not a failure to report — it is a missing identity, and "Try again" cannot
  // produce one. The rest of the app answers that with the gate, which either
  // asks for a name or hands over to the identity provider, so this does too.
  const needsIdentity = spaces.error instanceof ApiError && spaces.error.status === 401;

  // Rooms the caller is already in first: this page exists to get somebody
  // back to their table, and only then to show them what else is out there.
  // The server's order is by name, and this sort is stable, so a page loaded
  // later is appended inside its group rather than shuffling what is already
  // on screen.
  const rows = useMemo(() => {
    const all = (spaces.data?.pages ?? []).flatMap((page) => page.spaces);
    return [...all].sort((a, b) => Number(b.member) - Number(a.member));
  }, [spaces.data]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6">
      <div className="fixed right-4 top-4">
        <ThemeToggle />
      </div>

      <header className="flex items-center gap-3">
        <Link to="/" className="flex items-center gap-3 font-extrabold tracking-tight">
          <Logo size={20} />
          Parley
        </Link>
      </header>

      <h1 className="font-display text-3xl">Spaces in {org}</h1>

      {spaces.isLoading && (
        <div
          aria-hidden
          className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3"
        >
          <span className="h-9 rounded-panel bg-felt-deep" />
          <span className="h-9 w-2/3 rounded-panel bg-felt-deep" />
        </div>
      )}

      {needsIdentity && (
        <>
          <p className="text-ink-soft text-pretty">
            Sign in to see what {org} keeps here.
          </p>
          <NameGate
            because={`To see the spaces in ${org}:`}
            onDone={() => void spaces.refetch()}
          />
        </>
      )}

      {spaces.isError && !needsIdentity && (
        <p role="alert" className="flex items-center gap-3 font-bold text-stop">
          {errorText(spaces.error)}
          <button type="button" className={buttonQuiet} onClick={() => spaces.refetch()}>
            Try again
          </button>
        </p>
      )}

      {spaces.isSuccess && rows.length === 0 && (
        <p className="text-ink-soft text-pretty">
          Nothing here yet. Spaces show up once somebody in this org makes one
          visible to the org — until then, a link from a teammate is the way in.
        </p>
      )}

      {rows.length > 0 && (
        <ul
          aria-label={`Spaces in ${org}`}
          className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3 shadow-rest"
        >
          {rows.map((sp) => (
            <li key={sp.slug}>
              <Link
                to={spacePath(org, sp.slug)}
                className="flex items-center justify-between gap-3 rounded-panel px-3 py-2 font-bold hover:bg-felt-deep"
              >
                <span className="min-w-0 truncate">{sp.name}</span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-ink-faint">
                  {sp.member && <span>Joined</span>}
                  {sp.protected && <span>Passcode</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {spaces.hasNextPage && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={buttonQuiet}
            disabled={spaces.isFetchingNextPage}
            onClick={() => void spaces.fetchNextPage()}
          >
            {spaces.isFetchingNextPage ? "Loading more…" : "Show more spaces"}
          </button>
          {/* Said out loud, because appending rows below the fold is silent
              to somebody who cannot see the list grow. */}
          <span role="status" className="text-sm text-ink-faint">
            Showing {rows.length} so far
          </span>
        </div>
      )}

      <p className="text-sm text-ink-faint text-pretty">
        A space listed here is one the org can find. Finding it is not the same
        as getting in: a space with a passcode still asks for it, whoever you
        are.
      </p>
    </main>
  );
}
