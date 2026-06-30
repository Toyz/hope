// Command hope is a Docker Compose cluster manager: a single Go binary (sov
// gateway) that embeds the loom frontend, reads compose labels to group
// containers into stacks, and drives full stack lifecycle. It reaches the
// Docker daemon through a configured endpoint (mounted unix socket or a remote
// tcp:// host).
package main

import (
	"context"
	"flag"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Toyz/sov"
	"github.com/Toyz/sov/gateway/builtin/static"
	hope "github.com/toyz/hope"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/compose"
	"github.com/toyz/hope/internal/config"
	"github.com/toyz/hope/internal/containers"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/plugins/logger"
	"github.com/toyz/hope/internal/plugins/logstream"
	"github.com/toyz/hope/internal/socketproxy"
	"github.com/toyz/hope/internal/stacks"
	"github.com/toyz/hope/internal/system"
)

func main() {
	configPath := flag.String("config", "config.toml", "path to the TOML config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		// Pre-logger bootstrap failure — config drives the logger itself.
		log.Fatalf("hope: %v", err)
	}

	// The request logger is also the gateway-wide log sink AND main()'s logger,
	// so every line (startup, fatal, per-request) shares one format.
	lg := logger.New(logger.Config{Color: cfg.Log.Color, JSON: cfg.Log.JSON, SkipFramework: true})
	fatal := func(msg string, args ...any) {
		lg.Error(msg, args...)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Docker client + a liveness ping so misconfiguration fails at boot.
	dock, err := docker.New(cfg.Docker.Host, cfg.Docker.Config)
	if err != nil {
		fatal("docker client", "err", err)
	}
	defer dock.Close()
	if err := dock.Ping(ctx); err != nil {
		fatal("cannot reach docker", "host", cfg.Docker.Host, "err", err)
	}

	comp := compose.NewManager(cfg.Docker.Host, cfg.Compose.Roots)
	authRouter, tokens := auth.NewAuthRouter(cfg.Auth)

	gw := sov.New()
	gw.MustUse(lg) // same instance → unified log sink, captures every dispatch
	gw.RegisterAuth(authRouter) // binds AuthService → bearer verification
	gw.Register(stacks.NewStacksRouter(dock, comp))
	gw.Register(containers.NewContainersRouter(dock))
	gw.Register(system.NewSystemRouter(dock))

	// Live log/stat NDJSON streams for the loom-rpc @stream transport.
	gw.MustUse(logstream.New(dock, tokens))

	// Serve the embedded SPA at "/"; /rpc/* is reserved (never shadowed).
	sub, err := fs.Sub(hope.DistFS, "frontend/dist")
	if err != nil {
		fatal("embed dist", "err", err)
	}
	gw.MustUse(static.New(static.Config{FS: sub, SPAFallback: true}))

	// Optional LAN-facing docker socket proxy.
	if proxy, err := socketproxy.New(cfg.SocketProxy, cfg.Docker.Host); err != nil {
		fatal("socketproxy", "err", err)
	} else if proxy != nil {
		lg.Info("socket proxy listening", "addr", proxy.Addr())
		go func() {
			if err := proxy.ListenAndServe(ctx); err != nil && ctx.Err() == nil {
				lg.Warn("socket proxy stopped", "err", err)
			}
		}()
	}

	lg.Info("serving", "addr", cfg.Server.Addr, "docker", cfg.Docker.Host)
	if err := gw.Run(ctx, cfg.Server.Addr); err != nil {
		fatal("server", "err", err)
	}
}
