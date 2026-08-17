import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SpaceView } from "../lib/api";
import { useMe, useAuthMode, NameGate } from "../components/NameGate";
import { Logo } from "../components/AppShell";
import { buttonPrimary, inputClass } from "../components/Modal";

export function Landing() {
  const navigate = useNavigate();
  const me = useMe();
  const mode = useAuthMode();
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
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-7 p-6 text-center">
      <div className="flex items-center gap-3">
        <Logo size={26} />
        <h1 className="text-4xl font-extrabold tracking-tight">Parley</h1>
      </div>
      <p className="max-w-md text-ink-soft text-pretty">
        Planning poker and daily standups for your team, at your table.
        {mode.data?.mode === "oidc"
          ? " Sign in with your usual account."
          : " Self-hosted, no accounts, no fuss."}
      </p>
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-panel border border-line bg-surface p-5 shadow-rest sm:flex-row"
      >
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your space, e.g. Platform Team"
          maxLength={64}
        />
        <button type="submit" className={buttonPrimary + " shrink-0"} disabled={!name.trim()}>
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
