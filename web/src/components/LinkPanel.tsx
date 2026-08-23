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
  const [minted, setMinted] = useState<MintedLink | null>(null);
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
      setMinted(link);
      refresh();
    },
    onError: (e) => setError(errorText(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/sessions/${sessionId}/links/${id}`),
    onSuccess: (_r, id) => {
      setError("");
      if (minted?.id === id) setMinted(null);
      refresh();
    },
    onError: (e) => setError(errorText(e)),
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft text-pretty">
        A guest link seats whoever opens it in this room only — no space, no
        other rooms, and never as facilitator. The link is the whole credential,
        so share it the way you would a passcode.
      </p>

      <button
        className={buttonPrimary}
        disabled={ended || create.isPending}
        title={ended ? "This session has ended — new links can't be created." : undefined}
        onClick={() => create.mutate()}
      >
        Create a guest link
      </button>

      {minted && (
        <div className="flex flex-col gap-2 rounded-card border border-line bg-felt-deep p-3">
          <label htmlFor={fieldId} className={labelClass + " mt-0"}>
            Guest link
          </label>
          {/* Shown once. Nothing stores the token, so this field is the only
              copy anyone will ever get of it. */}
          <input
            id={fieldId}
            className={inputClass}
            readOnly
            value={linkUrl(minted.token)}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={buttonQuiet}
              onClick={() =>
                copy(linkUrl(minted.token), "Guest link copied — it seats them in one click", setError)
              }
            >
              Copy link
            </button>
            <span className="text-[13px] text-ink-faint">
              Shown once — copy it now. Expires {expiryWord(minted.expiresAt)}.
            </span>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm font-bold text-stop">
          {error}
        </p>
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
        {live.length === 0 && (
          <li className="text-[13px] text-ink-faint">
            No guest links for this room yet.
          </li>
        )}
      </ul>
    </div>
  );
}
