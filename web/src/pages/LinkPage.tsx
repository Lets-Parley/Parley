import { useEffect, useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, errorText } from "../lib/api";
import {
  clearLinkToken,
  readLinkToken,
  rememberLinkGuest,
  type Redemption,
} from "../lib/links";
import { Modal, buttonPrimary, inputClass, labelClass } from "../components/Modal";

/**
 * Expired, revoked, exhausted and simply wrong are one 404 on the wire, and
 * this says one thing back. Telling a holder "expired" rather than "wrong"
 * would confirm the token was real, which is a probe worth answering with
 * nothing.
 */
const DEAD_LINK = "This link no longer works. Ask whoever shared it for a new one.";

/**
 * The door a signed link opens: a name, then straight into the one room the
 * link is bound to. The token arrives in the fragment and is read exactly once.
 */
export function LinkPage() {
  const navigate = useNavigate();
  // Read pure, so React's double-invocation of an initialiser cannot lose the
  // token; the wipe below is idempotent and lives in an effect instead.
  const [token] = useState(readLinkToken);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  useEffect(clearLinkToken, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // One redemption spends one of the link's few. A second click while the
    // first is in flight would burn one for nothing.
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<Redemption>("POST", "/api/links/redeem", {
        token,
        name: name.trim(),
      });
      rememberLinkGuest({ sessionId: r.sessionId, me: r.me, expiresAt: r.expiresAt });
      navigate(`/session/${r.sessionId}`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? DEAD_LINK : errorText(err));
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-display text-2xl">No seat at this table</p>
        <p role="alert" className="max-w-sm text-sm text-ink-soft text-pretty">
          {DEAD_LINK}
        </p>
      </div>
    );
  }

  return (
    <Modal title="What should we call you?">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft text-pretty">
          You've been invited to one room by a guest link. It is the name your
          team sees at the table — no account, no email, and your seat ends when
          you close this tab.
        </p>
        <div>
          <label htmlFor={fieldId} className={labelClass + " mt-0"}>
            Your name
          </label>
          <input
            id={fieldId}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={64}
            aria-describedby={error ? errorId : undefined}
            autoFocus
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-sm font-bold text-stop">
            {error}
          </p>
        )}
        <button type="submit" className={buttonPrimary} disabled={busy || !name.trim()}>
          Take a seat
        </button>
      </form>
    </Modal>
  );
}
