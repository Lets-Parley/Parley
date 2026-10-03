// ---------------------------------------------------------------- content

// A map that holds only what was put in it. State strings index these, and
// a note called "constructor" must not find Object's.
export function bag(from) {
  return Object.assign(Object.create(null), from);
}

