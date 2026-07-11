package stackspec

import (
	"strings"
	"testing"
)

// TestFromComposeLongPortForm covers parsePort's map (long) form, including
// integer target/published (scalarString/itoa), an absent published (host-empty),
// and a long entry missing target (skipped with a warning).
func TestFromComposeLongPortForm(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    ports:
      - target: 80
        published: 8080
        protocol: tcp
        host_ip: 0.0.0.0
      - target: 9090
      - published: 5000
`
	spec, warns, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc := spec.Services[0]
	if len(svc.Ports) != 2 {
		t.Fatalf("want 2 parsed ports, got %d: %#v", len(svc.Ports), svc.Ports)
	}
	// First: full long form.
	p0 := svc.Ports[0]
	if p0.Container != "80" || p0.Host != "8080" || p0.Protocol != "tcp" || p0.HostIP != "0.0.0.0" {
		t.Fatalf("long port 0 wrong: %#v", p0)
	}
	// Second: target only (published absent -> host empty).
	p1 := svc.Ports[1]
	if p1.Container != "9090" || p1.Host != "" {
		t.Fatalf("long port 1 wrong: %#v", p1)
	}
	// The published-only entry (no target) is skipped with a warning.
	if !warnsContain(warns, "ports") {
		t.Fatalf("expected a skipped-port warning, got: %v", warns)
	}
}

// TestFromComposeLongMountForm covers parseMount's map form: explicit bind with
// read_only, explicit volume, and an inferred-type long entry (target only).
func TestFromComposeLongMountForm(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    volumes:
      - type: bind
        source: /host/conf
        target: /etc/conf
        read_only: true
      - type: volume
        source: named
        target: /data
      - target: /anon
      - source: nope
`
	spec, warns, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc := spec.Services[0]
	if len(svc.Mounts) != 3 {
		t.Fatalf("want 3 mounts, got %d: %#v", len(svc.Mounts), svc.Mounts)
	}
	if svc.Mounts[0].Type != "bind" || svc.Mounts[0].Source != "/host/conf" || !svc.Mounts[0].ReadOnly {
		t.Fatalf("bind mount wrong: %#v", svc.Mounts[0])
	}
	if svc.Mounts[1].Type != "volume" || svc.Mounts[1].Source != "named" || svc.Mounts[1].Target != "/data" {
		t.Fatalf("volume mount wrong: %#v", svc.Mounts[1])
	}
	if svc.Mounts[2].Type != "volume" || svc.Mounts[2].Source != "" || svc.Mounts[2].Target != "/anon" {
		t.Fatalf("anon mount wrong: %#v", svc.Mounts[2])
	}
	// The entry without a target is skipped with a warning.
	if !warnsContain(warns, "volumes") {
		t.Fatalf("expected a skipped-volume warning, got: %v", warns)
	}
}

// TestFromComposeShortMountAnon covers the single-part short mount form (an
// anonymous volume named only by its container path).
func TestFromComposeShortMountAnon(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    volumes:
      - /var/lib/anon
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := spec.Services[0].Mounts
	if len(m) != 1 || m[0].Type != "volume" || m[0].Source != "" || m[0].Target != "/var/lib/anon" {
		t.Fatalf("anon short mount wrong: %#v", m)
	}
}

// TestFromComposeFlexStrList covers flexStrList's scalar (shell-split) and
// sequence forms via command/entrypoint/cap_add/extra_hosts, plus an empty
// scalar (which yields nil).
func TestFromComposeFlexStrList(t *testing.T) {
	src := `
services:
  a:
    image: redis
    command: redis-server --appendonly yes
    entrypoint:
      - /bin/sh
      - -c
    cap_add:
      - NET_ADMIN
    extra_hosts:
      - "host.docker.internal:host-gateway"
  b:
    image: busybox
    command: ""
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := spec.ServiceByName("a")
	if strings.Join(a.Command, " ") != "redis-server --appendonly yes" {
		t.Fatalf("scalar command not shell-split: %#v", a.Command)
	}
	if len(a.Entrypoint) != 2 || a.Entrypoint[0] != "/bin/sh" || a.Entrypoint[1] != "-c" {
		t.Fatalf("list entrypoint wrong: %#v", a.Entrypoint)
	}
	if len(a.CapAdd) != 1 || a.CapAdd[0] != "NET_ADMIN" {
		t.Fatalf("cap_add wrong: %#v", a.CapAdd)
	}
	if len(a.ExtraHosts) != 1 {
		t.Fatalf("extra_hosts wrong: %#v", a.ExtraHosts)
	}
	b, _ := spec.ServiceByName("b")
	if len(b.Command) != 0 {
		t.Fatalf("empty scalar command should be nil, got %#v", b.Command)
	}
}

// TestFromComposeEnvNullAndKeyVal covers flexEnv's null map value (-> "") and a
// list entry with no "=" (bare key -> "").
func TestFromComposeEnvNullAndKeyVal(t *testing.T) {
	mapForm := `
services:
  web:
    image: nginx
    environment:
      SET: value
      NULLED:
`
	listForm := `
services:
  web:
    image: nginx
    environment:
      - SET=value
      - BARE
`
	spec, _, err := FromCompose("p", mapForm, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	env := spec.Services[0].Env
	if env["SET"] != "value" {
		t.Fatalf("SET wrong: %#v", env)
	}
	if v, ok := env["NULLED"]; !ok || v != "" {
		t.Fatalf("null env value should be empty string present: %#v", env)
	}
	spec2, _, err := FromCompose("p", listForm, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	env2 := spec2.Services[0].Env
	if env2["SET"] != "value" || env2["BARE"] != "" {
		t.Fatalf("list env wrong: %#v", env2)
	}
}

// TestFromComposeServiceNetworksMap covers parseServiceNetworks' map form with
// per-network aliases (and a null-valued network with no aliases).
func TestFromComposeServiceNetworksMap(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    networks:
      front:
        aliases:
          - web
          - api
      back:
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc := spec.Services[0]
	if len(svc.Networks) != 2 || svc.Networks[0] != "back" || svc.Networks[1] != "front" {
		t.Fatalf("networks (sorted) wrong: %#v", svc.Networks)
	}
	if got := svc.Aliases["front"]; len(got) != 2 || got[0] != "web" || got[1] != "api" {
		t.Fatalf("front aliases wrong: %#v", svc.Aliases)
	}
	if _, ok := svc.Aliases["back"]; ok {
		t.Fatalf("back should have no aliases: %#v", svc.Aliases)
	}
}

// TestFromComposeDependsOnMap covers parseDependsOn's map (condition) form.
func TestFromComposeDependsOnMap(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
  db:
    image: postgres
  cache:
    image: redis
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	web, _ := spec.ServiceByName("web")
	if len(web.DependsOn) != 2 || web.DependsOn[0] != "cache" || web.DependsOn[1] != "db" {
		t.Fatalf("depends_on map (sorted) wrong: %#v", web.DependsOn)
	}
}

// TestFromComposeHealthcheckAndLabels covers healthcheck mapping and labels in
// both map and list forms across two services.
func TestFromComposeHealthcheckAndLabels(t *testing.T) {
	src := `
services:
  a:
    image: nginx
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    labels:
      owner: team
      tier: web
  b:
    image: nginx
    labels:
      - owner=team
      - bare
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := spec.ServiceByName("a")
	if a.Health == nil {
		t.Fatal("healthcheck not parsed")
	}
	if len(a.Health.Test) != 4 || a.Health.Interval != "30s" || a.Health.Timeout != "5s" || a.Health.Retries != 3 || a.Health.StartPeriod != "10s" {
		t.Fatalf("healthcheck wrong: %#v", a.Health)
	}
	if a.Labels["owner"] != "team" || a.Labels["tier"] != "web" {
		t.Fatalf("map labels wrong: %#v", a.Labels)
	}
	b, _ := spec.ServiceByName("b")
	if b.Labels["owner"] != "team" || b.Labels["bare"] != "" {
		t.Fatalf("list labels wrong: %#v", b.Labels)
	}
}

// TestFromComposeNetworksAndVolumes covers composeNetwork.toSpec (external, ipam,
// labels, flags) and composeVolume.toSpec (driver, driver_opts, external, labels),
// exercising flexExternal's bool, map, and false forms.
func TestFromComposeNetworksAndVolumes(t *testing.T) {
	src := `
services:
  web:
    image: nginx
networks:
  front:
    driver: bridge
    internal: true
    attachable: true
    enable_ipv6: true
    labels:
      role: edge
    ipam:
      config:
        - subnet: 10.0.0.0/24
          gateway: 10.0.0.1
  ext:
    external: true
  extmap:
    external:
      name: preexisting
  plain:
    external: false
volumes:
  data:
    driver: local
    driver_opts:
      type: nfs
      device: ":/export"
    labels:
      backup: nightly
  extvol:
    external: true
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]NetworkSpec{}
	for _, n := range spec.Networks {
		byName[n.Name] = n
	}
	front := byName["front"]
	if front.Driver != "bridge" || !front.Internal || !front.Attachable || !front.IPv6 {
		t.Fatalf("front flags wrong: %#v", front)
	}
	if front.Subnet != "10.0.0.0/24" || front.Gateway != "10.0.0.1" {
		t.Fatalf("front ipam wrong: %#v", front)
	}
	if front.Labels["role"] != "edge" {
		t.Fatalf("front labels wrong: %#v", front.Labels)
	}
	if !byName["ext"].External {
		t.Fatalf("external: true not honored: %#v", byName["ext"])
	}
	if !byName["extmap"].External {
		t.Fatalf("external map form not honored: %#v", byName["extmap"])
	}
	if byName["plain"].External {
		t.Fatalf("external: false should be false: %#v", byName["plain"])
	}

	vbyName := map[string]VolumeSpec{}
	for _, v := range spec.Volumes {
		vbyName[v.Name] = v
	}
	data := vbyName["data"]
	if data.Driver != "local" || data.Options["type"] != "nfs" || data.Options["device"] != ":/export" {
		t.Fatalf("volume data wrong: %#v", data)
	}
	if data.Labels["backup"] != "nightly" {
		t.Fatalf("volume labels wrong: %#v", data.Labels)
	}
	if !vbyName["extvol"].External {
		t.Fatalf("external volume not honored: %#v", vbyName["extvol"])
	}
}

// TestFromComposeWarnsAllUnsupported covers the remaining unsupported-key warnings
// (configs, secrets, profiles) alongside build/env_file.
func TestFromComposeWarnsAllUnsupported(t *testing.T) {
	src := `
services:
  app:
    image: myapp
    build: .
    env_file: .env
    configs:
      - conf
    secrets:
      - sec
    profiles:
      - debug
`
	_, warns, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"build", "env_file", "configs", "secrets", "profiles"} {
		if !warnsContain(warns, want) {
			t.Fatalf("missing warning for %q in %v", want, warns)
		}
	}
}

// TestFromComposeParseError covers the top-level YAML parse-error path.
func TestFromComposeParseError(t *testing.T) {
	// A scalar where a mapping is expected is invalid once decoded into composeDoc.
	if _, _, err := FromCompose("p", "services: [not, a, map]", "", nil); err == nil {
		t.Fatal("expected a parse error for a malformed compose doc")
	}
}

// TestValidate exercises every Validate branch.
func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		spec    StackSpec
		wantErr string
	}{
		{
			name:    "unnamed multi-service needs a stack name",
			spec:    StackSpec{Services: []ContainerSpec{{Image: "a"}, {Image: "b"}}},
			wantErr: "stack name is required",
		},
		{
			name:    "no services",
			spec:    StackSpec{Name: "s"},
			wantErr: "at least one service is required",
		},
		{
			name:    "missing image, unnamed service labeled by index",
			spec:    StackSpec{Name: "s", Services: []ContainerSpec{{}}},
			wantErr: "service #1: image is required",
		},
		{
			name:    "missing image, named service labeled by name",
			spec:    StackSpec{Name: "s", Services: []ContainerSpec{{Name: "web"}}},
			wantErr: "service web: image is required",
		},
		{
			name:    "duplicate service name",
			spec:    StackSpec{Name: "s", Services: []ContainerSpec{{Name: "web", Image: "a"}, {Name: "web", Image: "b"}}},
			wantErr: "duplicate service name web",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.spec.Validate()
			if err == nil {
				t.Fatalf("expected error %q, got nil", c.wantErr)
			}
			if err.Error() != c.wantErr {
				t.Fatalf("Validate error = %q, want %q", err.Error(), c.wantErr)
			}
		})
	}

	// Valid: a single unnamed service (a one-off container) needs no stack name.
	oneOff := StackSpec{Services: []ContainerSpec{{Image: "nginx"}}}
	if err := oneOff.Validate(); err != nil {
		t.Fatalf("one-off should validate, got %v", err)
	}
	// Valid: a named multi-service stack with distinct images.
	stack := StackSpec{Name: "blog", Services: []ContainerSpec{{Name: "web", Image: "nginx"}, {Name: "db", Image: "pg"}}}
	if err := stack.Validate(); err != nil {
		t.Fatalf("stack should validate, got %v", err)
	}
}

// TestServiceByName covers both the hit and miss paths.
func TestServiceByName(t *testing.T) {
	s := StackSpec{Services: []ContainerSpec{{Name: "web", Image: "nginx"}}}
	if svc, ok := s.ServiceByName("web"); !ok || svc.Image != "nginx" {
		t.Fatalf("ServiceByName(web) = (%#v, %v)", svc, ok)
	}
	if _, ok := s.ServiceByName("missing"); ok {
		t.Fatal("ServiceByName(missing) should be false")
	}
}

// TestHash locks the fingerprint contract: stable across order-insensitive
// reorderings, excludes Name and Tunnels, filters hope/compose labels, and
// changes on a real content change.
func TestHash(t *testing.T) {
	base := ContainerSpec{
		Name:       "web",
		Image:      "nginx:1.25",
		Networks:   []string{"back", "front"},
		CapAdd:     []string{"NET_ADMIN", "SYS_TIME"},
		ExtraHosts: []string{"a:1", "b:2"},
		DependsOn:  []string{"cache", "db"},
		Ports:      []PortMap{{Host: "8080", Container: "80"}, {Host: "443", Container: "443"}},
		Mounts:     []MountSpec{{Type: "volume", Source: "data", Target: "/data"}, {Type: "bind", Source: "/h", Target: "/c"}},
		Aliases:    map[string][]string{"front": {"z", "a"}},
		Labels:     map[string]string{"owner": "team", "com.docker.compose.project": "p", "ink.hope.stack": "s"},
		Tunnels:    []TunnelRoute{{Hostname: "web.example.com"}},
	}
	h1 := Hash(base)
	if h1 == "" || len(h1) != 16 { // hex of 8 bytes
		t.Fatalf("hash shape wrong: %q", h1)
	}

	// Reorder every order-insensitive slice + rename + swap tunnels: hash is stable.
	reordered := base
	reordered.Name = "different-name"
	reordered.Networks = []string{"front", "back"}
	reordered.CapAdd = []string{"SYS_TIME", "NET_ADMIN"}
	reordered.ExtraHosts = []string{"b:2", "a:1"}
	reordered.DependsOn = []string{"db", "cache"}
	reordered.Ports = []PortMap{{Host: "443", Container: "443"}, {Host: "8080", Container: "80"}}
	reordered.Mounts = []MountSpec{{Type: "bind", Source: "/h", Target: "/c"}, {Type: "volume", Source: "data", Target: "/data"}}
	reordered.Aliases = map[string][]string{"front": {"a", "z"}}
	reordered.Tunnels = nil
	// Same user labels but different hope/compose-injected ones: still stable.
	reordered.Labels = map[string]string{"owner": "team", "ink.hope.other": "x"}
	if got := Hash(reordered); got != h1 {
		t.Fatalf("hash not stable under reordering/name/tunnels/injected-labels: %q vs %q", got, h1)
	}

	// A real content change flips the hash.
	changed := base
	changed.Image = "nginx:1.26"
	if Hash(changed) == h1 {
		t.Fatal("hash unchanged after image bump")
	}

	// A user-label change flips the hash (empty label map hashes as no labels).
	relabeled := base
	relabeled.Labels = map[string]string{"owner": "other"}
	if Hash(relabeled) == h1 {
		t.Fatal("hash unchanged after user-label change")
	}
	// Only-injected labels hash the same as no labels at all.
	onlyInjected := base
	onlyInjected.Labels = map[string]string{"com.docker.compose.x": "1"}
	noLabels := base
	noLabels.Labels = nil
	if Hash(onlyInjected) != Hash(noLabels) {
		t.Fatal("only-injected labels should hash like no labels")
	}
}

// TestTopoSortCycleAndUnknown covers the best-effort branches: a dependency cycle
// and an unknown dependency neither drop nor loop forever.
func TestTopoSortCycleAndUnknown(t *testing.T) {
	// a -> b -> a cycle, plus c depends on a ghost service.
	s := StackSpec{
		Name: "s",
		Services: []ContainerSpec{
			{Name: "a", Image: "x", DependsOn: []string{"b"}},
			{Name: "b", Image: "x", DependsOn: []string{"a"}},
			{Name: "c", Image: "x", DependsOn: []string{"ghost"}},
		},
	}
	order := s.TopoSort()
	if len(order) != 3 {
		t.Fatalf("cycle/unknown dropped a service: %d of 3", len(order))
	}
	seen := map[string]bool{}
	for _, svc := range order {
		if seen[svc.Name] {
			t.Fatalf("service %q emitted twice", svc.Name)
		}
		seen[svc.Name] = true
	}
	if !seen["a"] || !seen["b"] || !seen["c"] {
		t.Fatalf("missing a service: %v", seen)
	}

	// An unnamed one-off service is emitted too.
	one := StackSpec{Services: []ContainerSpec{{Image: "x"}}}
	if got := one.TopoSort(); len(got) != 1 {
		t.Fatalf("unnamed service topo len = %d, want 1", len(got))
	}
}

// TestToComposeFullRoundTrip renders a richly-populated spec and re-parses it,
// exercising ToCompose's mount/port/network-alias/volume/healthcheck branches
// plus portString/mountString.
func TestToComposeFullRoundTrip(t *testing.T) {
	spec := &StackSpec{
		Name: "full",
		Services: []ContainerSpec{{
			Name:       "web",
			Image:      "nginx:1.25",
			Command:    []string{"nginx", "-g", "daemon off;"},
			Entrypoint: []string{"/entry.sh"},
			Env:        map[string]string{"FOO": "bar"},
			Ports: []PortMap{
				{HostIP: "127.0.0.1", Host: "8080", Container: "80"},
				{Host: "5353", Container: "53", Protocol: "udp"},
				{Container: "9090"},
			},
			Mounts: []MountSpec{
				{Type: "bind", Source: "/host", Target: "/etc/conf", ReadOnly: true},
				{Type: "volume", Source: "data", Target: "/data"},
				{Type: "volume", Source: "", Target: "/anon"},
			},
			Networks:   []string{"front", "back"},
			Aliases:    map[string][]string{"front": {"web", "api"}},
			Restart:    "unless-stopped",
			User:       "1000:1000",
			WorkingDir: "/srv",
			Privileged: true,
			CapAdd:     []string{"NET_ADMIN"},
			ExtraHosts: []string{"host:1.2.3.4"},
			DependsOn:  []string{"db"},
			Labels:     map[string]string{"owner": "team"},
			Health: &HealthSpec{
				Test:        []string{"CMD", "true"},
				Interval:    "30s",
				Timeout:     "5s",
				Retries:     3,
				StartPeriod: "10s",
			},
			Tunnels: []TunnelRoute{{Connector: "c1", Hostname: "web.example.com", Port: "80"}},
		}, {
			Image: "postgres:16", // an unnamed service renders under the "app" key
		}},
		Networks: []NetworkSpec{
			{Name: "front", Driver: "bridge", Internal: true, Attachable: true, IPv6: true, Subnet: "10.0.0.0/24", Gateway: "10.0.0.1"},
			{Name: "back", External: true},
			{Name: "bare"}, // no fields -> nil map form
		},
		Volumes: []VolumeSpec{
			{Name: "data", Driver: "local", Options: map[string]string{"type": "nfs"}},
			{Name: "extvol", External: true},
			{Name: "barevol"}, // no fields -> nil map form
		},
	}

	out, err := ToCompose(spec)
	if err != nil {
		t.Fatalf("ToCompose: %v", err)
	}
	spec2, _, err := FromCompose("full", out, "", nil)
	if err != nil {
		t.Fatalf("re-parse failed: %v\n%s", err, out)
	}

	web, ok := spec2.ServiceByName("web")
	if !ok {
		t.Fatalf("web missing after round-trip\n%s", out)
	}
	if web.Image != "nginx:1.25" || web.Restart != "unless-stopped" || web.User != "1000:1000" || web.WorkingDir != "/srv" || !web.Privileged {
		t.Fatalf("web scalars lost: %#v", web)
	}
	if len(web.Ports) != 3 {
		t.Fatalf("ports lost: %#v", web.Ports)
	}
	// The udp port must round-trip its protocol; the 127.0.0.1 one its host IP.
	var haveUDP, haveHostIP bool
	for _, p := range web.Ports {
		if p.Protocol == "udp" && p.Host == "5353" && p.Container == "53" {
			haveUDP = true
		}
		if p.HostIP == "127.0.0.1" && p.Host == "8080" && p.Container == "80" {
			haveHostIP = true
		}
	}
	if !haveUDP || !haveHostIP {
		t.Fatalf("port detail lost: udp=%v hostip=%v (%#v)", haveUDP, haveHostIP, web.Ports)
	}
	if len(web.Mounts) != 3 {
		t.Fatalf("mounts lost: %#v", web.Mounts)
	}
	if len(web.Networks) != 2 {
		t.Fatalf("networks lost: %#v", web.Networks)
	}
	if got := web.Aliases["front"]; len(got) != 2 {
		t.Fatalf("aliases lost: %#v", web.Aliases)
	}
	if web.Health == nil || web.Health.Interval != "30s" || web.Health.Retries != 3 {
		t.Fatalf("healthcheck lost: %#v", web.Health)
	}
	if len(web.Tunnels) != 1 || web.Tunnels[0].Hostname != "web.example.com" {
		t.Fatalf("tunnels lost: %#v", web.Tunnels)
	}
	if web.Labels["owner"] != "team" {
		t.Fatalf("labels lost: %#v", web.Labels)
	}
	// The unnamed service rendered under the default "app" key.
	if _, ok := spec2.ServiceByName("app"); !ok {
		t.Fatalf("unnamed service not keyed as app\n%s", out)
	}

	// Networks + volumes round-trip, including external + bare (nil) forms.
	nbyName := map[string]NetworkSpec{}
	for _, n := range spec2.Networks {
		nbyName[n.Name] = n
	}
	if f := nbyName["front"]; f.Subnet != "10.0.0.0/24" || !f.Internal || !f.IPv6 {
		t.Fatalf("front network lost: %#v", f)
	}
	if !nbyName["back"].External {
		t.Fatalf("external network lost: %#v", nbyName["back"])
	}
	if _, ok := nbyName["bare"]; !ok {
		t.Fatalf("bare network dropped\n%s", out)
	}
	vbyName := map[string]VolumeSpec{}
	for _, v := range spec2.Volumes {
		vbyName[v.Name] = v
	}
	if vbyName["data"].Options["type"] != "nfs" {
		t.Fatalf("volume opts lost: %#v", vbyName["data"])
	}
	if !vbyName["extvol"].External {
		t.Fatalf("external volume lost: %#v", vbyName["extvol"])
	}
	if _, ok := vbyName["barevol"]; !ok {
		t.Fatalf("bare volume dropped\n%s", out)
	}
}

// TestToComposeMinimal renders a bare one-off (empty service name, no extras) so
// the default "app" key and the no-networks/no-volumes branches are exercised.
func TestToComposeMinimal(t *testing.T) {
	out, err := ToCompose(&StackSpec{Services: []ContainerSpec{{Image: "busybox"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "app:") || !strings.Contains(out, "busybox") {
		t.Fatalf("minimal render wrong:\n%s", out)
	}
	if strings.Contains(out, "networks:") || strings.Contains(out, "volumes:") {
		t.Fatalf("minimal render should have no networks/volumes:\n%s", out)
	}
}

// TestInterpolateUnterminatedAndTrailing covers interpolate's edge branches: a
// trailing lone '$', an unterminated ${, and a '$' before a non-name byte.
func TestInterpolateUnterminatedAndTrailing(t *testing.T) {
	vars := map[string]string{"A": "1"}
	cases := []struct{ in, want string }{
		{"trailing$", "trailing$"},          // lone $ at end
		{"open ${A", "open ${A"},            // unterminated brace, emitted verbatim
		{"cost $5", "cost $5"},              // $ before a digit (not a name start)
		{"a${A}b", "a1b"},                    // sanity
	}
	for _, c := range cases {
		if got := interpolate(c.in, vars); got != c.want {
			t.Errorf("interpolate(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestScalarStringAndItoa directly exercises the numeric/format helpers across
// every switch arm (in-package white-box test).
func TestScalarStringAndItoa(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{"str", "str"},
		{int(42), "42"},
		{int64(64), "64"},
		{float64(80), "80"},
		{nil, ""},
		{true, "true"}, // default arm -> fmt.Sprintf
	}
	for _, c := range cases {
		if got := scalarString(c.in); got != c.want {
			t.Errorf("scalarString(%v) = %q, want %q", c.in, got, c.want)
		}
	}
	for _, c := range []struct {
		n    int
		want string
	}{{0, "0"}, {7, "7"}, {-42, "-42"}} {
		if got := itoa(c.n); got != c.want {
			t.Errorf("itoa(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}

// TestScalarPortStringForm covers the scalar-node long-port path where target is a
// quoted string and published is a float (scalarString string + float64 arms).
func TestScalarPortStringForm(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    ports:
      - target: "70"
        published: 7070.0
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	p := spec.Services[0].Ports
	if len(p) != 1 || p[0].Container != "70" || p[0].Host != "7070" {
		t.Fatalf("string/float long port wrong: %#v", p)
	}
}

// TestMalformedPortsAndMounts covers the parser fall-through/default branches:
// too-many-colons short forms and non-scalar/non-map nodes are skipped (warned).
func TestMalformedPortsAndMounts(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    ports:
      - "1:2:3:4:5"
      - [80, 90]
      - ""
    volumes:
      - "a:b:c:d"
      - [x, y]
      - ""
`
	spec, warns, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Services[0].Ports) != 0 {
		t.Fatalf("no ports should parse: %#v", spec.Services[0].Ports)
	}
	if len(spec.Services[0].Mounts) != 0 {
		t.Fatalf("no mounts should parse: %#v", spec.Services[0].Mounts)
	}
	if !warnsContain(warns, "ports") || !warnsContain(warns, "volumes") {
		t.Fatalf("expected skip warnings for both, got: %v", warns)
	}
}

// TestHashEmptySpec covers the len==0 early-return guards in the sort helpers and
// userLabels (an empty service hashes without touching the sort bodies).
func TestHashEmptySpec(t *testing.T) {
	h := Hash(ContainerSpec{Image: "busybox"})
	if h == "" || len(h) != 16 {
		t.Fatalf("empty-spec hash shape wrong: %q", h)
	}
	// Two empty specs with differing Name/Tunnels hash identically.
	if Hash(ContainerSpec{Image: "busybox", Name: "a", Tunnels: []TunnelRoute{{Hostname: "x"}}}) != h {
		t.Fatal("empty-spec hash should ignore Name/Tunnels")
	}
}

// TestInterpolateBareRequired covers expandBraced's ${VAR?err} (bare '?') form.
func TestInterpolateBareRequired(t *testing.T) {
	vars := map[string]string{"A": "1"}
	if got := interpolate("x: ${A?required}", vars); got != "x: 1" {
		t.Fatalf("bare-? required form wrong: %q", got)
	}
	if got := interpolate("x: ${MISSING?required}", vars); got != "x: " {
		t.Fatalf("bare-? missing form wrong: %q", got)
	}
}

func warnsContain(warns []Warning, sub string) bool {
	for _, w := range warns {
		if strings.Contains(w.Message, sub) {
			return true
		}
	}
	return false
}
