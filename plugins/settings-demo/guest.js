function hostCall(fn, req) {
  var mem = Memory.fromString(JSON.stringify(req));
  var env = JSON.parse(Memory.find(fn(mem.offset)).readString());
  if (!env.ok) throw new Error(env.error || "host refused");
  return env.data;
}

function on_session_state() {
  var fns = Host.getFunctions();
  var host = createHost([], function (name, req) {
    return hostCall(fns[name], req);
  }, MANIFEST);
  Host.outputString(JSON.stringify(roomState(host)));
}
function on_session_action() {
  Host.outputString("{}");
}
module.exports = { on_session_state: on_session_state, on_session_action: on_session_action };
