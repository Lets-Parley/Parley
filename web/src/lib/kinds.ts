import type { ComponentType } from "react";
import type { Deck, Envelope, Me } from "./api";
import type { ConnectionStatus } from "./socket";
import { PokerRoom } from "../pages/PokerRoom";
import { StandupRoom } from "../pages/StandupRoom";

/**
 * `guest` marks a viewer holding a signed link: bound to this room, never the
 * facilitator, and refused the export and the spectator toggle. A room must not
 * offer a control the server will answer 403 to.
 */
export type RoomProps = { env: Envelope; me: Me; status?: ConnectionStatus; guest?: boolean };

/**
 * A deck as a session config carries it: the cards themselves, not a row id.
 * A session stores what it was created with, so editing or deleting the deck
 * it came from can never change the cards under votes already cast.
 */
export type DeckValue = { name: string; values: string[]; ordinal: boolean };

/** What a create-dialog field can put in the config document. */
export type ConfigValue = string | boolean | DeckValue;

/** One choice in a field: what it is called, what it looks like, what it sets. */
export type FieldOption = {
  id: string;
  name: string;
  sample: string[];
  value: ConfigValue;
};

/**
 * One create-dialog field: the built-in options, one of them the default, and
 * optionally a space-scoped source appended after them. The built-ins stay a
 * typed module; only the space's own rows are fetched.
 */
export type FieldSpec = {
  key: string;
  label: string;
  options: FieldOption[];
  /** Where this field's space-owned options come from. */
  source?: "decks";
};

/**
 * A field's options for one space: its built-ins, then the space's own decks.
 * A field with no source is served unchanged, so the fieldless standup kind
 * and any future fixed field never trigger a fetch or a merge.
 */
export function fieldOptions(field: FieldSpec, decks: Deck[]): FieldOption[] {
  if (field.source !== "decks") return field.options;
  return [
    ...field.options,
    ...decks.map((d) => ({
      id: d.id,
      name: d.name,
      sample: d.cards.slice(0, 5),
      value: { name: d.name, values: d.cards, ordinal: d.ordinal },
    })),
  ];
}

/** Whether a config value is the one an option sets. Decks compare by cards. */
export function isChosen(current: ConfigValue | undefined, option: FieldOption): boolean {
  return JSON.stringify(current) === JSON.stringify(option.value);
}

/** A create-dialog boolean, defaulted off or on. */
export type ToggleSpec = {
  key: string;
  label: string;
  hint?: string;
  default: boolean;
};

export type KindDef = {
  /** The wire id — what the server stores and the envelope carries. */
  id: string;
  /** Human label for the filter tabs and the create dialog. */
  label: string;
  Room: ComponentType<RoomProps>;
  fields?: FieldSpec[];
  toggles?: ToggleSpec[];
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
        source: "decks",
        options: [
          { id: "fibonacci", name: "Fibonacci", sample: ["0", "1", "2", "3", "5"], value: "fibonacci" },
          { id: "modified-fibonacci", name: "Modified Fib", sample: ["½", "1", "2", "3", "5"], value: "modified-fibonacci" },
          { id: "tshirt", name: "T-shirt", sample: ["XS", "S", "M", "L", "XL"], value: "tshirt" },
          { id: "powers-of-2", name: "Powers of 2", sample: ["1", "2", "4", "8", "16"], value: "powers-of-2" },
        ],
      },
    ],
    toggles: [
      {
        key: "autoReveal",
        label: "Auto-reveal when everyone has voted",
        hint: "Off by default — the facilitator Reveal button opens the round.",
        default: false,
      },
      {
        key: "openVoting",
        label: "Open voting for people who are not in the room",
        hint: "Changes who the round waits for, not whether it reveals: the round waits for everyone who has been in this room, connected or not.",
        default: false,
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

/** What to call a kind in the UI: its label, or the bare wire id if unknown. */
export function kindLabel(id: string): string {
  return getKind(id)?.label ?? id;
}

/** The config a new session of this kind starts with: each field's default. */
export function defaultConfig(kind: KindDef): Record<string, ConfigValue> {
  return {
    ...Object.fromEntries((kind.fields ?? []).map((f) => [f.key, f.options[0].value])),
    ...Object.fromEntries((kind.toggles ?? []).map((t) => [t.key, t.default])),
  };
}
