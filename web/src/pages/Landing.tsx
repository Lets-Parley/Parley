import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SpaceView } from "../lib/api";
import { useMe, NameGate } from "../components/NameGate";
import { buttonPrimary, inputClass } from "../components/Modal";

export function Landing() {
  const navigate = useNavigate();
  const me = useMe();
  const [name, setName] = useState("");
  const [needName, setNeedName] = useState(false);
  const [error, setError] = useState("");

  async function doCreate() {
    try {
      const sp = await api<SpaceView>("POST", "/api/spaces", { name });
      navigate(`/s/${sp.slug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the space.");
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!me.data) {
      setNeedName(true);
      return;
    }
    doCreate();
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-8 p-6 text-center">
      <h1 className="font-display text-6xl font-semibold">Parley</h1>
      <p className="max-w-md text-ink-soft">
        Planning poker and daily standups for your team, at your table.
        Self-hosted, no accounts, no fuss.
      </p>
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3 rounded-panel bg-surface p-6 shadow-rest sm:flex-row">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your space, e.g. Platform Team"
          maxLength={64}
        />
        <button type="submit" className={buttonPrimary} disabled={!name.trim()}>
          Open a space
        </button>
      </form>
      {error && <p className="font-bold text-stop">{error}</p>}
      <p className="text-sm text-ink-faint">
        Got a link from a teammate? That link is your invite — just open it.
      </p>
      {needName && (
        <NameGate
          onDone={() => {
            setNeedName(false);
            doCreate();
          }}
        />
      )}
    </main>
  );
}
