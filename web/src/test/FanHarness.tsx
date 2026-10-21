import { useState } from "react";
import { api, type Envelope } from "../lib/api";
import { StoryTree, type StoryTreeProps } from "../components/StoryTree";

export function FanHarness({
  room,
  ...props
}: { room: Envelope } & Partial<Omit<StoryTreeProps, "env">>) {
  const [fetched, setFetched] = useState<Envelope | null>(null);
  const [undoSlot, setUndoSlot] = useState<HTMLElement | null>(null);
  const env = fetched && fetched.version > room.version ? fetched : room;
  return (
    <div data-fan-scope>
      <div data-fan-item="strip">
        <span data-fan-plate data-fan-origin />
        <span ref={setUndoSlot} />
      </div>
      <StoryTree
        parentId="parent"
        undoSlot={undoSlot}
        canEdit
        status="live"
        refresh={async () => {
          const next = await api<Envelope>("GET", `/api/sessions/${room.id}`);
          setFetched(next);
          return next;
        }}
        {...props}
        env={env}
      />
    </div>
  );
}
