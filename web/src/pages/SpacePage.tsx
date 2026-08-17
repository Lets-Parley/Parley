import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SessionSummary, type SpaceView } from "../lib/api";
import { useMe, NameGate } from "../components/NameGate";
import { Avatar } from "../components/Avatar";
import { buttonPrimary, inputClass } from "../components/Modal";

const deckLabels: Record<string, string> = {
  fibonacci: "Fibonacci (1–34)",
  "modified-fibonacci": "Modified Fibonacci (0–100)",
  tshirt: "T-shirt sizes",
  "powers-of-2": "Powers of 2",
};

export function SpacePage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [needName, setNeedName] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [deck, setDeck] = useState("fibonacci");
  const [kind, setKind] = useState("poker");

  const space = useQuery({
    queryKey: ["space", slug],
    queryFn: () => api<SpaceView>("GET", `/api/spaces/${slug}`),
    retry: false,
  });

  async function doJoin() {
    try {
      await api("POST", `/api/spaces/${slug}/join`);
      qc.invalidateQueries({ queryKey: ["space", slug] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join.");
    }
  }

  function join() {
    if (!me.data) {
      setNeedName(true);
      return;
    }
    doJoin();
  }

  async function createSession(e: FormEvent) {
    e.preventDefault();
    try {
      const sess = await api<SessionSummary>("POST", `/api/spaces/${slug}/sessions`, {
        kind,
        title,
        config: kind === "poker" ? { deck } : {},
      });
      navigate(`/session/${sess.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the session.");
    }
  }

  if (space.isLoading) return <p className="p-8 text-center text-ink-faint">Finding the table…</p>;
  if (space.isError || !space.data) {
    return <p className="p-8 text-center text-ink-soft">No space here. Check the link with your team.</p>;
  }

  const sp = space.data;
  const isMember = sp.members !== undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 p-6">
      <header>
        <Link to="/" className="text-sm font-bold text-accent hover:underline">← Parley</Link>
        <h1 className="font-display text-4xl font-semibold">{sp.name}</h1>
        <p className="font-mono text-sm text-ink-faint">/s/{sp.slug}</p>
      </header>

      {!isMember ? (
        <section className="flex flex-col items-start gap-3 rounded-panel bg-surface p-6 shadow-rest">
          <p className="text-ink-soft">You've been invited to this space. Pull up a chair to see who's here.</p>
          <button className={buttonPrimary} onClick={join}>Join {sp.name}</button>
          {error && <p className="font-bold text-stop">{error}</p>}
        </section>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-2">
            {sp.members!.map((m) => (
              <span key={m.userId} className="flex items-center gap-1.5 rounded-pill bg-surface py-1 pl-1 pr-3 shadow-rest">
                <Avatar name={m.name} hue={m.avatarHue} size="sm" spectator={m.spectator} />
                <span className="text-sm font-bold">{m.name}</span>
              </span>
            ))}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">Sessions</h2>
            <ul className="flex flex-col gap-2">
              {(sp.sessions ?? []).map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/session/${s.id}`}
                    className="flex items-center gap-3 rounded-chip border border-line bg-surface p-3 shadow-rest transition hover:shadow-lift"
                  >
                    <span className="font-display text-lg">{s.kind === "poker" ? "🂠" : "☀"}</span>
                    <span className="flex-1 truncate font-bold">{s.title}</span>
                    {s.endedAt && <span className="text-xs font-bold uppercase text-ink-faint">ended</span>}
                  </Link>
                </li>
              ))}
              {(sp.sessions ?? []).length === 0 && (
                <li className="rounded-chip border border-dashed border-line p-4 text-center text-sm text-ink-faint">
                  No sessions yet — deal one below.
                </li>
              )}
            </ul>
          </section>

          <section className="rounded-panel bg-surface p-6 shadow-rest">
            <h2 className="mb-3 text-lg font-bold">New session</h2>
            <form onSubmit={createSession} className="flex flex-col gap-3 sm:flex-row">
              <input
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sprint 12 estimation"
                maxLength={200}
              />
              <select className={inputClass + " sm:w-40"} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="poker">Poker</option>
                <option value="standup">Standup</option>
              </select>
              {kind === "poker" && (
                <select className={inputClass + " sm:w-56"} value={deck} onChange={(e) => setDeck(e.target.value)}>
                  {Object.entries(deckLabels).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              )}
              <button type="submit" className={buttonPrimary} disabled={!title.trim()}>Deal</button>
            </form>
            {error && <p className="mt-2 font-bold text-stop">{error}</p>}
          </section>
        </>
      )}

      {needName && (
        <NameGate
          onDone={() => {
            setNeedName(false);
            doJoin();
          }}
        />
      )}
    </main>
  );
}
