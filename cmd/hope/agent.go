package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/plugins/logger"
)

// agentKeys maps each viper/config key to its CLI flag. Config files use the
// key (e.g. host_id); env vars are HOPE_AGENT_<KEY> (e.g. HOPE_AGENT_HOST_ID).
var agentKeys = map[string]string{
	"connect":          "connect",
	"token":            "token",
	"host_id":          "host-id",
	"docker":           "docker",
	"cf_access_id":     "cf-access-id",
	"cf_access_secret": "cf-access-secret",
}

func agentCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Run as a remote agent: tunnel this host's Docker to a hope hub",
		Long: "hope agent dials OUT to a hope hub and multiplexes this host's Docker\n" +
			"socket back over a single connection, so hope can manage this host with\n" +
			"no inbound ports.\n\n" +
			"connect takes a wss:// (or ws://) URL to ride hope's main HTTPS port\n" +
			"through Cloudflare, e.g. wss://hope.example.com/agent/connect; or a bare\n" +
			"host:port for a raw TCP hub listener on a trusted LAN/overlay.\n\n" +
			"Every flag can also come from a TOML config (--agent-config) or an env\n" +
			"var (HOPE_AGENT_CONNECT, HOPE_AGENT_TOKEN, HOPE_AGENT_HOST_ID, ...).\n" +
			"Precedence: flag > env > config file > default.",
		RunE: func(cmd *cobra.Command, _ []string) error { return runAgent(cmd) },
	}
	f := cmd.Flags()
	f.String("agent-config", "", "path to an agent TOML config (optional; or $HOPE_AGENT_CONFIG)")
	f.String("connect", "", "hub endpoint: wss://host/agent/connect (via Cloudflare) or host:port (raw TCP)")
	f.String("token", "", "enrollment token (must match the hub's [agent] token)")
	f.String("host-id", "", "identifier for this host (default: hostname)")
	f.String("docker", "unix:///var/run/docker.sock", "local Docker endpoint to expose")
	f.String("cf-access-id", "", "Cloudflare Access service-token client id")
	f.String("cf-access-secret", "", "Cloudflare Access service-token client secret")
	return cmd
}

func runAgent(cmd *cobra.Command) error {
	v := viper.New()
	v.SetDefault("docker", "unix:///var/run/docker.sock")

	// Env: HOPE_AGENT_<KEY> (keys already use underscores, so no replacer).
	v.SetEnvPrefix("HOPE_AGENT")
	v.AutomaticEnv()

	// Optional config file.
	cfgPath, _ := cmd.Flags().GetString("agent-config")
	if cfgPath == "" {
		cfgPath = os.Getenv("HOPE_AGENT_CONFIG")
	}
	if cfgPath != "" {
		v.SetConfigFile(cfgPath)
		v.SetConfigType("toml")
		if err := v.ReadInConfig(); err != nil {
			return fmt.Errorf("read agent config %q: %w", cfgPath, err)
		}
	}

	// Flags win when explicitly set (viper only honors a bound flag once changed).
	for key, flag := range agentKeys {
		if err := v.BindPFlag(key, cmd.Flags().Lookup(flag)); err != nil {
			return err
		}
	}

	connect := strings.TrimSpace(v.GetString("connect"))
	token := strings.TrimSpace(v.GetString("token"))
	if connect == "" || token == "" {
		return fmt.Errorf("connect and token are required (set via flag, env HOPE_AGENT_CONNECT/HOPE_AGENT_TOKEN, or config)")
	}
	hostID := strings.TrimSpace(v.GetString("host_id"))
	if hostID == "" {
		hostID, _ = os.Hostname()
	}

	lg := logger.New(logger.Config{Color: true, SkipFramework: true})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	lg.Info("hope agent starting", "hub", connect, "host", hostID, "docker", v.GetString("docker"))
	return agent.Run(ctx, agent.Options{
		Connect:              connect,
		Token:                token,
		HostID:               hostID,
		Docker:               v.GetString("docker"),
		CFAccessClientID:     v.GetString("cf_access_id"),
		CFAccessClientSecret: v.GetString("cf_access_secret"),
		Log:                  lg,
	})
}
