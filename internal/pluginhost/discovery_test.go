package pluginhost

import (
	"testing"

	"github.com/toyz/hope/internal/docker"
)

func TestPluginIdentity(t *testing.T) {
	// Same project+service on two hosts => distinct (host is part of identity).
	a := pluginIdentity("local", docker.PluginContainer{Project: "app", Service: "pg", ContainerID: "c1"})
	b := pluginIdentity("agent-1", docker.PluginContainer{Project: "app", Service: "pg", ContainerID: "c2"})
	if a == b {
		t.Fatalf("same project/service on different hosts should differ: %q == %q", a, b)
	}

	// Same project+service, different container ids => SAME identity (survives a
	// redeploy; replicas collapse).
	c1 := pluginIdentity("local", docker.PluginContainer{Project: "app", Service: "pg", ContainerID: "old"})
	c2 := pluginIdentity("local", docker.PluginContainer{Project: "app", Service: "pg", ContainerID: "new"})
	if c1 != c2 {
		t.Fatalf("same project/service should be stable across container ids: %q != %q", c1, c2)
	}

	// Same image, different stacks => distinct (can't cross-talk stacks).
	s1 := pluginIdentity("local", docker.PluginContainer{Project: "app-a", Service: "pg", ContainerID: "x"})
	s2 := pluginIdentity("local", docker.PluginContainer{Project: "app-b", Service: "pg", ContainerID: "y"})
	if s1 == s2 {
		t.Fatalf("same image in different stacks must stay distinct: %q == %q", s1, s2)
	}

	// No compose project => falls back to container name, then id.
	n := pluginIdentity("local", docker.PluginContainer{Name: "standalone", ContainerID: "z"})
	if n != "local|~/standalone" {
		t.Fatalf("name fallback wrong: %q", n)
	}
	id := pluginIdentity("local", docker.PluginContainer{ContainerID: "abc"})
	if id != "local|id/abc" {
		t.Fatalf("id fallback wrong: %q", id)
	}
}

func TestRepresentativePrefersRunning(t *testing.T) {
	members := []docker.PluginContainer{
		{ContainerID: "a", Running: false},
		{ContainerID: "b", Running: true},
		{ContainerID: "c", Running: false},
	}
	if rep := representative(members); rep.ContainerID != "b" {
		t.Fatalf("representative should prefer the running container, got %q", rep.ContainerID)
	}
	// All stopped => first.
	stopped := []docker.PluginContainer{{ContainerID: "a"}, {ContainerID: "b"}}
	if rep := representative(stopped); rep.ContainerID != "a" {
		t.Fatalf("all-stopped representative should be the first, got %q", rep.ContainerID)
	}
}
