package stackspec

import (
	"fmt"
	"sort"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// FromCompose parses a practical subset of a compose file into a StackSpec,
// interpolating ${VAR} against dotenv (an uploaded .env text) + the supplied
// environment. Unsupported keys are reported as warnings, never errors, so a
// deploy log is honest about what was skipped. project names the stack (compose
// files carry no project name of their own).
func FromCompose(project, composeYAML, dotenv string, env map[string]string) (*StackSpec, []Warning, error) {
	vars := mergeEnv(parseDotenv(dotenv), env)
	interpolated := interpolate(composeYAML, vars)

	var doc composeDoc
	if err := yaml.Unmarshal([]byte(interpolated), &doc); err != nil {
		return nil, nil, fmt.Errorf("parse compose: %w", err)
	}

	spec := &StackSpec{Name: strings.TrimSpace(project)}
	var warns []Warning

	names := make([]string, 0, len(doc.Services))
	for name := range doc.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		svc := doc.Services[name]
		cs, w := svc.toSpec(name)
		spec.Services = append(spec.Services, cs)
		warns = append(warns, w...)
	}

	for _, name := range sortedKeys(doc.Networks) {
		spec.Networks = append(spec.Networks, doc.Networks[name].toSpec(name))
	}
	for _, name := range sortedKeys(doc.Volumes) {
		spec.Volumes = append(spec.Volumes, doc.Volumes[name].toSpec(name))
	}
	return spec, warns, nil
}

// ── compose document shape ──────────────────────────────────────────────────

type composeDoc struct {
	Services map[string]composeService `yaml:"services"`
	Networks map[string]composeNetwork `yaml:"networks"`
	Volumes  map[string]composeVolume  `yaml:"volumes"`
}

type composeService struct {
	Image         string        `yaml:"image"`
	ContainerName string        `yaml:"container_name"`
	Command       flexStrList   `yaml:"command"`
	Entrypoint    flexStrList   `yaml:"entrypoint"`
	Environment   flexEnv       `yaml:"environment"`
	Ports         []yaml.Node   `yaml:"ports"`
	Volumes       []yaml.Node   `yaml:"volumes"`
	Networks      yaml.Node     `yaml:"networks"`
	Restart       string        `yaml:"restart"`
	User          string        `yaml:"user"`
	WorkingDir    string        `yaml:"working_dir"`
	Privileged    bool          `yaml:"privileged"`
	CapAdd        flexStrList   `yaml:"cap_add"`
	ExtraHosts    flexStrList   `yaml:"extra_hosts"`
	DependsOn     yaml.Node     `yaml:"depends_on"`
	Healthcheck   *composeHealth `yaml:"healthcheck"`
	Labels        flexEnv       `yaml:"labels"`
	HopeTunnels   []TunnelRoute `yaml:"x-hope-tunnels"`

	// Unsupported — presence triggers a warning.
	Build   yaml.Node `yaml:"build"`
	EnvFile yaml.Node `yaml:"env_file"`
	Configs yaml.Node `yaml:"configs"`
	Secrets yaml.Node `yaml:"secrets"`
	Profiles yaml.Node `yaml:"profiles"`
}

type composeHealth struct {
	Test        flexStrList `yaml:"test"`
	Interval    string      `yaml:"interval"`
	Timeout     string      `yaml:"timeout"`
	Retries     int         `yaml:"retries"`
	StartPeriod string      `yaml:"start_period"`
}

type composeNetwork struct {
	Driver     string            `yaml:"driver"`
	Internal   bool              `yaml:"internal"`
	Attachable bool              `yaml:"attachable"`
	EnableIPv6 bool              `yaml:"enable_ipv6"`
	External   flexExternal      `yaml:"external"`
	Labels     flexEnv           `yaml:"labels"`
	IPAM       struct {
		Config []struct {
			Subnet  string `yaml:"subnet"`
			Gateway string `yaml:"gateway"`
		} `yaml:"config"`
	} `yaml:"ipam"`
}

type composeVolume struct {
	Driver     string       `yaml:"driver"`
	DriverOpts map[string]string `yaml:"driver_opts"`
	External   flexExternal `yaml:"external"`
	Labels     flexEnv      `yaml:"labels"`
}

// ── conversions to StackSpec ────────────────────────────────────────────────

func (s composeService) toSpec(name string) (ContainerSpec, []Warning) {
	var warns []Warning
	warn := func(msg string) { warns = append(warns, Warning{Service: name, Message: msg}) }

	if !s.Build.IsZero() {
		warn("`build:` is unsupported (hope deploys images, no build context) — set an `image:` instead")
	}
	if !s.EnvFile.IsZero() {
		warn("`env_file:` is unsupported (no host filesystem) — paste variables into the .env box for ${VAR} interpolation")
	}
	if !s.Configs.IsZero() {
		warn("`configs:` is unsupported and was ignored")
	}
	if !s.Secrets.IsZero() {
		warn("`secrets:` is unsupported and was ignored")
	}
	if !s.Profiles.IsZero() {
		warn("`profiles:` is unsupported and was ignored")
	}

	cs := ContainerSpec{
		Name:       name,
		Image:      s.Image,
		Command:    s.Command,
		Entrypoint: s.Entrypoint,
		Env:        s.Environment,
		Restart:    s.Restart,
		User:       s.User,
		WorkingDir: s.WorkingDir,
		Privileged: s.Privileged,
		CapAdd:     s.CapAdd,
		ExtraHosts: s.ExtraHosts,
		Labels:     s.Labels,
		Tunnels:    s.HopeTunnels,
	}
	for _, pn := range s.Ports {
		if p, ok := parsePort(pn); ok {
			cs.Ports = append(cs.Ports, p)
		} else {
			warn("could not parse a ports entry — skipped")
		}
	}
	for _, vn := range s.Volumes {
		if m, ok := parseMount(vn); ok {
			cs.Mounts = append(cs.Mounts, m)
		} else {
			warn("could not parse a volumes entry — skipped")
		}
	}
	cs.Networks = parseServiceNetworks(s.Networks)
	cs.DependsOn = parseDependsOn(s.DependsOn)
	if s.Healthcheck != nil {
		cs.Health = &HealthSpec{
			Test:        s.Healthcheck.Test,
			Interval:    s.Healthcheck.Interval,
			Timeout:     s.Healthcheck.Timeout,
			Retries:     s.Healthcheck.Retries,
			StartPeriod: s.Healthcheck.StartPeriod,
		}
	}
	return cs, warns
}

func (n composeNetwork) toSpec(name string) NetworkSpec {
	ns := NetworkSpec{
		Name:       name,
		Driver:     n.Driver,
		Internal:   n.Internal,
		Attachable: n.Attachable,
		IPv6:       n.EnableIPv6,
		External:   bool(n.External),
		Labels:     n.Labels,
	}
	if len(n.IPAM.Config) > 0 {
		ns.Subnet = n.IPAM.Config[0].Subnet
		ns.Gateway = n.IPAM.Config[0].Gateway
	}
	return ns
}

func (v composeVolume) toSpec(name string) VolumeSpec {
	return VolumeSpec{
		Name:     name,
		Driver:   v.Driver,
		Options:  v.DriverOpts,
		External: bool(v.External),
		Labels:   v.Labels,
	}
}

// ── ToCompose ───────────────────────────────────────────────────────────────

// ToCompose renders a StackSpec back to a compose YAML document (compose v2 —
// no top-level version). Tunnel routes ride along as an `x-hope-tunnels`
// extension per service so an export round-trips through FromCompose.
func ToCompose(spec *StackSpec) (string, error) {
	services := map[string]any{}
	for _, s := range spec.Services {
		m := map[string]any{"image": s.Image}
		if len(s.Command) > 0 {
			m["command"] = s.Command
		}
		if len(s.Entrypoint) > 0 {
			m["entrypoint"] = s.Entrypoint
		}
		if len(s.Env) > 0 {
			m["environment"] = s.Env
		}
		if len(s.Ports) > 0 {
			ports := make([]string, 0, len(s.Ports))
			for _, p := range s.Ports {
				ports = append(ports, portString(p))
			}
			m["ports"] = ports
		}
		if len(s.Mounts) > 0 {
			vols := make([]string, 0, len(s.Mounts))
			for _, mt := range s.Mounts {
				vols = append(vols, mountString(mt))
			}
			m["volumes"] = vols
		}
		if len(s.Networks) > 0 {
			m["networks"] = s.Networks
		}
		if s.Restart != "" {
			m["restart"] = s.Restart
		}
		if s.User != "" {
			m["user"] = s.User
		}
		if s.WorkingDir != "" {
			m["working_dir"] = s.WorkingDir
		}
		if s.Privileged {
			m["privileged"] = true
		}
		if len(s.CapAdd) > 0 {
			m["cap_add"] = s.CapAdd
		}
		if len(s.ExtraHosts) > 0 {
			m["extra_hosts"] = s.ExtraHosts
		}
		if len(s.DependsOn) > 0 {
			m["depends_on"] = s.DependsOn
		}
		if len(s.Labels) > 0 {
			m["labels"] = s.Labels
		}
		if s.Health != nil {
			h := map[string]any{}
			if len(s.Health.Test) > 0 {
				h["test"] = s.Health.Test
			}
			if s.Health.Interval != "" {
				h["interval"] = s.Health.Interval
			}
			if s.Health.Timeout != "" {
				h["timeout"] = s.Health.Timeout
			}
			if s.Health.Retries > 0 {
				h["retries"] = s.Health.Retries
			}
			if s.Health.StartPeriod != "" {
				h["start_period"] = s.Health.StartPeriod
			}
			m["healthcheck"] = h
		}
		if len(s.Tunnels) > 0 {
			m["x-hope-tunnels"] = s.Tunnels
		}
		key := s.Name
		if key == "" {
			key = "app"
		}
		services[key] = m
	}

	doc := map[string]any{"services": services}
	if len(spec.Networks) > 0 {
		nets := map[string]any{}
		for _, n := range spec.Networks {
			nm := map[string]any{}
			if n.Driver != "" {
				nm["driver"] = n.Driver
			}
			if n.Internal {
				nm["internal"] = true
			}
			if n.Attachable {
				nm["attachable"] = true
			}
			if n.IPv6 {
				nm["enable_ipv6"] = true
			}
			if n.External {
				nm["external"] = true
			}
			if n.Subnet != "" || n.Gateway != "" {
				nm["ipam"] = map[string]any{"config": []any{map[string]any{"subnet": n.Subnet, "gateway": n.Gateway}}}
			}
			if len(nm) == 0 {
				nets[n.Name] = nil
			} else {
				nets[n.Name] = nm
			}
		}
		doc["networks"] = nets
	}
	if len(spec.Volumes) > 0 {
		vols := map[string]any{}
		for _, v := range spec.Volumes {
			vm := map[string]any{}
			if v.Driver != "" {
				vm["driver"] = v.Driver
			}
			if len(v.Options) > 0 {
				vm["driver_opts"] = v.Options
			}
			if v.External {
				vm["external"] = true
			}
			if len(vm) == 0 {
				vols[v.Name] = nil
			} else {
				vols[v.Name] = vm
			}
		}
		doc["volumes"] = vols
	}

	out, err := yaml.Marshal(doc)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ── flexible yaml field types ───────────────────────────────────────────────

// flexStrList accepts either a scalar string or a list of strings. A bare string
// is shell-split so `command: redis-server --appendonly yes` behaves like compose.
type flexStrList []string

func (f *flexStrList) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		if n.Value == "" {
			return nil
		}
		*f = strings.Fields(n.Value)
	case yaml.SequenceNode:
		var s []string
		if err := n.Decode(&s); err != nil {
			return err
		}
		*f = s
	}
	return nil
}

// flexEnv accepts either a map (KEY: val) or a list of "KEY=val" strings.
type flexEnv map[string]string

func (f *flexEnv) UnmarshalYAML(n *yaml.Node) error {
	out := map[string]string{}
	switch n.Kind {
	case yaml.MappingNode:
		raw := map[string]*string{}
		if err := n.Decode(&raw); err != nil {
			return err
		}
		for k, v := range raw {
			if v == nil {
				out[k] = ""
			} else {
				out[k] = *v
			}
		}
	case yaml.SequenceNode:
		var list []string
		if err := n.Decode(&list); err != nil {
			return err
		}
		for _, item := range list {
			k, v, _ := strings.Cut(item, "=")
			out[strings.TrimSpace(k)] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	*f = out
	return nil
}

// flexExternal accepts `external: true` or the map form `external: {name: ...}`.
type flexExternal bool

func (f *flexExternal) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		*f = flexExternal(n.Value == "true" || n.Value == "yes")
	case yaml.MappingNode:
		*f = true
	}
	return nil
}

// ── entry parsers ───────────────────────────────────────────────────────────

// parsePort handles the short string form ("8080:80", "127.0.0.1:8080:80/tcp",
// "80") and the long map form ({target, published, protocol}).
func parsePort(n yaml.Node) (PortMap, bool) {
	switch n.Kind {
	case yaml.ScalarNode:
		return parsePortString(n.Value)
	case yaml.MappingNode:
		var long struct {
			Target    any    `yaml:"target"`
			Published any    `yaml:"published"`
			Protocol  string `yaml:"protocol"`
			HostIP    string `yaml:"host_ip"`
		}
		if err := n.Decode(&long); err != nil {
			return PortMap{}, false
		}
		p := PortMap{
			Container: scalarString(long.Target),
			Host:      scalarString(long.Published),
			Protocol:  long.Protocol,
			HostIP:    long.HostIP,
		}
		if p.Container == "" {
			return PortMap{}, false
		}
		return p, true
	}
	return PortMap{}, false
}

func parsePortString(v string) (PortMap, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return PortMap{}, false
	}
	proto := "tcp"
	if i := strings.LastIndex(v, "/"); i >= 0 {
		proto = v[i+1:]
		v = v[:i]
	}
	parts := strings.Split(v, ":")
	p := PortMap{Protocol: proto}
	switch len(parts) {
	case 1: // "80" — container port only
		p.Container = parts[0]
	case 2: // "8080:80"
		p.Host = parts[0]
		p.Container = parts[1]
	case 3: // "127.0.0.1:8080:80"
		p.HostIP = parts[0]
		p.Host = parts[1]
		p.Container = parts[2]
	default:
		return PortMap{}, false
	}
	if p.Container == "" {
		return PortMap{}, false
	}
	return p, true
}

// parseMount handles "src:dst[:ro]" (bind if src looks like a path, else a named
// volume) and the long map form ({type, source, target, read_only}).
func parseMount(n yaml.Node) (MountSpec, bool) {
	switch n.Kind {
	case yaml.ScalarNode:
		return parseMountString(n.Value)
	case yaml.MappingNode:
		var long struct {
			Type     string `yaml:"type"`
			Source   string `yaml:"source"`
			Target   string `yaml:"target"`
			ReadOnly bool   `yaml:"read_only"`
		}
		if err := n.Decode(&long); err != nil {
			return MountSpec{}, false
		}
		if long.Target == "" {
			return MountSpec{}, false
		}
		if long.Type == "" {
			long.Type = "volume"
			if isHostPath(long.Source) {
				long.Type = "bind"
			}
		}
		return MountSpec{Type: long.Type, Source: long.Source, Target: long.Target, ReadOnly: long.ReadOnly}, true
	}
	return MountSpec{}, false
}

func parseMountString(v string) (MountSpec, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return MountSpec{}, false
	}
	parts := strings.Split(v, ":")
	m := MountSpec{}
	switch len(parts) {
	case 1: // anonymous volume at a path
		m.Type = "volume"
		m.Target = parts[0]
	case 2:
		m.Source, m.Target = parts[0], parts[1]
	case 3:
		m.Source, m.Target = parts[0], parts[1]
		m.ReadOnly = parts[2] == "ro"
	default:
		return MountSpec{}, false
	}
	if m.Type == "" {
		m.Type = "volume"
		if isHostPath(m.Source) {
			m.Type = "bind"
		}
	}
	if m.Target == "" {
		return MountSpec{}, false
	}
	return m, true
}

func parseServiceNetworks(n yaml.Node) []string {
	switch n.Kind {
	case yaml.SequenceNode:
		var list []string
		_ = n.Decode(&list)
		return list
	case yaml.MappingNode:
		var m map[string]yaml.Node
		_ = n.Decode(&m)
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	return nil
}

func parseDependsOn(n yaml.Node) []string {
	switch n.Kind {
	case yaml.SequenceNode:
		var list []string
		_ = n.Decode(&list)
		return list
	case yaml.MappingNode:
		var m map[string]yaml.Node
		_ = n.Decode(&m)
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	return nil
}

// ── helpers ─────────────────────────────────────────────────────────────────

func isHostPath(s string) bool {
	return strings.HasPrefix(s, "/") || strings.HasPrefix(s, "./") || strings.HasPrefix(s, "../") || strings.HasPrefix(s, "~")
}

func portString(p PortMap) string {
	s := ""
	switch {
	case p.HostIP != "":
		s = p.HostIP + ":" + p.Host + ":" + p.Container
	case p.Host != "":
		s = p.Host + ":" + p.Container
	default:
		s = p.Container
	}
	if p.Protocol != "" && p.Protocol != "tcp" {
		s += "/" + p.Protocol
	}
	return s
}

func mountString(m MountSpec) string {
	s := m.Source + ":" + m.Target
	if m.Source == "" {
		s = m.Target
	}
	if m.ReadOnly {
		s += ":ro"
	}
	return s
}

func scalarString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case int:
		return itoa(t)
	case int64:
		return itoa(int(t))
	case float64:
		return itoa(int(t))
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", t)
	}
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
