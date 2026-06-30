package main

import (
	"context"
	"log"
	"time"

	"github.com/spf13/cobra"
	"github.com/toyz/hope/internal/docker"
)

func selfRecreateCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "self-recreate <id>",
		Short:  "Internal: recreate hope's own container from a detached helper",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		Run:    func(_ *cobra.Command, args []string) { selfRecreate(args[0]) },
	}
}

// selfRecreate runs in the throwaway helper container. It waits briefly so the
// parent's redeploy request can return, then recreates hope's container (the
// helper outlives it, so the teardown completes cleanly).
func selfRecreate(id string) {
	d, err := docker.New("unix:///var/run/docker.sock", "")
	if err != nil {
		log.Fatalf("hope self-recreate: %v", err)
	}
	defer d.Close()
	time.Sleep(2 * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := d.Recreate(ctx, id); err != nil {
		log.Fatalf("hope self-recreate %s: %v", id, err)
	}
	log.Printf("hope self-recreate: %s replaced", id)
}
