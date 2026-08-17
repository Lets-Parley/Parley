import { useParams } from "react-router-dom";
import { useSession } from "../lib/useSession";
import { useMe, NameGate } from "../components/NameGate";
import { PokerRoom } from "./PokerRoom";
import { StandupRoom } from "./StandupRoom";

export function SessionPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const session = useSession(id);

  if (me.isLoading || session.isLoading) {
    return <p className="p-8 text-center text-ink-faint">Pulling up a chair…</p>;
  }
  if (me.data === null) {
    return <NameGate onDone={() => session.refetch()} />;
  }
  if (session.isError || !session.data || !me.data) {
    return (
      <p className="p-8 text-center text-ink-soft">
        This session doesn't exist, or you're not a member of its space. Ask a
        teammate for the space link to join first.
      </p>
    );
  }
  if (session.data.kind === "poker") {
    return <PokerRoom env={session.data} me={me.data} status={session.status} />;
  }
  return <StandupRoom env={session.data} me={me.data} status={session.status} />;
}
