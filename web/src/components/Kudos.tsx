import { useId, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Kudo, type Person } from "../lib/api";
import { Avatar } from "./Avatar";
import { buttonPrimary, buttonQuiet, inputClass, labelText } from "./Modal";
import { kudosApi } from "../lib/paths";
import { useToast } from "../lib/ui";

/** Matches maxKudoRunes in internal/api/kudos.go and the CHECK in 0033_kudos.sql. */
const MAX_RUNES = 280;

/**
 * How long ago, in the coarsest unit that still says something. A kudos wall is
 * read in order, so the exact minute matters far less than "this morning" —
 * and the machine-readable instant travels on the <time> element regardless.
 *
 * `now` is a parameter rather than a call to Date.now inside, so the behaviour
 * is testable without freezing the clock for the whole suite.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The kudos wall on a space: a form to thank somebody, and everything the
 * space has said, newest first.
 *
 * There is deliberately no count anywhere — not per person, not in the
 * heading. A number beside a name is a leaderboard however quietly it is
 * drawn, and the whole point of this surface is that thanking somebody is not
 * a scoreboard event.
 *
 * A kudo outlives the people in it: the recipient can leave the space and the
 * record stays. So no lookup here assumes a userId resolves to a current
 * member — an id with nobody behind it is named rather than left blank, which
 * is the case that would otherwise render an empty line or crash.
 */
export function Kudos({
  org,
  slug,
  members,
  meId,
}: {
  org: string;
  slug: string;
  /** The space roster, as SpacePage already has it. */
  members: Person[] | undefined;
  meId: string;
}) {
  const qc = useQueryClient();
  const say = useToast();
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** The kudo whose withdrawal has been asked about, "" for none. */
  const [confirming, setConfirming] = useState("");
  const headingId = useId();
  const countId = useId();

  const kudos = useQuery({
    queryKey: ["kudos", org, slug],
    queryFn: () => api<Kudo[]>("GET", kudosApi(org, slug)),
    retry: false,
  });

  const roster = useMemo(() => members ?? [], [members]);
  // Yourself is not a recipient — the server answers 400 — and neither is a
  // link guest, who may neither send nor receive.
  const candidates = useMemo(
    () => roster.filter((m) => m.userId !== meId && !m.guest),
    [roster, meId],
  );
  const byId = useMemo(() => new Map(roster.map((m) => [m.userId, m])), [roster]);
  const nameOf = (id: string) => byId.get(id)?.name ?? "Someone who has left";

  // Runes, not UTF-16 units: the handler counts runes, so a `maxLength` of 280
  // on the field would let an emoji-heavy kudo past the counter and straight
  // into a 400.
  const left = MAX_RUNES - [...text].length;
  const rows = kudos.data ?? [];

  async function give(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!to || !t || left < 0 || busy) return;
    setBusy(true);
    try {
      await api("POST", kudosApi(org, slug), { to, text: t });
      await qc.invalidateQueries({ queryKey: ["kudos", org, slug] });
      setText("");
      say(`Kudos sent to ${nameOf(to)}.`);
    } catch (err) {
      say(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    setBusy(true);
    try {
      await api("DELETE", `${kudosApi(org, slug)}/${id}`);
      await qc.invalidateQueries({ queryKey: ["kudos", org, slug] });
      setConfirming("");
      say("Kudos withdrawn.");
    } catch (err) {
      say(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="kudos"
      aria-labelledby={headingId}
      className="mt-8 rounded-card border border-line bg-surface px-5 py-4"
    >
      <h2 id={headingId} className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        Kudos
      </h2>
      <p className="mt-1 text-[13px] text-ink-soft text-pretty">
        Thank somebody by name. No meeting required, and nothing here is counted or ranked.
      </p>

      {candidates.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-faint">
          Nobody else is in this space yet — invite someone and you will have somebody to thank.
        </p>
      ) : (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={give}>
          <label className="flex flex-col gap-1">
            <span className={labelText}>To</span>
            {/* A native select: it is keyboard-operable, screen-reader
                announced and mobile-native for free, which a hand-rolled
                listbox would each have to earn back. */}
            <select
              className={inputClass}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="">Choose somebody</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            <span className={labelText}>For what</span>
            <input
              className={inputClass}
              value={text}
              aria-describedby={countId}
              aria-invalid={left < 0 || undefined}
              onChange={(e) => setText(e.target.value)}
              placeholder="What did they do?"
            />
          </label>
          <button
            type="submit"
            className={buttonPrimary}
            disabled={!to || !text.trim() || left < 0 || busy}
          >
            Give kudos
          </button>
          {/* The numeral is the only data in the line, so it alone is mono and
              tabular — the count must not jitter as it falls. */}
          <span
            id={countId}
            data-testid="kudos-left"
            className={`w-full text-[13px] ${left < 0 ? "text-stop" : "text-ink-faint"}`}
          >
            <span className="font-mono tabular-nums">{left}</span> characters left
          </span>
        </form>
      )}

      {kudos.isLoading ? (
        <p className="mt-3 text-[13px] text-ink-faint">Reading the wall…</p>
      ) : rows.length === 0 ? (
        <p data-testid="kudos-empty" className="mt-4 text-[13px] text-ink-faint text-pretty">
          No kudos yet. The first one is the hardest — say what somebody did and who did it.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-line">
          {rows.map((k) => (
            <li
              key={k.id}
              data-testid={`kudo-${k.id}`}
              className="flex flex-wrap items-start gap-3 py-3"
            >
              <Avatar
                name={nameOf(k.fromUserId)}
                hue={byId.get(k.fromUserId)?.avatarHue ?? 0}
                icon={byId.get(k.fromUserId)?.avatarIcon}
                size="sm"
                decorative
              />
              {/* min-w-0 is what actually lets the wrapping below happen: a
                  flex child defaults to min-content width, so an unbroken word
                  would otherwise widen the row past the panel. */}
              <span className="min-w-0 flex-1">
                <span data-testid="kudo-who" className="block break-words text-[13px] text-ink-soft">
                  <span className="font-semibold text-ink">{nameOf(k.fromUserId)}</span> thanked{" "}
                  <span className="font-semibold text-ink">{nameOf(k.toUserId)}</span>
                </span>
                <span data-testid="kudo-text" className="mt-0.5 block break-words text-[14px]">
                  {k.text}
                </span>
                <time dateTime={k.createdAt} className="mt-1 block text-[12px] text-ink-faint">
                  {ago(k.createdAt)}
                </time>
              </span>
              {/* Only the sender, matching the handler: everyone else gets a
                  403 there, so offering the control would be a lie. */}
              {k.fromUserId === meId &&
                (confirming === k.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => setConfirming("")}
                    >
                      Keep it
                    </button>
                    <button
                      type="button"
                      className={buttonQuiet}
                      disabled={busy}
                      onClick={() => void withdraw(k.id)}
                    >
                      Withdraw it
                    </button>
                  </span>
                ) : (
                  /* Nothing on the server undoes a withdrawal, so the first
                     click only asks. */
                  <button
                    type="button"
                    className={`${buttonQuiet} shrink-0`}
                    aria-label={`Withdraw: ${k.text}`}
                    onClick={() => setConfirming(k.id)}
                  >
                    Withdraw
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
