package docker

import (
	"reflect"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
	"github.com/toyz/hope/internal/stackspec"
)

// These lock the pure spec<->docker-SDK translation helpers. They're the layer most
// exposed to a docker/go-connections version bump (the nat port types, container
// restart/health types), so a breaking change upstream should fail here, not silently
// at deploy time.

func TestEnvSliceMapRoundTrip(t *testing.T) {
	m := map[string]string{"B": "2", "A": "1", "C": "3"}
	got := envSlice(m)
	want := []string{"A=1", "B=2", "C=3"} // sorted by key for a stable container spec
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("envSlice = %v; want %v", got, want)
	}
	if back := envMap(got); !reflect.DeepEqual(back, m) {
		t.Fatalf("envMap(envSlice(m)) = %v; want %v", back, m)
	}
	if envSlice(nil) != nil {
		t.Error("envSlice(nil) should be nil")
	}
	if envMap(nil) != nil {
		t.Error("envMap(nil) should be nil")
	}
	// Value may itself contain '=', split on the FIRST one only.
	if back := envMap([]string{"URL=redis://h:6379/0=x"}); back["URL"] != "redis://h:6379/0=x" {
		t.Errorf("envMap kept only up to first '='; got %q", back["URL"])
	}
}

func TestPortMaps(t *testing.T) {
	ports := []stackspec.PortMap{
		{Container: "8080", Host: "80", HostIP: "127.0.0.1", Protocol: "tcp"},
		{Container: "9090"}, // no host binding; protocol defaults to tcp
	}
	exposed, bindings, err := portMaps(ports)
	if err != nil {
		t.Fatalf("portMaps err: %v", err)
	}
	p8080, _ := nat.NewPort("tcp", "8080")
	p9090, _ := nat.NewPort("tcp", "9090")
	if _, ok := exposed[p8080]; !ok {
		t.Error("8080/tcp not exposed")
	}
	if _, ok := exposed[p9090]; !ok {
		t.Error("9090/tcp not exposed (a port with no host binding is still exposed)")
	}
	if b := bindings[p8080]; len(b) != 1 || b[0].HostPort != "80" || b[0].HostIP != "127.0.0.1" {
		t.Errorf("8080 binding = %+v; want 127.0.0.1:80", b)
	}
	if _, ok := bindings[p9090]; ok {
		t.Error("9090 should have no host binding")
	}

	if _, _, err := portMaps([]stackspec.PortMap{{Container: "not-a-port"}}); err == nil {
		t.Error("portMaps should reject an unparseable port")
	}
	if e, b, err := portMaps(nil); e != nil || b != nil || err != nil {
		t.Error("portMaps(nil) should be all-nil")
	}
}

func TestPortSpecs(t *testing.T) {
	p8080, _ := nat.NewPort("tcp", "8080")
	p9090, _ := nat.NewPort("udp", "9090")
	pm := nat.PortMap{
		p8080: []nat.PortBinding{{HostIP: "0.0.0.0", HostPort: "80"}},
		p9090: nil, // exposed but unpublished
	}
	got := portSpecs(pm)
	want := []stackspec.PortMap{
		{Host: "80", HostIP: "0.0.0.0", Container: "8080", Protocol: "tcp"},
		{Container: "9090", Protocol: "udp"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("portSpecs = %+v; want %+v", got, want)
	}
	if portSpecs(nil) != nil {
		t.Error("portSpecs(nil) should be nil")
	}
}

func TestRestartPolicy(t *testing.T) {
	cases := map[string]container.RestartPolicyMode{
		"always":         container.RestartPolicyAlways,
		"on-failure":     container.RestartPolicyOnFailure,
		"unless-stopped": container.RestartPolicyUnlessStopped,
		"":               container.RestartPolicyDisabled,
		"bogus":          container.RestartPolicyDisabled,
	}
	for in, want := range cases {
		if got := restartPolicy(in).Name; got != want {
			t.Errorf("restartPolicy(%q).Name = %q; want %q", in, got, want)
		}
	}
}

func TestHealthRoundTrip(t *testing.T) {
	hs := &stackspec.HealthSpec{
		Test:        []string{"CMD", "curl", "-f", "localhost"},
		Interval:    "5s",
		Timeout:     "3s",
		StartPeriod: "10s",
		Retries:     3,
	}
	hc := healthConfig(hs)
	if hc == nil || hc.Interval != 5*time.Second || hc.Timeout != 3*time.Second || hc.StartPeriod != 10*time.Second || hc.Retries != 3 {
		t.Fatalf("healthConfig = %+v", hc)
	}
	if !reflect.DeepEqual(hc.Test, hs.Test) {
		t.Errorf("Test not preserved: %v", hc.Test)
	}
	back := healthSpec(hc)
	if back == nil || back.Interval != "5s" || back.Timeout != "3s" || back.StartPeriod != "10s" || back.Retries != 3 {
		t.Fatalf("healthSpec = %+v", back)
	}
	// A healthcheck with no Test is "unset" in both directions.
	if healthConfig(nil) != nil || healthConfig(&stackspec.HealthSpec{}) != nil {
		t.Error("healthConfig of nil/empty should be nil")
	}
	if healthSpec(nil) != nil || healthSpec(&container.HealthConfig{}) != nil {
		t.Error("healthSpec of nil/empty should be nil")
	}
}

func TestParseDur(t *testing.T) {
	cases := map[string]time.Duration{"5s": 5 * time.Second, "1m30s": 90 * time.Second, "": 0, "garbage": 0}
	for in, want := range cases {
		if got := parseDur(in); got != want {
			t.Errorf("parseDur(%q) = %v; want %v", in, got, want)
		}
	}
}

func TestBinds(t *testing.T) {
	mounts := []stackspec.MountSpec{
		{Source: "vol", Target: "/data"},
		{Source: "cfg", Target: "/etc/app", ReadOnly: true},
		{Source: "", Target: "/anon"}, // anonymous: skipped (left to image VOLUME)
		{Source: "x", Target: ""},     // no target: skipped
	}
	got := binds(mounts)
	want := []string{"vol:/data", "cfg:/etc/app:ro"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("binds = %v; want %v", got, want)
	}
	if binds(nil) != nil {
		t.Error("binds(nil) should be nil")
	}
}

func TestEndpointAliases(t *testing.T) {
	spec := stackspec.ContainerSpec{Name: "web", Aliases: map[string][]string{"netA": {"web", "alias1", "alias1"}}}
	if got := endpointAliases(spec, "netA"); !reflect.DeepEqual(got, []string{"web", "alias1"}) {
		t.Errorf("netA aliases = %v; want [web alias1] (name first, deduped)", got)
	}
	if got := endpointAliases(spec, "other"); !reflect.DeepEqual(got, []string{"web"}) {
		t.Errorf("other-net aliases = %v; want just [web]", got)
	}
	if endpointAliases(stackspec.ContainerSpec{}, "x") != nil {
		t.Error("no name + no aliases should be nil")
	}
}

func TestFilterLabels(t *testing.T) {
	in := map[string]string{
		"com.docker.compose.project": "p",
		"ink.hope.managed":           "1",
		"app":                        "web",
		"tier":                       "frontend",
	}
	got := filterLabels(in)
	want := map[string]string{"app": "web", "tier": "frontend"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filterLabels = %v; want %v (compose/hope-internal dropped)", got, want)
	}
	if filterLabels(nil) != nil {
		t.Error("filterLabels(nil) should be nil")
	}
	if filterLabels(map[string]string{"ink.hope.managed": "1"}) != nil {
		t.Error("all-internal labels should filter to nil")
	}
}

func TestSortedSet(t *testing.T) {
	got := sortedSet(map[string]bool{"z": true, "a": true, "m": true})
	if !reflect.DeepEqual(got, []string{"a", "m", "z"}) {
		t.Errorf("sortedSet = %v; want [a m z]", got)
	}
}
