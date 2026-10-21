// The room state every participant is sent. No capabilities: nothing stored.
export function helloState(input) {
  return { greeting: "Hello from a plugin", session: input.session || "" };
}
