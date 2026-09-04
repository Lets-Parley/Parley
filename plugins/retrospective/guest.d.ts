declare module "main" {
  export function on_session_state(): I32;
  export function on_session_action(): I32;
}

declare module "extism:host" {
  interface user {
    parley_kv_get(ptr: I64): I64;
    parley_kv_set(ptr: I64): I64;
  }
}
