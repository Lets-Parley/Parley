// The room state, built from the admin's settings. The token itself never
// leaves the guest: the room is only told whether one is configured.
export function roomState(host) {
  var s = host.getSettings();
  var text = (s.greeting || "Hello") + ", the team is " + (s.mood || "calm");
  if (s.loud) text = text.toUpperCase();
  var tokenConfigured = false;
  try {
    var secret = host.getSecret("api_token");
    tokenConfigured = !!(secret && secret.value);
  } catch (e) {
    tokenConfigured = false;
  }
  return { message: text, tokenConfigured: tokenConfigured };
}
