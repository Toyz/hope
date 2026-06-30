package main

import (
	"context"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Toyz/sov"
	"github.com/Toyz/sov/gateway/builtin/static"
	"github.com/spf13/cobra"
	hope "github.com/toyz/hope"
	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/compose"
	"github.com/toyz/hope/internal/config"
	"github.com/toyz/hope/internal/containers"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/meme"
	"github.com/toyz/hope/internal/plugins/accessauth"
	"github.com/toyz/hope/internal/plugins/logger"
	"github.com/toyz/hope/internal/plugins/logstream"
	"github.com/toyz/hope/internal/socketproxy"
	"github.com/toyz/hope/internal/stacks"
	"github.com/toyz/hope/internal/system"
)

func serveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "Run the hope server (UI + API)",
		RunE:  func(cmd *cobra.Command, _ []string) error { return runServe(configFlag(cmd)) },
	}
}

// waitForAgent blocks until the given host-id dials into the hub (or the
// timeout/ctx fires), returning its tunneled docker client.
func waitForAgent(ctx context.Context, reg *agent.Registry, id string, timeout time.Duration) *docker.Client {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if dc := reg.Get(id); dc != nil {
			return dc
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(500 * time.Millisecond):
		}
	}
	return nil
}

func runServe(configPath string) error {
	cfg, err := config.Load(configPath)
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

	// Remote-host hub: accept hope-agents dialing in and route their Docker over
	// the tunnel (the host switcher is built on this registry).
	var hubReg *agent.Registry
	if cfg.Agent.Listen != "" && cfg.Agent.Token != "" {
		hub := agent.NewHub(cfg.Agent.Token, cfg.Docker.Config, lg)
		hubReg = hub.Registry()
		go func() {
			if err := hub.Listen(ctx, cfg.Agent.Listen); err != nil && ctx.Err() == nil {
				lg.Warn("agent hub stopped", "err", err)
			}
		}()
		lg.Info("agent hub listening", "addr", cfg.Agent.Listen)
	}

	// Docker source: either the local socket, or a connected agent's tunnel when
	// [agent] use is set (hope then waits for that host to dial in).
	var dock *docker.Client
	if cfg.Agent.Use != "" {
		if hubReg == nil {
			fatal("agent.use set but the hub is disabled", "hint", "set [agent] listen + token")
		}
		lg.Info("waiting for agent to use as primary docker", "host", cfg.Agent.Use)
		dock = waitForAgent(ctx, hubReg, cfg.Agent.Use, 90*time.Second)
		if dock == nil {
			fatal("agent did not connect", "host", cfg.Agent.Use)
		}
		lg.Info("using remote agent docker", "host", cfg.Agent.Use)
	} else {
		dock, err = docker.New(cfg.Docker.Host, cfg.Docker.Config)
		if err != nil {
			fatal("docker client", "err", err)
		}
		defer dock.Close()
	}
	if err := dock.Ping(ctx); err != nil {
		fatal("cannot reach docker", "host", cfg.Docker.Host, "err", err)
	}
	// Explicit registry credentials from config (e.g. a Docker Hub account +
	// token) override config.json and avoid anonymous-pull rate limits.
	for _, r := range cfg.Registries {
		dock.AddRegistryCreds(r.Server, r.Username, r.Password)
		lg.Info("registry credentials loaded", "server", r.Server, "user", r.Username)
	}
	// Hot-reload registry creds when the mounted config.json changes (e.g. a
	// fresh `docker login`) — no restart needed.
	dock.StartCredWatcher(ctx, 30*time.Second)
	if regs := dock.AuthedRegistries(); len(regs) > 0 {
		lg.Info("registry auth ready", "registries", strings.Join(regs, ","))
	} else {
		lg.Warn("no registry credentials — pulls will be anonymous and rate-limited; mount a docker config.json or set [[registry]]")
	}
	// Background crawler keeps the cluster-wide image-freshness cache warm for
	// the dashboard "updates" section (manifest lookups, no layer pulls).
	if cfg.Updates.Enabled {
		dock.StartUpdateCrawler(ctx, cfg.Updates.Interval, cfg.Updates.CachePath)
		lg.Info("update crawler started", "interval", cfg.Updates.Interval.String(), "cache", cfg.Updates.CachePath)
	}
	// Docker disk usage (`df`) is expensive, so crawl it hourly and serve cached.
	dock.StartDiskCrawler(ctx, time.Hour)

	comp := compose.NewManager(cfg.Docker.Host, cfg.Compose.Roots)
	authRouter, tokens := auth.NewAuthRouter(cfg.Auth)

	gw := sov.New()
	gw.MustUse(lg)              // same instance → unified log sink, captures every dispatch
	gw.RegisterAuth(authRouter) // binds AuthService → bearer verification
	gw.Register(stacks.NewStacksRouter(dock, comp))
	gw.Register(containers.NewContainersRouter(dock))
	gw.Register(system.NewSystemRouter(dock, hubReg))
	gw.Register(&meme.MemeRouter{}) // public gag endpoint for the login strip

	// Cloudflare Access SSO: when configured, a request already past Access is
	// signed straight into hope (password login stays as the LAN/ZT fallback).
	if cfg.Auth.AccessTeam != "" && cfg.Auth.AccessAUD != "" {
		verifier := auth.NewAccessVerifier(cfg.Auth.AccessTeam, cfg.Auth.AccessAUD)
		gw.MustUse(accessauth.New(tokens, verifier))
		lg.Info("cloudflare access SSO enabled", "team", cfg.Auth.AccessTeam)
	}

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
	return nil
}
