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
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=secret,id=netrc,target=/root/.netrc,required=false go mod download
COPY . .
# Drop in the freshly built SPA so //go:embed all:frontend/dist picks it up.
RUN rm -rf frontend/dist
COPY --from=ui /ui/dist ./frontend/dist
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /hope ./cmd/hope

# 3) Minimal runtime — scratch. The binary is a static (CGO_ENABLED=0) pure-Go
# build, hope reaches the daemon over the mounted socket (or tcp), and the
# daemon does the registry calls — so no shell, no CLI, no libc needed. CA
# certs are carried for a tcp+tls:// daemon. Code uses UTC only, so no tzdata.
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /hope /usr/local/bin/hope
# scratch has no /etc/passwd; set HOME so ~/.docker/config.json resolves and
# the conventional /root/.docker/config.json mount is found.
ENV HOME=/root
EXPOSE 8080
ENTRYPOINT ["hope", "-config", "/app/config.toml"]
