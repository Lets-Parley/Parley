import { useEffect, useRef, useState } from "react";
import type { Envelope } from "../lib/api";
import {
  CrashBreaker,
  createPluginBridge,
  currentTokens,
  pluginFramePath,
  PLUGIN_SANDBOX,
  type BridgeFailure,
  type PluginBridge,
} from "../lib/pluginBridge";

export type PluginSlot = "panel" | "room" | "toolbar" | "nav" | "export-menu";

export type PluginPanelProps = {
  name: string;
  version: string;
  /** What this install was granted. The bridge redacts against it. */
  grants: readonly string[];
  env?: Envelope;
  onAction: (action: string, payload: unknown) => Promise<unknown>;
  /**
   * True while a host modal is open. The frame is marked `inert` so focus
   * cannot tab underneath the overlay into content the user cannot see — the
   * platform attribute, not a hand-rolled focus trap.
   */
  modalOpen?: boolean;
  /** Nested poker panel vs the session's whole room vs host chrome. */
  slot?: PluginSlot;
  /** Injected in tests; one breaker per plugin in the app. */
  breaker?: CrashBreaker;
};

const breakers = new Map<string, CrashBreaker>();

function breakerFor(name: string): CrashBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CrashBreaker();
    breakers.set(name, b);
  }
  return b;
}

export function PluginPanel({
  name,
  version,
  grants,
  env,
  onAction,
  modalOpen = false,
  slot = "panel",
  breaker,
}: PluginPanelProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const bridge = useRef<PluginBridge | null>(null);
  const [failure, setFailure] = useState<BridgeFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const trip = breaker ?? breakerFor(name);
  const tripped = trip.open();
  const room = slot === "room";

  useEffect(() => {
    if (tripped) return;
    const target = frame.current?.contentWindow;
    if (!target) return;
    const b = createPluginBridge({
      target,
      grants,
      onAction,
      onFailure: (reason) => {
        setFailure(reason);
        // A handshake that never lands and a plugin that floods the port are
        // both this plugin failing, so both count towards its breaker.
        if (reason === "handshake-timeout" || reason === "flood") trip.crashed();
      },
    });
    bridge.current = b;
    return () => {
      bridge.current = null;
      b.close();
    };
    // A remount is exactly what a retry is, so `attempt` belongs here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, version, attempt, tripped]);

  // State is pushed from the react-query cache the room already keeps. There
  // is no second websocket, and nothing crosses that redactSession did not
  // build. Chrome with no session (org nav) has nothing to push.
  useEffect(() => {
    if (env) bridge.current?.sendState(env);
  }, [env]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    // `inert` is a platform attribute: the browser takes the subtree out of
    // the focus order and out of the accessibility tree, which a JS focus trap
    // in the parent document could not do to a cross-origin frame at all.
    el.toggleAttribute("inert", modalOpen);
  }, [modalOpen]);

  function retry() {
    trip.reset();
    setFailure(null);
    setAttempt((n) => n + 1);
  }

  if (tripped) {
    return (
      <Card title={`${name} is switched off`}>
        <p>
          It stopped responding several times in a row, so the panel is not loading it again. Nothing else in
          this room is affected.
        </p>
        <RetryButton onClick={retry} />
      </Card>
    );
  }

  return (
    <section
      aria-label={ariaLabel(name, slot)}
      className={room ? "flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col" : chromeClass(slot)}
    >
      {slot === "panel" && <h2 className="text-sm font-semibold text-ink-soft">{name}</h2>}
      {failure === "handshake-timeout" && (
        <Card title={`${name} did not start`}>
          <p>The panel loaded but the plugin never answered. It has not been given any data.</p>
          <RetryButton onClick={retry} />
        </Card>
      )}
      <iframe
        key={attempt}
        ref={frame}
        title={frameTitle(name, slot)}
        src={pluginFramePath(name, version)}
        sandbox={PLUGIN_SANDBOX}
        // referrerPolicy keeps the room URL out of a frame that has no
        // business knowing which room it is in beyond what the bridge tells it.
        referrerPolicy="no-referrer"
        className={`${frameClass(slot)} ${failure === "handshake-timeout" ? "hidden" : ""}`}
        onLoad={() => {
          bridge.current?.handshake();
          bridge.current?.sendTokens(currentTokens());
          if (env) bridge.current?.sendState(env);
        }}
      />
    </section>
  );
}

function ariaLabel(name: string, slot: PluginSlot): string {
  if (slot === "room") return `${name} room`;
  if (slot === "panel") return `${name} panel`;
  return `${name} ${slot}`;
}

function frameTitle(name: string, slot: PluginSlot): string {
  if (slot === "panel" || slot === "room") return `${name} plugin panel`;
  return `${name} plugin ${slot}`;
}

function chromeClass(slot: PluginSlot): string {
  if (slot === "panel") return "mt-6";
  if (slot === "nav") return "mt-3";
  return "shrink-0";
}

function frameClass(slot: PluginSlot): string {
  if (slot === "room") return "min-h-0 h-full w-full";
  if (slot === "toolbar") return "h-9 w-9 rounded-chip border border-line bg-surface";
  if (slot === "nav") return "h-24 w-full rounded-lg border border-line bg-surface";
  if (slot === "export-menu") return "h-9 w-28 rounded-chip border border-line bg-surface";
  return "h-64 w-full rounded-lg border border-line bg-surface";
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="status" className="mt-2 rounded-lg border border-line bg-surface p-4 text-sm text-ink-soft">
      <p className="font-medium text-ink">{title}</p>
      {children}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="mt-3 text-sm font-medium text-accent underline" onClick={onClick}>
      Try again
    </button>
  );
}
