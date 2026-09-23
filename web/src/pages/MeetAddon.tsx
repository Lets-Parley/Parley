import { useCallback, useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  action,
  api,
  ApiError,
  errorText,
  setBearer,
  type Envelope,
  type Me,
  type Membership,
  type SpaceView,
} from "../lib/api";
import {
  connectMeet,
  MAIN_STAGE_PATH,
  newVerifier,
  storedToken,
  storeToken,
  type MeetMainStage,
  type MeetSidePanel,
} from "../lib/meet";
import { spaceApi } from "../lib/paths";
import { useSession } from "../lib/useSession";
import { PresentPage } from "./PresentPage";

const button =
  "rounded-chip bg-accent px-4 py-2.5 text-[13px] font-bold text-accent-ink disabled:opacity-50";
const row = "w-full rounded-panel border border-line bg-surface px-3 py-2 text-left";

/**
 * The embedded token for this frame, read once from sessionStorage and pushed
 * into the api client before anything fetches. Cookies never reach a framed
 * page, so this is the only way it is signed in.
 *
 * The bearer is module state in the api client, so it has two jobs here.
 * Installed during render, by the state initializer: children's effects run
 * before their parent's, so a bearer set by an ordinary effect in this hook
 * would let a child's first fetch go out cookie-mode. And taken back out when
 * the page unmounts, by the layout effect's cleanup, so nothing rendered
 * afterwards inherits it. It is a layout effect rather than a passive one
 * because StrictMode's simulated remount re-runs every layout effect before
 * any passive one: the bearer is back before a child's effect fetches again.
 */
function useEmbedToken(): [string, (t: string) => void] {
  const [token, setToken] = useState(() => {
    const t = storedToken();
    setBearer(t);
    return t;
  });
  useLayoutEffect(() => {
    setBearer(token);
    return () => setBearer("");
  }, [token]);
  const set = useCallback((t: string) => {
    storeToken(t);
    setBearer(t);
    setToken(t);
  }, []);
  return [token, set];
}

/** The shape of every session id the server mints: a UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The room id the side panel handed to Meet, or "" for anything else.
 * additionalData reaches the main stage from whoever started the activity, so
 * it is input, not configuration: only a string shaped like a session id ever
 * becomes part of a request path.
 */
function sharedSessionId(additionalData: string | undefined): string {
  try {
    const id = (JSON.parse(additionalData || "{}") as { sessionId?: unknown } | null)?.sessionId;
    return typeof id === "string" && SESSION_ID.test(id) ? id : "";
  } catch {
    return "";
  }
}

/**
 * Sign-in from inside a frame. The handoff is opened as soon as this mounts,
 * so the click does nothing but open the sign-in page: a popup opened after an
 * await is blocked. The person types the code shown here on that page.
 */
function MeetSignIn({ onToken }: { onToken: (token: string) => void }) {
  const [handoff, setHandoff] = useState<{ displayCode: string; signinPath: string } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    void (async () => {
      try {
        const { verifier, challenge } = await newVerifier();
        const h = await api<{ displayCode: string; signinPath: string }>("POST", "/api/embed/handoff", {
          provider: "meet",
          challenge,
        });
        if (stop) return;
        setHandoff(h);
        const poll = async () => {
          if (stop) return;
          try {
            const res = await api<{ token?: string }>("POST", "/api/embed/session", { verifier });
            if (res?.token) return onToken(res.token);
          } catch (e) {
            if (!stop) setError(errorText(e));
            return;
          }
          timer = window.setTimeout(poll, 2000);
        };
        timer = window.setTimeout(poll, 2000);
      } catch (e) {
        if (!stop) setError(errorText(e));
      }
    })();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [onToken]);

  if (error) return <p role="alert">{error} Reload the add-on to try again.</p>;
  if (!handoff) return <p className="text-ink-faint">Getting a sign-in code…</p>;
  const url = `${location.origin}${handoff.signinPath}`;
  return (
    <section className="flex flex-col gap-3">
      <h1 className="font-display text-xl font-bold">Sign in to Parley</h1>
      <p>
        Your code is <strong className="font-mono text-lg">{handoff.displayCode}</strong>. Type it on the
        page that opens.
      </p>
      <button
        type="button"
        className={button}
        onClick={() => {
          // Synchronous in the click, or the popup blocker takes it. The new
          // tab gets no handle on this frame: it is an ordinary Parley page
          // and has no reason to reach back into Meet.
          const tab = window.open(handoff.signinPath, "_blank");
          if (tab) tab.opener = null;
          setBlocked(!tab);
        }}
      >
        Sign in
      </button>
      {blocked && (
        <p>
          Your browser blocked the new tab. Open <span className="break-all font-mono">{url}</span> in a
          tab yourself and type the code there.
        </p>
      )}
    </section>
  );
}

/** Google Meet's side panel: sign in, pick a room, vote. */
export function MeetSidePanel() {
  const [token, setToken] = useEmbedToken();
  const [client, setClient] = useState<MeetSidePanel | null>(null);
  useEffect(() => {
    connectMeet("sidepanel").then(setClient, () => setClient(null));
  }, []);
  return (
    <main className="flex min-h-dvh flex-col gap-4 p-4 text-ink">
      {token ? <Rooms client={client} onSignedOut={() => setToken("")} /> : <MeetSignIn onToken={setToken} />}
    </main>
  );
}

function Rooms({ client, onSignedOut }: { client: MeetSidePanel | null; onSignedOut: () => void }) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("GET", "/api/me") });
  const spaces = useQuery({
    queryKey: ["spaces"],
    queryFn: () => api<Membership[]>("GET", "/api/spaces"),
    enabled: !!me.data,
  });
  const [space, setSpace] = useState<Membership | null>(null);
  const [sessionId, setSessionId] = useState("");
  const expired = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);

  if (!me.data) return <p className="text-ink-faint">Loading…</p>;
  if (sessionId)
    return (
      <>
        <button type="button" className="self-start underline" onClick={() => setSessionId("")}>
          Back to rooms
        </button>
        <Room id={sessionId} me={me.data} client={client} />
      </>
    );
  if (space)
    return (
      <>
        <button type="button" className="self-start underline" onClick={() => setSpace(null)}>
          All spaces
        </button>
        <Space space={space} onPick={setSessionId} />
      </>
    );
  return (
    <section className="flex flex-col gap-2">
      <h1 className="font-display text-xl font-bold">Your spaces</h1>
      {spaces.data?.length === 0 && <p>You are not in any space yet. Join one from Parley in a browser tab.</p>}
      <ul className="flex flex-col gap-2">
        {spaces.data?.map((s) => (
          <li key={`${s.orgSlug}/${s.slug}`}>
            <button type="button" className={row} onClick={() => setSpace(s)}>
              {s.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Space({ space, onPick }: { space: Membership; onPick: (id: string) => void }) {
  const qc = useQueryClient();
  const key = ["space", space.orgSlug, space.slug];
  const view = useQuery({ queryKey: key, queryFn: () => api<SpaceView>("GET", spaceApi(space.orgSlug, space.slug)) });
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  if (!view.data) return <p className="text-ink-faint">Loading…</p>;

  // The same door as the Parley tab: a non-member presents the passcode.
  if (!view.data.members) {
    const join = async (e: FormEvent) => {
      e.preventDefault();
      try {
        await api("POST", `${spaceApi(space.orgSlug, space.slug)}/join`, { passcode });
        await qc.invalidateQueries({ queryKey: key });
      } catch (err) {
        setError(errorText(err));
      }
    };
    return (
      <form className="flex flex-col gap-2" onSubmit={join}>
        <h1 className="font-display text-xl font-bold">{view.data.name}</h1>
        <label htmlFor="meet-passcode">Passcode</label>
        <input
          id="meet-passcode"
          className="rounded-chip border border-line bg-surface px-3 py-2"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button type="submit" className={button}>
          Join
        </button>
      </form>
    );
  }
  const live = (view.data.sessions ?? []).filter((s) => !s.endedAt);
  return (
    <section className="flex flex-col gap-2">
      <h1 className="font-display text-xl font-bold">{view.data.name}</h1>
      {live.length === 0 && <p>No room is open in this space.</p>}
      <ul className="flex flex-col gap-2">
        {live.map((s) => (
          <li key={s.id}>
            <button type="button" className={row} onClick={() => onPick(s.id)}>
              {s.title} <span className="text-ink-faint">· {s.kind}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Room({ id, me, client }: { id: string; me: Me; client: MeetSidePanel | null }) {
  const session = useSession(id, true, undefined, me.id);
  const env = session.data;
  if (!env) return <p className="text-ink-faint">{session.isLoading ? "Loading…" : "This room can't be shown."}</p>;
  const facilitator = env.facilitatorId === me.id;
  return (
    <section className="flex flex-col gap-3">
      <h1 className="font-display text-xl font-bold">{env.title}</h1>
      {facilitator && client && (
        <button
          type="button"
          className={button}
          onClick={() =>
            void client.startActivity({
              mainStageUrl: location.origin + MAIN_STAGE_PATH,
              additionalData: JSON.stringify({ sessionId: id }),
            })
          }
        >
          Show on main stage
        </button>
      )}
      {env.kind === "poker" ? (
        <VotePad env={env} />
      ) : (
        <a className="underline" href={`/session/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">
          Open this room in Parley
        </a>
      )}
    </section>
  );
}

/** A compact vote pad: the current story and the deck, nothing else. */
function VotePad({ env }: { env: Envelope }) {
  const st = env.state;
  const story = st.stories.find((s) => s.id === st.currentStoryId);
  const [picked, setPicked] = useState<{ story: string; value: string } | null>(null);
  const [error, setError] = useState("");
  if (!story) return <p>Waiting for the facilitator to pick a story.</p>;
  const mine = picked?.story === story.id ? picked.value : "";
  const vote = async (value: string) => {
    setError("");
    try {
      await action(env.id, "vote", { storyId: story.id, value });
      setPicked({ story: story.id, value });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <h2 className="text-lg font-bold">{story.title || story.ref || "Ad hoc round"}</h2>
      {env.revealed ? (
        <p>Votes are revealed{story.estimate ? ` — estimate ${story.estimate}` : ""}.</p>
      ) : (
        <div role="group" aria-label="Your vote" className="grid grid-cols-4 gap-2">
          {st.deck.values.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={mine === v}
              className="rounded-card border border-line bg-surface py-3 font-mono aria-pressed:bg-accent aria-pressed:text-accent-ink"
              onClick={() => void vote(v)}
            >
              {v}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <p className="text-sm text-ink-soft">
        {story.votedUserIds.length} of {env.participants.filter((p) => !p.spectator).length} voted
      </p>
    </>
  );
}

/** Google Meet's main stage: the presenter view of the room the facilitator shared. */
export function MeetMainStage() {
  const [token, setToken] = useEmbedToken();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    connectMeet("mainstage")
      .then((c: MeetMainStage | null) => c?.getActivityStartingState())
      .then((s) => setSessionId(sharedSessionId(s?.additionalData)))
      .catch(() => setSessionId(""));
  }, []);
  if (!token)
    return (
      <main className="flex min-h-dvh items-center justify-center p-8">
        <MeetSignIn onToken={setToken} />
      </main>
    );
  if (sessionId === null) return <p className="p-8 text-center text-ink-faint">Pulling up a chair…</p>;
  if (!sessionId)
    return (
      <p className="p-8 text-center text-ink-faint">
        No room was shared to the main stage. Pick one in the Parley side panel and show it again.
      </p>
    );
  return <PresentPage id={sessionId} />;
}
