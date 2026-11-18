import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AsyncDigest } from "../components/AsyncDigest";
import { DeadEnd } from "../components/DeadEnd";
import { endedAtText } from "../components/EndedBanner";
import { Pending } from "../components/Pending";
import { api, type Envelope } from "../lib/api";
import { safeDisplayName } from "../lib/displayName";
import { useDocumentTitle } from "../lib/ui";
import type { StandupEntry } from "./StandupRoom";

export function StandupSummaryPage({ id }: { id: string }) {
  const encodedId = encodeURIComponent(id);
  // A room socket records attendance. The summary only uses the protected read.
  const summary = useQuery({
    queryKey: ["standup-summary", id],
    queryFn: () => api<Envelope>("GET", `/api/sessions/${encodedId}`),
    gcTime: 0,
    retry: false,
  });
  const env = summary.data;
  const endedAt = !summary.isError && env?.kind === "standup" && !env.kindUnavailable ? env.endedAt : null;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (endedAt) heading.current?.focus();
  }, [endedAt]);
  useDocumentTitle(endedAt ? `${env?.title} summary - Parley` : undefined);

  if (summary.isPending) return <Pending>Opening the summary…</Pending>;
  if (summary.isError || !env || env.kind !== "standup" || env.kindUnavailable) {
    return <DeadEnd title="Summary unavailable" why="Check that you have access to this standup and try again." home={false} />;
  }
  const back = (
    <Link to={`/session/${encodedId}`} className="inline-flex min-h-11 items-center font-bold text-accent underline underline-offset-4">
      Back to the room
    </Link>
  );
  if (!endedAt) {
    return (
      <DeadEnd title="Summary unavailable" why="The summary is available after the standup ends." home={false}>
        {back}
      </DeadEnd>
    );
  }

  const { entries } = env.state as unknown as { entries: StandupEntry[] };
  const skipped = entries.filter((entry) => entry.skipped).map((entry) => {
    const person = env.participants.find((p) => p.userId === entry.userId);
    const name = safeDisplayName(person?.name || entry.name || "Someone");
    return person?.guest ? `${name} (guest)` : name;
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-5 p-6 sm:p-10">
      <header>
        <h1 ref={heading} tabIndex={-1} className="font-display text-3xl wrap-anywhere">{env.title}</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Standup summary · Ended <time dateTime={endedAt}>{endedAtText(endedAt)}</time>
        </p>
      </header>
      <AsyncDigest entries={entries.filter((entry) => !entry.skipped)} participants={env.participants} ended />
      {skipped.length > 0 && (
        <p className="text-sm text-ink-soft"><strong>Skipped:</strong> <span>{skipped.join(", ")}</span></p>
      )}
      <div>{back}</div>
    </main>
  );
}
