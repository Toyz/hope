// Command hope is a Docker Compose cluster manager: a single Go binary (sov
// gateway) that embeds the loom frontend, reads compose labels to group
// containers into stacks, and drives full stack lifecycle. The same binary also
// runs as a remote agent (`hope agent`) that tunnels a remote host's Docker
// socket back to a hope hub.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

func main() {
	// Back-compat: existing invocations (air, the Dockerfile ENTRYPOINT,
	// docker-compose) pass the legacy single-dash `-config X`. cobra/pflag would
	// read that as a shorthand cluster and choke, so translate it to `--config`
	// before parsing. New `--config`/`-c` work unchanged.
	normalizeLegacyArgs()

	root := &cobra.Command{
		Use:           "hope",
		Short:         "Docker Compose cluster manager",
		SilenceUsage:  true,
		SilenceErrors: true,
		// Bare `hope` runs the server, preserving the original behavior.
		RunE: func(cmd *cobra.Command, _ []string) error { return runServe(configFlag(cmd)) },
	}
	root.PersistentFlags().StringP("config", "c", "config.toml", "path to the TOML config file")

	root.AddCommand(serveCmd(), agentCmd(), selfRecreateCmd())

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "hope:", err)
		os.Exit(1)
	}
}

func configFlag(cmd *cobra.Command) string {
	p, _ := cmd.Flags().GetString("config")
	return p
}

// normalizeLegacyArgs rewrites the old `-config`/`-config=...` single-dash flag
// to the cobra `--config` form so legacy invocations keep working.
func normalizeLegacyArgs() {
	for i, a := range os.Args {
		if a == "-config" {
			os.Args[i] = "--config"
		} else if strings.HasPrefix(a, "-config=") {
			os.Args[i] = "--config=" + strings.TrimPrefix(a, "-config=")
		}
	}
}
