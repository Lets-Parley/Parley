import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, type Deck } from "../lib/api";
import { buttonDanger, buttonQuiet, inputClass, labelClass } from "./Modal";
import { decksApi } from "../lib/paths";
import { useToast } from "../lib/ui";

/**
 * A space's saved decks: the card sets its facilitators can start a session
 * from, on top of the four built-ins.
 *
 * A deck is a template, never a reference. A session copies the cards it was
 * created with into its own config, so renaming, rewriting or deleting a row
 * here cannot change what a room already dealing those cards offers — which is
 * what makes editing safe enough to put on the settings page at all, and what
 * the delete copy says out loud.
 *
 * Members see the list and owners see the controls. Hiding a button is a
 * courtesy: the server answers 403 to a member who reaches the route anyway.
 */
export function DecksPanel({
  org,
  slug,
  canManage,
  onError,
}: {
  org: string;
  slug: string;
  canManage: boolean;
  onError: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const say = useToast();
  /** The row being edited, "" for the new-deck form, null for neither. */
  const [editing, setEditing] = useState<Deck | "" | null>(null);
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState(false);

  const decks = useQuery({
    queryKey: ["decks", org, slug],
    queryFn: () => api<Deck[]>("GET", decksApi(org, slug)),
    retry: false,
  });

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      await qc.invalidateQueries({ queryKey: ["decks", org, slug] });
      setEditing(null);
      setConfirming("");
      say(done);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const rows = decks.data ?? [];

  return (
    <section className="mt-6 rounded-card border border-line bg-surface px-5 py-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">Decks</h2>
      <p className="mt-1 text-[13px] text-ink-soft text-pretty">
        Card sets this space can start a session with, alongside the four
        built-in decks.
      </p>

      {decks.isLoading ? (
        <p className="mt-3 text-[13px] text-ink-faint">Counting the cards…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-faint">
          No decks of your own yet — the built-in four are always on offer.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold">{d.name}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {d.cards.map((c) => (
                    <span
                      key={c}
                      className="flex h-7 min-w-5 items-center justify-center rounded-[4px] border border-line bg-surface-hi px-1 font-mono text-[0.65rem]"
                    >
                      {c}
                    </span>
                  ))}
                </span>
              </span>
              {d.ordinal && (
                <span className="shrink-0 rounded-chip bg-felt-deep px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  Ordinal
                </span>
              )}
              {canManage && (
                <>
                  <button
                    className={buttonQuiet}
                    disabled={busy}
                    aria-label={`Edit: ${d.name}`}
                    onClick={() => {
                      setConfirming("");
                      setEditing(d);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className={buttonQuiet}
                    disabled={busy}
                    aria-label={`Delete: ${d.name}`}
                    onClick={() => {
                      setEditing(null);
                      setConfirming(d.id);
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
              {confirming === d.id && (
                <div className="w-full">
                  <p className="text-[13px] text-ink-soft text-pretty">
                    Delete {d.name}? Sessions already created keep their cards —
                    only this template goes.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      className={buttonDanger + " disabled:opacity-50"}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api("DELETE", `${decksApi(org, slug)}/${d.id}`),
                          `${d.name} is no longer on offer`,
                        )
                      }
                    >
                      Delete deck
                    </button>
                    <button className={buttonQuiet} disabled={busy} onClick={() => setConfirming("")}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage &&
        (editing !== null ? (
          <DeckForm
            key={editing ? editing.id : "new"}
            deck={editing || null}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(name, cards, ordinal) =>
              run(
                () =>
                  editing
                    ? api("PATCH", `${decksApi(org, slug)}/${editing.id}`, { name, cards, ordinal })
                    : api("POST", decksApi(org, slug), { name, cards, ordinal }),
                editing ? `${name} updated` : `${name} is ready to deal`,
              )
            }
          />
        ) : (
          <button className={buttonQuiet + " mt-3"} onClick={() => setEditing("")}>
            New deck
          </button>
        ))}
    </section>
  );
}

/**
 * One deck being written. Cards are typed as a list because that is how people
 * say a deck out loud; the server owns every rule about what is legal in it, so
 * this splits and trims and then lets the answer speak for itself rather than
 * keeping a second copy of the rules that could drift from the first.
 */
function DeckForm({
  deck,
  busy,
  onSave,
  onCancel,
}: {
  deck: Deck | null;
  busy: boolean;
  onSave: (name: string, cards: string[], ordinal: boolean) => void;
  onCancel: () => void;
}) {
  const nameId = useId();
  const cardsId = useId();
  const [name, setName] = useState(deck?.name ?? "");
  const [cards, setCards] = useState((deck?.cards ?? []).join(", "));
  const [ordinal, setOrdinal] = useState(deck?.ordinal ?? false);

  const list = cards
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(name.trim(), list, ordinal);
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-card border border-line bg-surface-hi px-4 py-3">
      <label className={labelClass + " mt-0"} htmlFor={nameId}>
        Deck name
      </label>
      <input
        id={nameId}
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={64}
        autoFocus
      />
      <label className={labelClass} htmlFor={cardsId}>
        Cards, separated by commas
      </label>
      <input
        id={cardsId}
        className={inputClass}
        value={cards}
        onChange={(e) => setCards(e.target.value)}
        placeholder="1, 2, 3, 5, 8"
      />
      <p className="mt-2 text-[12px] text-ink-faint text-pretty">
        ? and coffee are always dealt — leave them out.
      </p>
      <label className="mt-3 flex items-start gap-3 text-sm text-ink-soft">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={ordinal}
          onChange={(e) => setOrdinal(e.target.checked)}
        />
        <span>
          <span className="block font-semibold text-ink">These cards are an order, not numbers</span>
          <span className="mt-0.5 block text-[13px] text-ink-faint">
            Like T-shirt sizes. A round on an ordinal deck reports the mode and
            the range instead of an average.
          </span>
        </span>
      </label>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="submit" className={buttonQuiet} disabled={busy || !name.trim() || list.length === 0}>
          Save deck
        </button>
        <button type="button" className={buttonQuiet} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
