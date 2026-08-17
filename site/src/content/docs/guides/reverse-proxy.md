---
title: Reverse proxy
description: HTTPS and WebSockets in front of Parley, with Caddy or nginx.
---

## Caddy

One line. It handles WebSockets and TLS automatically:

```
parley.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## nginx

Needs the upgrade headers and a read timeout longer than a quiet standup speaker.
Parley pings every 25s, so 75s is safe:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

## Then set two variables

```sh
BASE_URL=https://parley.example.com
TRUST_PROXY_HEADERS=true
```

`BASE_URL` must match the address in the browser's bar exactly — scheme, host
and port — or the WebSocket origin check rejects every connection.

`TRUST_PROXY_HEADERS=true` lets the room-code throttle count real clients
instead of seeing every request as coming from the proxy. Only set it once
something in front is actually setting the header. See
[Configuration](/guides/configuration/).
