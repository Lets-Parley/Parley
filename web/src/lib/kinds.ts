import type { ComponentType } from "react";
import type { Envelope, Me } from "./api";
import type { ConnectionStatus } from "./socket";
import { PokerRoom } from "../pages/PokerRoom";
import { StandupRoom } from "../pages/StandupRoom";

export type RoomProps = { env: Envelope; me: Me; status?: ConnectionStatus };

/** One create-dialog field: a fixed set of options, one of them the default. */
export type FieldSpec = {
  key: string;
  label: string;
  options: { id: string; name: string; sample: string[] }[];
};

export type KindDef = {
  /** The wire id — what the server stores and the envelope carries. */
  id: string;
  /** Human label for the filter tabs and the create dialog. */
  label: string;
  Room: ComponentType<RoomProps>;
  fields?: FieldSpec[];
};

/**
 * The built-in kinds, in the order they're offered. Built-in stays built-in:
 * this is a typed module, not a config file or a fetch — adding a kind means
 * adding an entry here alongside its room.
 */
export const KINDS: KindDef[] = [
  {
    id: "poker",
    label: "Poker",
    Room: PokerRoom,
    fields: [
      {
        key: "deck",
        label: "Deck",
        options: [
          { id: "fibonacci", name: "Fibonacci", sample: ["0", "1", "2", "3", "5"] },
          { id: "modified-fibonacci", name: "Modified Fib", sample: ["½", "1", "2", "3", "5"] },
          { id: "tshirt", name: "T-shirt", sample: ["XS", "S", "M", "L", "XL"] },
          { id: "powers-of-2", name: "Powers of 2", sample: ["1", "2", "4", "8", "16"] },
        ],
      },
    ],
  },
  { id: "standup", label: "Standup", Room: StandupRoom },
];

/**
 * Exact-id lookup. A near-miss id ("pokerful") and a namespaced one
 * ("acme.retro") are both simply unknown — callers render an unavailable
 * state rather than falling through to some other kind's room.
 */
export function getKind(id: string): KindDef | undefined {
  return KINDS.find((k) => k.id === id);
}

/** The config a new session of this kind starts with: each field's default. */
export function defaultConfig(kind: KindDef): Record<string, string> {
  return Object.fromEntries((kind.fields ?? []).map((f) => [f.key, f.options[0].id]));
}
