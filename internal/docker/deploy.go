package docker

import (
	"context"
	"fmt"
	"maps"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/go-connections/nat"
	"github.com/toyz/hope/internal/stackspec"
)

// Deploy primitives: create a container / network / volume from a structured
// spec, entirely through the Docker API (works over the agent tunnel like every
// other op). These are the write-path counterparts to the read-only listing in
// resources.go. Higher-level orchestration (diff-apply of a whole stack) lives
// in internal/deploy; this file just turns one spec into one Docker object.

// labelManaged marks a container/network/volume hope created via a deploy, so
// the UI and teardown can tell hope-owned objects from externally-created ones.
const labelManaged = "ink.hope.managed"

// CreateContainer creates and starts a container from spec under the given
// docker name. spec.Labels, spec.Networks and spec.Image are taken as final
// (the deploy engine resolves compose labels, network name prefixes, etc.
// before calling). When pull is true the image is pulled first, streaming
// progress to emit. Returns the new container id.
func (c *Client) CreateContainer(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error) {
	if emit == nil {
		emit = func(string) {}
	}
	if strings.TrimSpace(spec.Image) == "" {
		return "", fmt.Errorf("service %q: image is required", name)
	}
	if pull {
		emit("pull " + spec.Image)
		if err := c.PullImageStream(ctx, spec.Image, emit); err != nil {
			return "", err
		}
	}

	cfg := &container.Config{
		Image:      spec.Image,
		Cmd:        spec.Command,
		Entrypoint: spec.Entrypoint,
		Env:        envSlice(spec.Env),
		User:       spec.User,
		WorkingDir: spec.WorkingDir,
		Labels:     spec.Labels,
	}
	exposed, bindings, err := portMaps(spec.Ports)
	if err != nil {
		return "", fmt.Errorf("service %q: %w", name, err)
	}
	cfg.ExposedPorts = exposed
	if h := healthConfig(spec.Health); h != nil {
		cfg.Healthcheck = h
	}

	host := &container.HostConfig{
		PortBindings:  bindings,
		Binds:         binds(spec.Mounts),
		RestartPolicy: restartPolicy(spec.Restart),
		Privileged:    spec.Privileged,
		CapAdd:        spec.CapAdd,
		ExtraHosts:    spec.ExtraHosts,
	}

	// Primary network (with the service alias + any custom aliases for in-stack
	// DNS); the rest are connected after create, mirroring Recreate.
	nets := append([]string(nil), spec.Networks...)
	sort.Strings(nets)
	netCfg := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{}}
	if len(nets) > 0 {
		netCfg.EndpointsConfig[nets[0]] = &network.EndpointSettings{Aliases: endpointAliases(spec, nets[0])}
	}

	created, err := c.sdk().ContainerCreate(ctx, cfg, host, netCfg, nil, name)
	if err != nil {
		return "", fmt.Errorf("create %s: %w", name, err)
	}
	for _, n := range nets[1:] {
		if err := c.sdk().NetworkConnect(ctx, n, created.ID, &network.EndpointSettings{Aliases: endpointAliases(spec, n)}); err != nil {
			return "", fmt.Errorf("connect %s to %s: %w", name, n, err)
		}
	}
	if err := c.sdk().ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return "", fmt.Errorf("start %s: %w", name, err)
	}
	emit("started " + name)
	return created.ID, nil
}

// NetworkExists reports whether a network with the exact name already exists.
func (c *Client) NetworkExists(ctx context.Context, name string) (bool, error) {
	f := filters.NewArgs(filters.Arg("name", name))
	nets, err := c.sdk().NetworkList(ctx, network.ListOptions{Filters: f})
	if err != nil {
		return false, err
	}
	for _, n := range nets {
		if n.Name == name {
			return true, nil
		}
	}
	return false, nil
}

// CreateNetwork creates a network from spec, returning its id. It generalizes
// the hardcoded bridge create used for the tunnels fallback network.
func (c *Client) CreateNetwork(ctx context.Context, spec stackspec.NetworkSpec) (string, error) {
	driver := spec.Driver
	if driver == "" {
		driver = "bridge"
	}
	opts := network.CreateOptions{
		Driver:     driver,
		Internal:   spec.Internal,
		Attachable: spec.Attachable,
		EnableIPv6: &spec.IPv6,
		Labels:     withManaged(spec.Labels),
	}
	if spec.Subnet != "" || spec.Gateway != "" {
		opts.IPAM = &network.IPAM{Config: []network.IPAMConfig{{Subnet: spec.Subnet, Gateway: spec.Gateway}}}
	}
	resp, err := c.sdk().NetworkCreate(ctx, spec.Name, opts)
	if err != nil {
		return "", fmt.Errorf("create network %s: %w", spec.Name, err)
	}
	return resp.ID, nil
}

// VolumeExists reports whether a named volume already exists.
func (c *Client) VolumeExists(ctx context.Context, name string) (bool, error) {
	f := filters.NewArgs(filters.Arg("name", name))
	resp, err := c.sdk().VolumeList(ctx, volume.ListOptions{Filters: f})
	if err != nil {
		return false, err
	}
	for _, v := range resp.Volumes {
		if v != nil && v.Name == name {
			return true, nil
		}
	}
	return false, nil
}

// CreateVolume creates a named volume from spec, returning its name.
func (c *Client) CreateVolume(ctx context.Context, spec stackspec.VolumeSpec) (string, error) {
	driver := spec.Driver
	if driver == "" {
		driver = "local"
	}
	v, err := c.sdk().VolumeCreate(ctx, volume.CreateOptions{
		Name:       spec.Name,
		Driver:     driver,
		DriverOpts: spec.Options,
		Labels:     withManaged(spec.Labels),
	})
	if err != nil {
		return "", fmt.Errorf("create volume %s: %w", spec.Name, err)
	}
	return v.Name, nil
}

// RemoveManagedResources removes the hope-managed networks and volumes belonging
// to a project (labeled com.docker.compose.project=<project> AND
// ink.hope.managed=1) — the ones a hope deploy created. Externally-created
// resources are never touched. Returns the count removed. Errors on individual
// resources (e.g. still in use) are emitted but not fatal.
func (c *Client) RemoveManagedResources(ctx context.Context, project string, emit func(string)) (int, error) {
	if emit == nil {
		emit = func(string) {}
	}
	f := filters.NewArgs(
		filters.Arg("label", labelProject+"="+project),
		filters.Arg("label", labelManaged+"=1"),
	)
	removed := 0
	nets, err := c.sdk().NetworkList(ctx, network.ListOptions{Filters: f})
	if err != nil {
		return removed, err
	}
	for _, n := range nets {
		if err := c.sdk().NetworkRemove(ctx, n.ID); err != nil {
			emit("keep network " + n.Name + " — " + err.Error())
			continue
		}
		emit("remove network " + n.Name)
		removed++
	}
	vols, err := c.sdk().VolumeList(ctx, volume.ListOptions{Filters: f})
	if err != nil {
		return removed, err
	}
	for _, v := range vols.Volumes {
		if v == nil {
			continue
		}
		if err := c.sdk().VolumeRemove(ctx, v.Name, false); err != nil {
			emit("keep volume " + v.Name + " — " + err.Error())
			continue
		}
		emit("remove volume " + v.Name)
		removed++
	}
	return removed, nil
}

// ProjectSpec reconstructs a StackSpec from the live containers of a project
// (compose labels + inspect). It powers the editor's "adopt an existing stack"
// path — including stacks hope did not deploy. Replicas collapse to one service;
// the reconstruction is best-effort and portable (no live IPs/MACs).
func (c *Client) ProjectSpec(ctx context.Context, project string) (*stackspec.StackSpec, error) {
	ids, err := c.ProjectContainerIDs(ctx, project)
	if err != nil {
		return nil, err
	}
	spec := &stackspec.StackSpec{Name: project}
	seenSvc := map[string]bool{}
	netSet := map[string]bool{}
	volSet := map[string]bool{}
	for _, id := range ids {
		info, err := c.sdk().ContainerInspect(ctx, id)
		if err != nil {
			continue
		}
		svc := ""
		if info.Config != nil {
			svc = serviceLabel(info.Config.Labels)
		}
		if svc == "" {
			svc = strings.TrimPrefix(info.Name, "/")
		}
		if seenSvc[svc] {
			continue // one service entry per replica set
		}
		seenSvc[svc] = true

		cs := specFromInspect(info, svc)
		for _, n := range cs.Networks {
			netSet[n] = true
		}
		for _, m := range cs.Mounts {
			if m.Type == "volume" && m.Source != "" {
				volSet[m.Source] = true
			}
		}
		spec.Services = append(spec.Services, cs)
	}
	for _, n := range sortedSet(netSet) {
		spec.Networks = append(spec.Networks, stackspec.NetworkSpec{Name: n, External: true})
	}
	for _, v := range sortedSet(volSet) {
		spec.Volumes = append(spec.Volumes, stackspec.VolumeSpec{Name: v, External: true})
	}
	sort.Slice(spec.Services, func(i, j int) bool { return spec.Services[i].Name < spec.Services[j].Name })
	return spec, nil
}

// ContainerSpecOf reconstructs a single container's editable spec from its live
// inspect — the seed for the "edit container" form. name is the compose service
// when set, else the container name.
func (c *Client) ContainerSpecOf(ctx context.Context, id string) (*stackspec.ContainerSpec, error) {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", id, err)
	}
	name := strings.TrimPrefix(info.Name, "/")
	if info.Config != nil && serviceLabel(info.Config.Labels) != "" {
		name = serviceLabel(info.Config.Labels)
	}
	cs := specFromInspect(info, name)
	return &cs, nil
}

// specFromInspect maps a container inspect to a portable ContainerSpec (no live
// IPs/MACs, hope/compose labels filtered out). svc becomes the spec name.
func specFromInspect(info container.InspectResponse, svc string) stackspec.ContainerSpec {
	cs := stackspec.ContainerSpec{Name: svc}
	if info.Config != nil {
		cs.Image = info.Config.Image
		cs.Entrypoint = []string(info.Config.Entrypoint)
		cs.Command = []string(info.Config.Cmd)
		cs.Env = envMap(info.Config.Env)
		cs.User = info.Config.User
		cs.WorkingDir = info.Config.WorkingDir
		cs.Labels = filterLabels(info.Config.Labels)
		cs.Health = healthSpec(info.Config.Healthcheck)
	}
	if info.HostConfig != nil {
		cs.Restart = string(info.HostConfig.RestartPolicy.Name)
		cs.Privileged = info.HostConfig.Privileged
		cs.CapAdd = []string(info.HostConfig.CapAdd)
		cs.ExtraHosts = info.HostConfig.ExtraHosts
		cs.Ports = portSpecs(info.HostConfig.PortBindings)
	}
	for _, m := range info.Mounts {
		ms := stackspec.MountSpec{Target: m.Destination, ReadOnly: !m.RW, Type: string(m.Type)}
		if m.Type == "volume" {
			ms.Source = m.Name
		} else {
			ms.Source = m.Source
		}
		if ms.Target != "" {
			cs.Mounts = append(cs.Mounts, ms)
		}
	}
	if info.NetworkSettings != nil {
		var nets []string
		aliases := map[string][]string{}
		auto := map[string]bool{svc: true, strings.TrimPrefix(info.Name, "/"): true}
		if len(info.ID) >= 12 {
			auto[info.ID[:12]] = true
		}
		for n, ep := range info.NetworkSettings.Networks {
			if n == "bridge" || n == "host" || n == "none" {
				continue
			}
			nets = append(nets, n)
			var custom []string
			for _, a := range ep.Aliases {
				if !auto[a] {
					custom = append(custom, a)
				}
			}
			if len(custom) > 0 {
				sort.Strings(custom)
				aliases[n] = custom
			}
		}
		sort.Strings(nets)
		cs.Networks = nets
		if len(aliases) > 0 {
			cs.Aliases = aliases
		}
	}
	return cs
}

// RecreateFromSpec rebuilds a container in place under its current name with the
// edited spec — the API-only "edit container settings". The container's internal
// compose/hope labels are preserved (so it stays grouped/managed); the user
// labels come from the spec. Networks in the spec are taken as-is (the edit form
// seeds them from the live container).
func (c *Client) RecreateFromSpec(ctx context.Context, id string, spec stackspec.ContainerSpec, pull bool, emit func(string)) error {
	if emit == nil {
		emit = func(string) {}
	}
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", id, err)
	}
	name := strings.TrimPrefix(info.Name, "/")
	// Preserve internal labels (compose grouping, hope-managed) under the edit.
	merged := map[string]string{}
	if info.Config != nil {
		for k, v := range info.Config.Labels {
			if strings.HasPrefix(k, "com.docker.compose.") || strings.HasPrefix(k, "ink.hope.") {
				merged[k] = v
			}
		}
	}
	maps.Copy(merged, spec.Labels)
	spec.Labels = merged

	emit("stop + remove " + name)
	if err := c.Remove(ctx, id); err != nil {
		return fmt.Errorf("remove %s: %w", name, err)
	}
	if _, err := c.CreateContainer(ctx, name, spec, pull, emit); err != nil {
		return fmt.Errorf("recreate %s: %w", name, err)
	}
	return nil
}

// ── mapping helpers ─────────────────────────────────────────────────────────

// endpointAliases is the alias list for a service on a network: the service name
// (so in-stack DNS resolves the service) plus any custom aliases from the spec.
func endpointAliases(spec stackspec.ContainerSpec, net string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(a string) {
		if a != "" && !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	add(spec.Name)
	for _, a := range spec.Aliases[net] {
		add(a)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func envSlice(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(m))
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out
}

func envMap(env []string) map[string]string {
	if len(env) == 0 {
		return nil
	}
	out := map[string]string{}
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		if k != "" {
			out[k] = v
		}
	}
	return out
}

func portMaps(ports []stackspec.PortMap) (nat.PortSet, nat.PortMap, error) {
	if len(ports) == 0 {
		return nil, nil, nil
	}
	exposed := nat.PortSet{}
	bindings := nat.PortMap{}
	for _, p := range ports {
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		port, err := nat.NewPort(proto, p.Container)
		if err != nil {
			return nil, nil, fmt.Errorf("bad port %q: %w", p.Container, err)
		}
		exposed[port] = struct{}{}
		if p.Host != "" {
			bindings[port] = append(bindings[port], nat.PortBinding{HostIP: p.HostIP, HostPort: p.Host})
		}
	}
	return exposed, bindings, nil
}

func portSpecs(pm nat.PortMap) []stackspec.PortMap {
	if len(pm) == 0 {
		return nil
	}
	var out []stackspec.PortMap
	for port, binds := range pm {
		proto := port.Proto()
		cport := port.Port()
		if len(binds) == 0 {
			out = append(out, stackspec.PortMap{Container: cport, Protocol: proto})
			continue
		}
		for _, b := range binds {
			out = append(out, stackspec.PortMap{Host: b.HostPort, HostIP: b.HostIP, Container: cport, Protocol: proto})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Container != out[j].Container {
			return out[i].Container < out[j].Container
		}
		return out[i].Host < out[j].Host
	})
	return out
}

func binds(mounts []stackspec.MountSpec) []string {
	if len(mounts) == 0 {
		return nil
	}
	out := make([]string, 0, len(mounts))
	for _, m := range mounts {
		if m.Source == "" || m.Target == "" {
			continue // anonymous volume: leave to the image's VOLUME
		}
		s := m.Source + ":" + m.Target
		if m.ReadOnly {
			s += ":ro"
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func restartPolicy(mode string) container.RestartPolicy {
	switch mode {
	case "always":
		return container.RestartPolicy{Name: container.RestartPolicyAlways}
	case "on-failure":
		return container.RestartPolicy{Name: container.RestartPolicyOnFailure}
	case "unless-stopped":
		return container.RestartPolicy{Name: container.RestartPolicyUnlessStopped}
	default:
		return container.RestartPolicy{Name: container.RestartPolicyDisabled}
	}
}

func healthConfig(h *stackspec.HealthSpec) *container.HealthConfig {
	if h == nil || len(h.Test) == 0 {
		return nil
	}
	hc := &container.HealthConfig{Test: h.Test, Retries: h.Retries}
	hc.Interval = parseDur(h.Interval)
	hc.Timeout = parseDur(h.Timeout)
	hc.StartPeriod = parseDur(h.StartPeriod)
	return hc
}

func healthSpec(h *container.HealthConfig) *stackspec.HealthSpec {
	if h == nil || len(h.Test) == 0 {
		return nil
	}
	hs := &stackspec.HealthSpec{Test: h.Test, Retries: h.Retries}
	if h.Interval > 0 {
		hs.Interval = h.Interval.String()
	}
	if h.Timeout > 0 {
		hs.Timeout = h.Timeout.String()
	}
	if h.StartPeriod > 0 {
		hs.StartPeriod = h.StartPeriod.String()
	}
	return hs
}

func parseDur(s string) time.Duration {
	if s == "" {
		return 0
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0
	}
	return d
}

// filterLabels drops docker/compose/hope-internal labels so a reconstructed
// spec carries only user-meaningful labels.
func filterLabels(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := map[string]string{}
	for k, v := range in {
		if strings.HasPrefix(k, "com.docker.compose.") || strings.HasPrefix(k, "ink.hope.") {
			continue
		}
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// withManaged tags labels with ink.hope.managed=1 (creating the map if needed).
func withManaged(in map[string]string) map[string]string {
	out := map[string]string{labelManaged: "1"}
	maps.Copy(out, in)
	return out
}

func sortedSet(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
