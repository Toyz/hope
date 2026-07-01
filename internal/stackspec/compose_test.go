package stackspec

import (
	"strings"
	"testing"
)

func TestInterpolate(t *testing.T) {
	vars := map[string]string{"TAG": "1.2", "EMPTY": ""}
	cases := []struct{ in, want string }{
		{"image: nginx:${TAG}", "image: nginx:1.2"},
		{"image: nginx:$TAG", "image: nginx:1.2"},
		{"x: ${MISSING}", "x: "},
		{"x: ${MISSING:-def}", "x: def"},
		{"x: ${EMPTY:-def}", "x: def"},      // empty -> default
		{"x: ${EMPTY-def}", "x: "},          // set-but-empty -> keep empty
		{"x: ${MISSING-def}", "x: def"},     // unset -> default
		{"x: ${TAG:?required}", "x: 1.2"},   // present, error ignored
		{"lit: $$HOME", "lit: $HOME"},       // $$ escapes
	}
	for _, c := range cases {
		if got := interpolate(c.in, vars); got != c.want {
			t.Errorf("interpolate(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseDotenv(t *testing.T) {
	env := parseDotenv("# comment\nexport A=1\nB=\"two words\"\nC='x'\n\nBAD LINE\n")
	if env["A"] != "1" || env["B"] != "two words" || env["C"] != "x" {
		t.Fatalf("dotenv parse wrong: %#v", env)
	}
}

func TestFromComposeEnvForms(t *testing.T) {
	// environment as a map and as a list must both parse.
	mapForm := `
services:
  web:
    image: nginx
    environment:
      FOO: bar
      N: "3"
`
	listForm := `
services:
  web:
    image: nginx
    environment:
      - FOO=bar
      - N=3
`
	for _, src := range []string{mapForm, listForm} {
		spec, _, err := FromCompose("p", src, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		svc := spec.Services[0]
		if svc.Env["FOO"] != "bar" || svc.Env["N"] != "3" {
			t.Fatalf("env parse wrong: %#v", svc.Env)
		}
	}
}

func TestFromComposePortsAndVolumes(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
      - "127.0.0.1:9000:9000/udp"
      - "443"
    volumes:
      - data:/var/lib/data
      - /host/path:/etc/conf:ro
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc := spec.Services[0]
	if len(svc.Ports) != 3 {
		t.Fatalf("want 3 ports, got %d: %#v", len(svc.Ports), svc.Ports)
	}
	// find the udp one
	var udp *PortMap
	for i := range svc.Ports {
		if svc.Ports[i].Protocol == "udp" {
			udp = &svc.Ports[i]
		}
	}
	if udp == nil || udp.HostIP != "127.0.0.1" || udp.Host != "9000" || udp.Container != "9000" {
		t.Fatalf("udp port parse wrong: %#v", udp)
	}
	if len(svc.Mounts) != 2 {
		t.Fatalf("want 2 mounts, got %d", len(svc.Mounts))
	}
	var bind, vol *MountSpec
	for i := range svc.Mounts {
		if svc.Mounts[i].Type == "bind" {
			bind = &svc.Mounts[i]
		} else {
			vol = &svc.Mounts[i]
		}
	}
	if vol == nil || vol.Source != "data" || vol.Target != "/var/lib/data" {
		t.Fatalf("volume mount wrong: %#v", vol)
	}
	if bind == nil || bind.Source != "/host/path" || !bind.ReadOnly {
		t.Fatalf("bind mount wrong: %#v", bind)
	}
}

func TestFromComposeDependsOnTopoSort(t *testing.T) {
	src := `
services:
  web:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres
`
	spec, _, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	order := spec.TopoSort()
	if len(order) != 2 || order[0].Name != "db" || order[1].Name != "web" {
		t.Fatalf("topo order wrong: %s then %s", order[0].Name, order[1].Name)
	}
}

func TestFromComposeWarnsUnsupported(t *testing.T) {
	src := `
services:
  app:
    image: myapp
    build: .
    env_file: .env.prod
`
	_, warns, err := FromCompose("p", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, w := range warns {
		joined += w.Message + "\n"
	}
	if !strings.Contains(joined, "build") || !strings.Contains(joined, "env_file") {
		t.Fatalf("expected build + env_file warnings, got: %s", joined)
	}
}

func TestComposeRoundTrip(t *testing.T) {
	src := `
services:
  web:
    image: nginx:1.25
    restart: unless-stopped
    ports:
      - "8080:80"
    environment:
      FOO: bar
    networks:
      - front
    x-hope-tunnels:
      - connector: abc
        hostname: web.example.com
        port: "80"
networks:
  front:
    driver: bridge
`
	spec, _, err := FromCompose("blog", src, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	out, err := ToCompose(spec)
	if err != nil {
		t.Fatal(err)
	}
	spec2, _, err := FromCompose("blog", out, "", nil)
	if err != nil {
		t.Fatalf("re-parse failed: %v\n%s", err, out)
	}
	s2 := spec2.Services[0]
	if s2.Image != "nginx:1.25" || s2.Restart != "unless-stopped" {
		t.Fatalf("round-trip lost fields: %#v", s2)
	}
	if len(s2.Tunnels) != 1 || s2.Tunnels[0].Hostname != "web.example.com" {
		t.Fatalf("round-trip lost tunnels: %#v", s2.Tunnels)
	}
	if len(spec2.Networks) != 1 || spec2.Networks[0].Name != "front" {
		t.Fatalf("round-trip lost networks: %#v", spec2.Networks)
	}
}
