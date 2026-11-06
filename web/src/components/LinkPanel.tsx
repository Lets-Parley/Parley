import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api";
import { LINK_REDEMPTION_CAP, linkUrl, type MintedLink, type SessionLink } from "../lib/links";
import { useCopy } from "../lib/ui";
import { buttonPrimary, buttonQuiet, inputClass, labelClass } from "./Modal";

/** When a link dies, in the reader's own locale. */
function expiryWord(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "soon" : at.toLocaleString();
}

/**
 * The facilitator's guest links for one room: mint one, copy it, watch how much
 * of its cap it has spent, revoke it.
 *
 * There is no expiry picker and no label field. One lifetime and one cap are
 * server constants — a chooser here would be a second, softer copy of a rule
 * the server already owns.
 */
export function LinkPanel({ sessionId, ended }: { sessionId: string; ended: boolean }) {
  const qc = useQueryClient();
  const copy = useCopy();
  const [minted, setMinted] = useState<MintedLink[]>([]);
  const [error, setError] = useState("");
  const fieldId = useId();

  const links = useQuery({
    queryKey: ["links", sessionId],
    queryFn: () => api<{ links: SessionLink[] }>("GET", `/api/sessions/${sessionId}/links`),
    retry: false,
  });
  const live = (links.data?.links ?? []).filter((l) => !l.revokedAt);

  const refresh = () => qc.invalidateQueries({ queryKey: ["links", sessionId] });

  const create = useMutation({
    // The plain token comes back exactly once and is never stored: if this
    // reply is lost, the link is unrecoverable and has to be revoked.
    mutationFn: () => api<MintedLink>("POST", `/api/sessions/${sessionId}/links`),
    onSuccess: (link) => {
      setError("");
      setMinted((current) => [...current, link]);
      refresh();
    },
    onError: (e) => setError(errorText(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/sessions/${sessionId}/links/${id}`),
    onSuccess: (_r, id) => {
      setError("");
      setMinted((current) => current.filter((link) => link.id !== id));
      refresh();
    },
    onError: (e) => setError(errorText(e)),
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft text-pretty">
        A guest link seats whoever opens it in this room only — no space, no
        other rooms, and never as facilitator. The link is the whole credential,
        so share it the way you would a room code.
      </p>

      <button
        className={minted.length ? buttonQuiet + " self-start" : buttonPrimary}
        disabled={ended || create.isPending}
        title={ended ? "This session has ended — new links can't be created." : undefined}
        onClick={() => create.mutate()}
      >
        {create.isPending ? "Creating…" : minted.length ? "Create another guest link" : "Create a guest link"}
      </button>

      {minted.map((link, index) => (
        <div key={link.id} className="flex flex-col gap-2 rounded-card border border-line bg-felt-deep p-3">
          <label htmlFor={`${fieldId}-${link.id}`} className={labelClass + " mt-0"}>
            Guest link
          </label>
          {/* Shown once. Nothing stores the token, so this field is the only
              copy anyone will ever get of it. */}
          <input
            id={`${fieldId}-${link.id}`}
            className={inputClass}
            readOnly
            value={linkUrl(link.token)}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={index === minted.length - 1 ? buttonPrimary : buttonQuiet}
              onClick={() =>
                copy(linkUrl(link.token), "Guest link copied — it seats them in one click", setError)
              }
            >
              Copy link
            </button>
            <span className="text-[13px] text-ink-faint">
              Copy before closing this panel. Expires {expiryWord(link.expiresAt)}.
            </span>
          </div>
        </div>
      ))}

      {error && (
        <p role="alert" className="text-sm font-bold text-stop">
          {error}
        </p>
      )}

      {links.isPending && <p role="status" className="text-sm text-ink-faint">Loading guest links…</p>}
      {links.error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-stop">
          <span>{errorText(links.error)}</span>
          <button type="button" className={buttonQuiet} disabled={links.isFetching} onClick={() => void links.refetch()}>
            Retry links
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {live.map((l, i) => (
          <li
            key={l.id}
            className="flex flex-wrap items-center gap-3 rounded-card border border-line px-3 py-2"
          >
            <span className="min-w-0 flex-1 text-[13px]">
              <span className="font-semibold">Link {i + 1}</span>
              <span className="text-ink-soft">
                {" · "}
                {l.redemptions} of {LINK_REDEMPTION_CAP} used · expires {expiryWord(l.expiresAt)}
              </span>
            </span>
            <button
              className={buttonQuiet}
              aria-label={`Revoke link ${i + 1}`}
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(l.id)}
            >
              Revoke
            </button>
          </li>
        ))}
        {links.isSuccess && live.length === 0 && (
          <li className="text-[13px] text-ink-faint">
            No guest links for this room yet.
          </li>
        )}
      </ul>
    </div>
  );
}
