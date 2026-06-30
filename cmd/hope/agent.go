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
	)
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Run as a remote agent: tunnel this host's Docker to a hope hub",
		Long: "hope agent dials OUT to a hope hub and multiplexes this host's Docker\n" +
			"socket back over a single connection, so hope can manage this host with\n" +
			"no inbound ports. Point --connect at the hub's agent listener.",
		RunE: func(_ *cobra.Command, _ []string) error {
			if connect == "" || token == "" {
				return fmt.Errorf("--connect and --token are required")
			}
			if hostID == "" {
				hostID, _ = os.Hostname()
			}
			lg := logger.New(logger.Config{Color: true, SkipFramework: true})
			ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
			defer stop()
			lg.Info("hope agent starting", "hub", connect, "host", hostID, "docker", dockerns)
			return agent.Run(ctx, connect, token, hostID, dockerns, lg)
		},
	}
	cmd.Flags().StringVar(&connect, "connect", "", "hub agent listener address, e.g. hope.example.com:9443")
	cmd.Flags().StringVar(&token, "token", "", "enrollment token (must match the hub's [agent] token)")
	cmd.Flags().StringVar(&hostID, "host-id", "", "identifier for this host (default: hostname)")
	cmd.Flags().StringVar(&dockerns, "docker", "unix:///var/run/docker.sock", "local Docker endpoint to expose")
	return cmd
}
