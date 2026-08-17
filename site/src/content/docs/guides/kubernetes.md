---
title: Kubernetes
description: A starting manifest, and the two things in it that are load-bearing.
---

`deploy/k8s/deployment.yaml` is a starting point. Two things in it are
load-bearing rather than stylistic.

**`replicas: 1` + `strategy: Recreate`.** The realtime hub is in-process, and a
second replica refuses to start via a Postgres advisory lock.

**The liveness probe hits `/healthz`**, which never touches the database,
because a DB blip must not restart the pod and drop every WebSocket.

## Bring your own Postgres

Parley ships no database for Kubernetes. Use a managed one or an operator, then
give the Deployment its connection string and pin an image tag:

```sh
kubectl create secret generic parley \
  --from-literal=database-url='postgres://parley:secret@host:5432/parley'
kubectl apply -f deploy/k8s/deployment.yaml
```

## Expect a few seconds of downtime on deploy

One replica and `Recreate` means a rolling update is a gap, covered by the
client's reconnect banner. If a new pod logs `advisory lock ... already held`,
the old one hasn't exited yet; it starts on the next retry.

There is deliberately **no PodDisruptionBudget**. The only one that would
protect a single replica (`maxUnavailable: 0`) deadlocks the drain it was meant
to survive.

## The manifest sets TRUST_PROXY_HEADERS

An Ingress terminates the connection, so without it every visitor arrives
wearing the controller's address and the room-code throttle treats the whole
internet as one client. See [Configuration](/guides/configuration/).
