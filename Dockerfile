# syntax=docker/dockerfile:1
#
# hope — single self-contained binary (sov backend + embedded loom SPA).
# Stack ops are Docker-API based, so the runtime image needs NO docker CLI.
#
# If github.com/Toyz/sov is a private module, pass build creds, e.g.:
#   docker build --secret id=netrc,src=$HOME/.netrc --build-arg GOPRIVATE=github.com/Toyz/* .

# 1) Build the frontend.
FROM node:lts-alpine AS ui
WORKDIR /ui
COPY frontend/package*.json ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# 2) Build the Go binary with the SPA embedded.
FROM golang:alpine AS build
RUN apk add --no-cache git ca-certificates
ARG GOPRIVATE=""
ENV GOPRIVATE=${GOPRIVATE}
# Build info stamped into the binary (CI passes these; see docker-publish.yml).
ARG VERSION="dev"
ARG REVISION=""
ARG BUILDTIME=""
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=secret,id=netrc,target=/root/.netrc,required=false go mod download
COPY . .
# Drop in the freshly built SPA so //go:embed all:frontend/dist picks it up.
RUN rm -rf frontend/dist
COPY --from=ui /ui/dist ./frontend/dist
ARG LDFLAGS="-s -w \
        -X github.com/toyz/hope/internal/version.Version=${VERSION} \
        -X github.com/toyz/hope/internal/version.Revision=${REVISION} \
        -X github.com/toyz/hope/internal/version.BuildTime=${BUILDTIME}"
RUN CGO_ENABLED=0 go build -ldflags="${LDFLAGS}" -o /hope ./cmd/hope
# hope-boot: the tiny launcher + self-update helper (no SPA/gateway). It execs
# hope for normal runs and does the detached container recreate for updates.
RUN CGO_ENABLED=0 go build -ldflags="${LDFLAGS}" -o /hope-boot ./cmd/hope-boot

# 3) Minimal runtime — scratch. Both binaries are static (CGO_ENABLED=0) pure-Go
# builds, hope reaches the daemon over the mounted socket (or tcp), and the
# daemon does the registry calls — so no shell, no CLI, no libc needed. CA
# certs are carried for a tcp+tls:// daemon. Code uses UTC only, so no tzdata.
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /hope /usr/local/bin/hope
COPY --from=build /hope-boot /usr/local/bin/hope-boot
# scratch has no /etc/passwd; set HOME so ~/.docker/config.json resolves and
# the conventional /root/.docker/config.json mount is found.
ENV HOME=/root
# Marks any container from this image (hope itself, hope-agent) as hope-managed,
# so a recreate routes through the detached helper instead of a direct stop over
# the very connection it provides — which would sever the tunnel mid-op (EOF).
ENV HOPE_MANAGED=1
EXPOSE 8080
# hope-boot forwards these straight to hope (and intercepts `recreate` for updates).
ENTRYPOINT ["hope-boot", "-config", "/app/config.toml"]
