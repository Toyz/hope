package main

import (
	"context"
	"io/fs"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Toyz/sov"
	"github.com/Toyz/sov/gateway/builtin/batch"
	"github.com/Toyz/sov/gateway/builtin/explorer"
	"github.com/Toyz/sov/gateway/builtin/introspect"
	"github.com/Toyz/sov/gateway/builtin/static"
	"github.com/spf13/cobra"
	hope "github.com/toyz/hope"
	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/auth"
	"github.com/toyz/hope/internal/catalog"
	"github.com/toyz/hope/internal/cloudflare"
	"github.com/toyz/hope/internal/batchstream"
	"github.com/toyz/hope/internal/compose"
	"github.com/toyz/hope/internal/config"
	"github.com/toyz/hope/internal/containers"
	"github.com/toyz/hope/internal/deploy"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/events"
	"github.com/toyz/hope/internal/hostguard"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/meme"
	"github.com/toyz/hope/internal/pluginhost"
	"github.com/toyz/hope/internal/plugins/accessauth"
	"github.com/toyz/hope/internal/plugins/hosttarget"
	"github.com/toyz/hope/internal/plugins/introspectfilter"
	"github.com/toyz/hope/internal/plugins/logger"
	"github.com/toyz/hope/internal/plugins/logstream"
	"github.com/toyz/hope/internal/socketproxy"
	"github.com/toyz/hope/internal/stacks"
	"github.com/toyz/hope/internal/store"
	"github.com/toyz/hope/internal/system"
	"github.com/toyz/hope/internal/tunnels"
	"github.com/toyz/hope/internal/version"
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

func wsPathOr(p string) string {
	if p == "" {
		return "/agent/connect"
	}
	return p
}

// hopeCallbackURL builds hope's own base URL as reachable by a co-located plugin over
// the shared ink-plugins network: http://<hope-container-id>:<port>. self is hope's own
// container id (docker DNS resolves it on the network, same as hope dials plugins by
// their id); port comes from the server listen address. Empty self (hope not
// containerized) yields "" — the reverse channel stays off since a plugin couldn't
// resolve hope anyway.
func hopeCallbackURL(self, serverAddr string) string {
	if self == "" {
		return ""
	}
	_, port, err := net.SplitHostPort(serverAddr)
	if err != nil || port == "" {
		port = "8080"
	}
	return "http://" + self + ":" + port
}

// loopbackAddr is hope's own gateway as a loopback host:port (127.0.0.1:<port>),
// the target the agent hub relays agent-hosted plugins' reverse-channel calls to.
// Empty when the server addr has no usable port.
func loopbackAddr(serverAddr string) string {
	_, port, err := net.SplitHostPort(serverAddr)
	if err != nil || port == "" {
		return ""
	}
	return "127.0.0.1:" + port
}

// storeUpdCache adapts the state db to docker's UpdateCacheStore so the local
// host's freshness cache lives in hope.db (bucket "updates") instead of a file.
type storeUpdCache struct{ st *store.Store }

func (a storeUpdCache) Get(key string) []byte          { return a.st.Get(store.BucketUpdates, key) }
func (a storeUpdCache) Put(key string, v []byte) error { return a.st.Put(store.BucketUpdates, key, v) }

// storeCatalogCache adapts the state db to the catalog service's CacheStore, so a
// fetched remote manifest survives a restart without a re-fetch.
type storeCatalogCache struct{ st *store.Store }

func (a storeCatalogCache) Get(key string) []byte { return a.st.Get(store.BucketCatalog, key) }
func (a storeCatalogCache) Put(key string, v []byte) error {
	return a.st.Put(store.BucketCatalog, key, v)
}

// agentRecord flattens a live agent host into the persisted roster record.
func agentRecord(host *agent.Host, seen time.Time) store.AgentRecord {
	return store.AgentRecord{
		ID:          host.ID,
		Remote:      host.Remote,
		Version:     host.Info.Version,
		Revision:    host.Info.Revision,
		GoVersion:   host.Info.GoVersion,
		Platform:    host.Info.Platform,
		BuildTime:   host.Info.BuildTime,
		ContainerID: host.Info.ContainerID,
		LastSeen:    seen,
	}
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
	bi := version.Get()
	lg.Info("hope", "version", bi.Version, "revision", bi.Revision, "built", bi.BuildTime, "go", bi.GoVersion)
	fatal := func(msg string, args ...any) {
		lg.Error(msg, args...)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Optional embedded state db (bbolt). Empty path = a no-op store: every call
	// succeeds and persists nothing, so the rest of the wiring never branches on
	// whether it's configured. It holds the agent roster, freshness cache, deploy
	// specs, and UI-added registry creds (encrypted with token_secret) — mount it
	// (e.g. "/data/hope.db") to retain them across a restart.
	st, err := store.Open(cfg.Store.Path)
	if err != nil {
		fatal("open state db", "path", cfg.Store.Path, "err", err)
	}
	st.SetSecret(cfg.Auth.TokenSecret)
	defer st.Close()
	if st.Enabled() {
		lg.Info("state db opened", "path", cfg.Store.Path)
		if st.Ephemeral() {
			lg.Warn("state db is on the container's filesystem, not a mounted volume — it will be LOST on a recreate; mount a volume at its directory", "path", cfg.Store.Path)
		}
	}

	// hope is the fleet's registry-auth authority: config creds AND runtime creds
	// (added in the UI, persisted encrypted in the db) apply to the local daemon
	// AND every connecting agent. applyRegistries re-reads the db each call so an
	// agent that connects after a runtime add still gets the current set.
	applyRegistries := func(d *docker.Client) {
		for _, r := range cfg.Registries {
			d.AddRegistryCreds(r.Server, r.Username, r.Password, docker.RegistrySourceConfig)
		}
		regs, err := st.Registries()
		if err != nil {
			lg.Warn("load stored registries", "err", err)
		}
		for _, r := range regs {
			d.AddRegistryCreds(r.Server, r.Username, r.Password, docker.RegistrySourceDB)
		}
	}

	// Remote-host hub: accept hope-agents dialing in and route their Docker over
	// the tunnel (the host switcher is built on this registry). Setting a token
	// enables the WebSocket endpoint on hope's main port (no extra port — it
	// rides 443 through Cloudflare); an optional raw TCP listener serves agents
	// on a trusted LAN/overlay.
	// Global event bus: producers publish state-change events; the /rpc/_events feed
	// streams them to the UI (live rail/pages). Built before the hub + crawlers so the
	// agent-connect and update-crawler hooks can publish onto it.
	eventBus := events.New()

	var hub *agent.Hub
	var hubReg *agent.Registry
	if cfg.Agent.Token != "" {
		hub = agent.NewHub(cfg.Agent.Token, cfg.Docker.Config, lg)
		hubReg = hub.Registry()
		hub.SetBus(eventBus) // agent online/offline -> live feed
		// Relay target for agent-hosted plugins' reverse-channel calls: hope's own
		// gateway over loopback. Enables the `reverse` handshake cap so a plugin on an
		// agent host can Publish/Alert/Storage back through the tunnel (see
		// docs/reverse-over-agent.md). Empty (no host:port) leaves the cap off.
		if lb := loopbackAddr(cfg.Server.Addr); lb != "" {
			hub.SetReverseTarget(lb)
		}
		// Give every connected agent the same background jobs as the local
		// daemon — registry creds + update/disk crawlers — scoped to its
		// connection (sctx is cancelled when it drops). The freshness cache is
		// per-host and in-memory (no shared on-disk path across hosts).
		hub.OnConnect(func(sctx context.Context, host *agent.Host) {
			d := host.Docker
			applyRegistries(d) // config + db creds — hope auths registries for every agent
			if cfg.Updates.Enabled {
				d.SetUpdateHook(func() { eventBus.Publish(events.Event{Kind: events.KindImageUpdate, Host: host.ID}) })
				d.StartUpdateCrawler(sctx, cfg.Updates.Interval, "")
			}
			d.StartDiskCrawler(sctx, time.Hour)
			// Persist the roster so the Agents page can show this host (last seen,
			// build info) even after a hope restart while it's disconnected. No-op
			// when no state db is mounted.
			rec := agentRecord(host, time.Now())
			if err := st.PutAgent(rec); err != nil {
				lg.Warn("persist agent record", "host", host.ID, "err", err)
			}
			go func() { // stamp last-seen when the session drops
				<-sctx.Done()
				_ = st.PutAgent(agentRecord(host, time.Now()))
			}()
			lg.Info("agent background jobs started", "host", host.ID)
		})
		if cfg.Agent.Listen != "" {
			go func() {
				if err := hub.Listen(ctx, cfg.Agent.Listen); err != nil && ctx.Err() == nil {
					lg.Warn("agent hub (tcp) stopped", "err", err)
				}
			}()
			lg.Info("agent hub listening (tcp)", "addr", cfg.Agent.Listen)
		}
	}

	// The local socket is one host in the set. It's NOT fatal if it's down — you
	// may be managing only remote agents — it just shows as unreachable until you
	// switch to a connected agent.
	dock, err := docker.New(cfg.Docker.Host, cfg.Docker.Config)
	if err != nil {
		fatal("docker client", "err", err)
	}
	defer dock.Close()

	if cfg.Agent.Use != "" && hubReg == nil {
		fatal("agent.use set but the hub is disabled", "hint", "set [agent] token")
	}

	localUp := dock.Ping(ctx) == nil
	if localUp {
		// Local daemon reachable: wire its registry auth + background crawlers.
		applyRegistries(dock)
		dock.StartCredWatcher(ctx, 30*time.Second)
		if regs := dock.AuthedRegistries(); len(regs) > 0 {
			lg.Info("registry auth ready", "registries", strings.Join(regs, ","))
		} else {
			lg.Warn("no registry credentials — pulls will be anonymous and rate-limited; mount a docker config.json or set [[registry]]")
		}
		if cfg.Updates.Enabled {
			// The freshness cache persists in the state db (bucket "updates") when
			// one is mounted; otherwise it's in-memory and rebuilt by the crawler.
			if st.Enabled() {
				dock.SetUpdateCache(storeUpdCache{st}, "local")
			}
			dock.SetUpdateHook(func() { eventBus.Publish(events.Event{Kind: events.KindImageUpdate, Host: hosts.LocalID}) })
			dock.StartUpdateCrawler(ctx, cfg.Updates.Interval, "")
			lg.Info("update crawler started", "interval", cfg.Updates.Interval.String(), "persisted", st.Enabled())
		}
		dock.StartDiskCrawler(ctx, time.Hour) // df is expensive: crawl hourly, serve cached
	} else if cfg.Agent.Use == "" {
		lg.Warn("local docker unreachable — a connecting agent becomes active automatically", "host", cfg.Docker.Host)
	}

	// hostSet is what the routers resolve through: local plus connected agents,
	// with one active selection switched at runtime via System/SetActiveHost.
	// With local down, AUTO mode activates the first agent that dials in.
	hostSet := hosts.New(dock, localUp, hubReg)

	comp := compose.NewManager(cfg.Docker.Host, cfg.Compose.Roots)
	authRouter, tokens := auth.NewAuthRouter(cfg.Auth)

	// Deploy engine + spec store (write path: build/deploy/edit stacks, create
	// networks/volumes). Specs live in the state db; no store mounted = not
	// retained across a recreate (deploy still works; re-import to edit).
	deployStore := deploy.NewStore(st)
	deployEngine := deploy.NewEngine(hostSet, deployStore, eventBus)

	// Front the listener with the agent WebSocket endpoint when the hub is on,
	// so agents reach hope over its main port (through Cloudflare). Non-tunnel
	// traffic passes to sov untouched.
	apiEnabled := len(cfg.Auth.APIKeys) > 0
	// hostGuard rejects a host-scoped write that arrives without an explicit
	// X-Hope-Host, so a mutation can never fall back to the active host and land on
	// the wrong one (the cross-host stack-duplication class of bug).
	hostGuard := sov.WithMiddleware(hostguard.Middleware(hostSet))
	var gw *sov.Gateway
	if hub != nil {
		gw = sov.New(hostGuard, sov.WithServer(agent.NewFrontServer(hub, cfg.Agent.WSPath)))
		lg.Info("agent hub websocket enabled", "path", wsPathOr(cfg.Agent.WSPath))
	} else {
		gw = sov.New(hostGuard)
	}
	gw.MustUse(lg)                          // same instance → unified log sink, captures every dispatch
	gw.MustUse(batch.New(batch.Config{}))   // /rpc/_batch — coalesce a page's many calls into one round-trip
	gw.MustUse(batchstream.New())           // /rpc/_batchstream — same, but streams each result as it resolves (no head-of-line block)
	gw.RegisterAuth(authRouter)             // binds AuthService → bearer verification
	gw.RegisterAuthz(auth.NewAuthzRouter()) // one authz gate → replaces per-handler RequireSubject
	gw.Register(stacks.NewStacksRouter(hostSet, comp))
	gw.Register(containers.NewContainersRouter(hostSet, eventBus))
	gw.Register(system.NewSystemRouter(hostSet, cfg.Agent.Token, cfg.Agent.WSPath, apiEnabled, cfg.Plugins.Enabled, st, dock))
	gw.Register(tunnels.NewTunnelsRouter(hostSet, cloudflare.New(cfg.Cloudflare), eventBus))
	gw.Register(deploy.NewDeployRouter(hostSet, deployStore))
	var pluginDialer pluginhost.ContainerDialer
	if hub != nil {
		pluginDialer = hub // remote plugin dialing over the agent tunnel
	}
	// Installable-plugin catalog: built-ins always, plus every configured remote repo
	// (cached in the state db). Started here so the gallery is warm.
	var pluginCatalogCache catalog.CacheStore
	if st.Enabled() {
		pluginCatalogCache = storeCatalogCache{st}
	}
	catalogSources := make([]catalog.Source, 0, len(cfg.Plugins.Catalog.Repos))
	for _, repo := range cfg.Plugins.Catalog.Repos {
		catalogSources = append(catalogSources, catalog.Source{Name: repo.Name, URL: repo.URL, Trust: repo.Trust})
	}
	pluginCatalog := catalog.New(catalogSources, cfg.Plugins.Catalog.Refresh, pluginCatalogCache)
	pluginCatalog.Start(ctx)
	pluginLimits := pluginhost.Limits{
		MaxConcurrentCalls:   cfg.Plugins.Limits.MaxConcurrentCalls,
		MaxConcurrentStreams: cfg.Plugins.Limits.MaxConcurrentStreams,
		CallRatePerSec:       cfg.Plugins.Limits.CallRatePerSec,
		CallBurst:            cfg.Plugins.Limits.CallBurst,
		MaxFrameBytes:        cfg.Plugins.Limits.MaxFrameBytes,
		MaxFramesPerSec:      cfg.Plugins.Limits.MaxFramesPerSec,
	}
	pluginsRouter := pluginhost.NewPluginsRouter(hostSet, st, pluginDialer, deployEngine, pluginCatalog, cfg.Plugins.Enabled, cfg.Plugins.AutoReapprove, pluginLimits, eventBus)
	// Reverse channel: a plugin reaches hope back at hope's OWN container id over the
	// shared ink-plugins network — the same way hope dials plugins by their container
	// id. Auto-derived from hope's self container + listen port; no config. Empty when
	// hope isn't containerized (a plugin couldn't resolve it anyway).
	pluginhost.SetCallbackURL(pluginsRouter, hopeCallbackURL(dock.SelfID(), cfg.Server.Addr))
	// Agent-hosted plugins get a reverse-channel URL pointing at the agent's own
	// container id (relayed through the tunnel), resolved per host from the live
	// registry. Returns "" for the local daemon / an unknown host, so co-located
	// plugins fall back to hope's own callback. See docs/reverse-over-agent.md.
	pluginhost.SetAgentCallback(pluginsRouter, func(hostID string) string {
		if hubReg == nil {
			return ""
		}
		h := hubReg.Host(hostID)
		if h == nil || h.Info.ContainerID == "" {
			return ""
		}
		return "http://" + h.Info.ContainerID + ":" + strconv.Itoa(agent.ReversePort)
	})
	// Attach the agent's own container to ink-plugins on its host (creating the network
	// first if the host has none yet) so an agent-hosted plugin can resolve the agent by
	// container id and reach the reverse-channel relay. Best-effort; no-op for local.
	pluginhost.SetAgentAttach(pluginsRouter, func(ctx context.Context, hostID string) {
		if hubReg == nil {
			return
		}
		h := hubReg.Host(hostID)
		cli := hubReg.Get(hostID)
		if h == nil || cli == nil || h.Info.ContainerID == "" {
			return
		}
		_ = cli.EnsurePluginNetwork(ctx)
		_ = cli.AttachNetwork(ctx, h.Info.ContainerID, docker.PluginNetwork, nil)
	})
	gw.Register(pluginsRouter)
	gw.MustUse(pluginhost.NewStreamHandler(pluginsRouter, tokens))    // plugin NDJSON streams
	gw.MustUse(pluginhost.NewPluginIngress(st, eventBus, deployEngine, pluginLimits)) // plugin->hope reverse channel (publish/storage/actions)
	gw.Register(&meme.MemeRouter{})                                // public gag endpoint for the login strip
	if cfg.Cloudflare.Enabled {
		lg.Info("cloudflare tunnels enabled", "account", cfg.Cloudflare.AccountID)
	}
	if cfg.Plugins.Enabled {
		lg.Info("container plugins enabled")
		// Plugin storage, permission grants, and settings all persist in the state db.
		// Without it those reverse-channel features hard-fail (KV returns 503) and grants
		// don't stick across a restart — a silent papercut if the operator didn't mount it.
		if !st.Enabled() {
			lg.Warn("plugins enabled but no state db (store.path unset) — plugin storage, grants, and settings will NOT persist; mount one (e.g. store.path=/data/hope.db) to enable them")
		}
		// Fan the event bus out to plugins that hold the events:subscribe grant, so a
		// subscribed plugin (OnEvent) receives fleet events. Best-effort + bounded.
		pluginhost.StartEventFanout(ctx, pluginsRouter)
		// Reap orphaned plugin records ONLY on the definitive signal: stack.destroyed
		// (an intentional whole-stack teardown). Mere absence is ambiguous — a plugin
		// that's rebooting/being reinstalled is briefly absent but NOT removed, and
		// reaping its record on absence would wipe its settings/storage/grants (a
		// data-loss bug). So the absence-based reconcile backstop is intentionally NOT
		// run; a stale orphaned record is far preferable to eating a live plugin's config.
		pluginhost.StartRecordGC(ctx, pluginsRouter)
		// Keep the rail's plugin view fresh: when a plugin container's state changes
		// (e.g. an operator restarts it), bust the 15s discovery cache and republish
		// plugin.changed so the UI updates now instead of after the cache TTL lapses.
		pluginhost.StartPluginLiveness(ctx, pluginsRouter)
	}

	// Cloudflare Access SSO: when configured, a request already past Access is
	// signed straight into hope (password login stays as the LAN/ZT fallback).
	if cfg.Auth.AccessTeam != "" && cfg.Auth.AccessAUD != "" {
		verifier := auth.NewAccessVerifier(cfg.Auth.AccessTeam, cfg.Auth.AccessAUD)
		gw.MustUse(accessauth.New(tokens, verifier))
		lg.Info("cloudflare access SSO enabled", "team", cfg.Auth.AccessTeam)
	}

	// Per-request host targeting: capture the X-Hope-Host header onto the context
	// so a headless API call can run against a specific host without touching the
	// globally-active one.
	gw.MustUse(hosttarget.New())

	// Live log/stat NDJSON streams for the loom-rpc @stream transport.
	gw.MustUse(logstream.New(hostSet, tokens, deployEngine, eventBus))

	// Global event feed: one long-lived NDJSON stream of state-change events (the
	// bus fanned out to the UI). Registered beside the other stream handlers.
	gw.MustUse(events.NewHandler(eventBus, tokens))

	// Headless API: when keys are configured, enable sov's introspection endpoint
	// (/rpc/_introspect) and the interactive explorer UI (/rpc/_explorer/). Off by
	// default so hope's RPC surface stays private unless the operator opts in.
	if apiEnabled {
		gw.MustUse(introspect.New())
		gw.MustUse(introspectfilter.New()) // hide control-plane services + plugin catalog
		gw.MustUse(explorer.New(explorer.Config{}))
		lg.Info("headless API + explorer enabled", "keys", len(cfg.Auth.APIKeys), "explorer", "/rpc/_explorer/")
	}

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

	// [agent] use preselects a remote host as active. The agent reaches hope over
	// the WebSocket endpoint, which is only live once the server runs — so wait
	// for it in the background, then flip the active host to it.
	if cfg.Agent.Use != "" {
		go func() {
			lg.Info("waiting for agent to set active", "host", cfg.Agent.Use)
			if waitForAgent(ctx, hubReg, cfg.Agent.Use, 5*time.Minute) == nil {
				if ctx.Err() == nil {
					lg.Error("agent did not connect", "host", cfg.Agent.Use)
				}
				return
			}
			if err := hostSet.SetActive(cfg.Agent.Use); err != nil {
				lg.Error("could not activate agent host", "host", cfg.Agent.Use, "err", err)
				return
			}
			lg.Info("active host set to agent", "host", cfg.Agent.Use)
		}()
	}

	lg.Info("serving", "addr", cfg.Server.Addr, "docker", cfg.Docker.Host)
	if err := gw.Run(ctx, cfg.Server.Addr); err != nil {
		fatal("server", "err", err)
	}
	return nil
}
