// The board is built once and then patched. A state push from the host
// updates the notes, groups and action items it names, by id, and leaves
// everything else alone: a teammate's vote must never cost somebody the
// sentence they were typing.

export const parley = window.parley;
export const root = document.getElementById("root");

