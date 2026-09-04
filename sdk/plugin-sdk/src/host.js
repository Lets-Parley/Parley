function granted(grants, capability, scope) {
  const req = scope === undefined || scope === null ? "" : scope;
  return grants.some((g) => {
    if (g.capability !== capability) return false;
    const grant = g.scope || "";
    return grant === "" || grant === req;
  });
}

function need(grants, capability, scope) {
  if (!granted(grants, capability, scope)) {
    throw new Error(`${capability} is not granted`);
  }
}

/**
 * Capability-aware host methods. Missing grants fail here so a plugin
 * notices in development; the Extism bridge is still the enforcing check
 * and is always invoked when a grant is present.
 */
export function createHost(grants, call) {
  const g = grants || [];
  return {
    kvGet(req) {
      need(g, "kv", req.scope);
      return call("parley_kv_get", req);
    },
    kvSet(req) {
      need(g, "kv", req.scope);
      return call("parley_kv_set", req);
    },
    fetch(req) {
      need(g, "fetch");
      return call("parley_fetch", req);
    },
    secretGet(req) {
      need(g, "secrets", req.name);
      return call("parley_secret_get", req);
    },
    log(req) {
      need(g, "log");
      return call("parley_log", req);
    },
    emit(req) {
      need(g, "emit", req.topic);
      return call("parley_emit", req);
    },
    sessionGet(req) {
      need(g, "session:read", req.session);
      return call("parley_session_get", req);
    },
    sessionPatch(req) {
      need(g, "session:patch", req.session);
      return call("parley_session_patch", req);
    },
    jobEnqueue(req) {
      need(g, "jobs", req.kind);
      return call("parley_job_enqueue", req);
    },
  };
}
