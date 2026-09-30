function on_session_state() {
  var input = JSON.parse(Host.inputString() || "{}");
  Host.outputString(JSON.stringify(helloState(input)));
}
function on_session_action() {
  Host.outputString("{}");
}
module.exports = { on_session_state: on_session_state, on_session_action: on_session_action };
