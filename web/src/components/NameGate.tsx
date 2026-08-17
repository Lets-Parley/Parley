import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Me } from "../lib/api";
import { Modal, buttonPrimary, inputClass } from "./Modal";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<Me>("GET", "/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

// Asks for a display name the first time one is needed, then gets out of the way.
export function NameGate({ onDone }: { onDone: (me: Me) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const me = await api<Me>("POST", "/api/me", { name });
      qc.setQueryData(["me"], me);
      onDone(me);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your name.");
    }
  }

  return (
    <Modal title="What should we call you?">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={64}
          autoFocus
        />
        {error && <p className="text-sm font-bold text-stop">{error}</p>}
        <button type="submit" className={buttonPrimary} disabled={!name.trim()}>
          Take a seat
        </button>
      </form>
    </Modal>
  );
}
