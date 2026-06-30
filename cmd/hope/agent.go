package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/toyz/hope/internal/agent"
	"github.com/toyz/hope/internal/plugins/logger"
)

func agentCmd() *cobra.Command {
	var (
		connect  string
		token    string
		hostID   string
		dockerns string
		cfID     string
		cfSecret string
	)
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Run as a remote agent: tunnel this host's Docker to a hope hub",
		Long: "hope agent dials OUT to a hope hub and multiplexes this host's Docker\n" +
			"socket back over a single connection, so hope can manage this host with\n" +
			"no inbound ports.\n\n" +
			"--connect takes a wss:// (or ws://) URL to ride hope's main HTTPS port\n" +
			"through Cloudflare, e.g. wss://hope.example.com/agent/connect; or a bare\n" +
			"host:port for a raw TCP hub listener on a trusted LAN/overlay.\n\n" +
			"Behind Cloudflare Access, pass a service token with --cf-access-id and\n" +
			"--cf-access-secret (or configure an Access bypass for the agent path).",
		RunE: func(_ *cobra.Command, _ []string) error {
			if connect == "" || token == "" {
				return fmt.Errorf("--connect and --token are required")
			}
			if hostID == "" {
				hostID, _ = os.Hostname()
			}
			// Convenience: allow service-token creds via env so they aren't in
			// the process args / shell history.
			if cfID == "" {
				cfID = os.Getenv("CF_ACCESS_CLIENT_ID")
			}
			if cfSecret == "" {
				cfSecret = os.Getenv("CF_ACCESS_CLIENT_SECRET")
			}
			lg := logger.New(logger.Config{Color: true, SkipFramework: true})
			ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
			defer stop()
			lg.Info("hope agent starting", "hub", connect, "host", hostID, "docker", dockerns)
			return agent.Run(ctx, agent.Options{
				Connect:              connect,
				Token:                token,
				HostID:               hostID,
				Docker:               dockerns,
				CFAccessClientID:     cfID,
				CFAccessClientSecret: cfSecret,
				Log:                  lg,
			})
		},
	}
	cmd.Flags().StringVar(&connect, "connect", "", "hub endpoint: wss://host/agent/connect (via Cloudflare) or host:port (raw TCP)")
	cmd.Flags().StringVar(&token, "token", "", "enrollment token (must match the hub's [agent] token)")
	cmd.Flags().StringVar(&hostID, "host-id", "", "identifier for this host (default: hostname)")
	cmd.Flags().StringVar(&dockerns, "docker", "unix:///var/run/docker.sock", "local Docker endpoint to expose")
	cmd.Flags().StringVar(&cfID, "cf-access-id", "", "Cloudflare Access service-token client id (or $CF_ACCESS_CLIENT_ID)")
	cmd.Flags().StringVar(&cfSecret, "cf-access-secret", "", "Cloudflare Access service-token client secret (or $CF_ACCESS_CLIENT_SECRET)")
	return cmd
}
