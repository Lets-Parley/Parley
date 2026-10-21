# bridge/

Everything that crosses the frame boundary: `host.js` holds `window.parley`
and the root element, `state.js` reads the host's state into the board's
model through one tolerant function and holds `ui`, the one object for state
that more than one file writes, and `actions.js` proposes every action,
watches for its result and puts a refusal into words.
