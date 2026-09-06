FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS webbuild
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json web/tsconfig.vitest.json web/vite.config.ts ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM golang:1.27-alpine@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125 AS gobuild
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go ./web/embed.go
COPY --from=webbuild /src/web/dist ./web/dist
ARG TARGETOS TARGETARCH
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-X main.version=$VERSION" -o /parley ./cmd/parley

# Frozen Go Cryptographic Module v1.0.0 holds CMVP certificate #5247.
# v1.26.0 is the in-process module on this toolchain; do not move the pin
# until a newer freeze has a completed certificate. GOFIPS140 is build-time:
# it selects the frozen sources and turns FIPS 140-3 mode on by default.
# https://go.dev/doc/security/fips140
# https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5247
FROM gobuild AS gobuild-fips
ARG TARGETOS TARGETARCH
ARG VERSION=dev
ARG GOFIPS140=v1.0.0
ENV GOFIPS140=$GOFIPS140
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOFIPS140=$GOFIPS140 \
    go build -trimpath -ldflags "-X main.version=$VERSION" -o /parley ./cmd/parley

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS fips
COPY --from=gobuild-fips /parley /parley
# on, not only: RFC 6455 computes Sec-WebSocket-Accept with SHA-1, and
# fips140=only panics on it. Approved algorithms still go through the module.
ENV GODEBUG=fips140=on
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD ["/parley", "-healthcheck"]
USER 65532:65532
ENTRYPOINT ["/parley"]

# Default runtime is last so `docker build` without --target stays the
# non-FIPS image and does not compile the FIPS binary.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=gobuild /parley /parley
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD ["/parley", "-healthcheck"]
USER 65532:65532
ENTRYPOINT ["/parley"]
