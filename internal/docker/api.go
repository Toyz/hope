package docker

import (
	"context"
	"time"

	"github.com/docker/docker/client"

	"github.com/toyz/hope/internal/stackspec"
)

// API is the full method surface of *Client. hosts.ActiveFor and friends hand callers
// an API rather than a concrete *Client, so the routers (containers/stacks/system/
// deploy/tunnels/pluginhost) that reach the daemon through the hosts seam can be
// exercised in tests against a mock. *Client is the only production implementation;
// the assertion below fails the build if any signature drifts from it. Test mocks
// embed API and override only the methods the test touches.
type API interface {
	AddRegistryCreds(server, user, pass string, source RegistrySource)
	AllUpdates(ctx context.Context) ([]ClusterUpdate, time.Time, error)
	AttachNetwork(ctx context.Context, containerID, netName string, aliases []string) error
	AuthedRegistries() []string
	CachedStatus(ref string) string
	Close() error
	Connectors(ctx context.Context) ([]Connector, error)
	ContainerImage(ctx context.Context, id string) (string, error)
	ContainerMatchInfo(ctx context.Context, id string) (image string, labels map[string]string, err error)
	ContainerName(ctx context.Context, id string) (string, error)
	ContainerNetworks(ctx context.Context, id string) ([]string, error)
	ContainerSpecOf(ctx context.Context, id string) (*stackspec.ContainerSpec, error)
	CreateContainer(ctx context.Context, name string, spec stackspec.ContainerSpec, pull bool, emit func(string)) (string, error)
	CreateNetwork(ctx context.Context, spec stackspec.NetworkSpec) (string, error)
	CreateVolume(ctx context.Context, spec stackspec.VolumeSpec) (string, error)
	DeployConnector(ctx context.Context, name, tunnelID, token string, isDefault bool) (string, error)
	DetachNetwork(ctx context.Context, containerID, netName string) error
	DiskUsage(ctx context.Context) (any, error)
	DiskUsageCached() (any, time.Time)
	EnsurePluginNetwork(ctx context.Context) error
	EnsureTunnelsNetwork(ctx context.Context) (string, error)
	Exists(ctx context.Context, id string) bool
	History(ctx context.Context, id string) ([]ImageLayer, error)
	ImageByRef(ctx context.Context, ref string) (*ImageInfo, error)
	ImageInUse(ctx context.Context, id string) (bool, []ImageUser, error)
	Images(ctx context.Context) ([]ImageInfo, error)
	ImagesForProject(ctx context.Context, project string) ([]string, error)
	Info(ctx context.Context) (any, error)
	Inspect(ctx context.Context, id string) (any, error)
	IsConfigRegistry(server string) bool
	IsLocalSocket() bool
	Kill(ctx context.Context, id string) error
	NetworkByRef(ctx context.Context, ref string) (*NetworkInfo, error)
	NetworkExists(ctx context.Context, name string) (bool, error)
	Networks(ctx context.Context) ([]NetworkInfo, error)
	OriginIndex(ctx context.Context) (map[string]OriginRef, error)
	Ping(ctx context.Context) error
	PluginContainers(ctx context.Context) ([]PluginContainer, error)
	PluginDialCandidates(ctx context.Context, id string, port int) (netTargets, directTargets []string, attachNet string, err error)
	PluginNetworkIP(ctx context.Context, id string) string
	ProjectContainerIDs(ctx context.Context, project string) ([]string, error)
	ProjectContainers(ctx context.Context, project, service string) ([]ContainerRef, error)
	ProjectSpec(ctx context.Context, project string) (*stackspec.StackSpec, error)
	ProjectStats(ctx context.Context, project string) ([]ContainerStat, error)
	ProjectUpdates(ctx context.Context, project string) ([]ImageUpdate, error)
	PruneBuildCache(ctx context.Context) (uint64, error)
	PruneImages(ctx context.Context, all bool) (PruneResult, error)
	PruneImagesStream(ctx context.Context, all bool, emit func(string)) error
	PullContainers(ctx context.Context, ids []string, emit func(string)) error
	PullImage(ctx context.Context, ref string) error
	PullImageStream(ctx context.Context, ref string, emit func(string)) error
	Recreate(ctx context.Context, id string) error
	RecreateFromSpec(ctx context.Context, id string, spec stackspec.ContainerSpec, pull bool, emit func(string)) error
	RecreateManaged(ctx context.Context, id string) error
	RedeployContainer(ctx context.Context, id string, pull, force bool, emit func(string)) error
	RedeployProject(ctx context.Context, project string, pull, force bool, emit func(string)) error
	RefreshDiskUsage(ctx context.Context) (any, time.Time, error)
	RefreshImageStatus(ctx context.Context, ref string)
	RefreshProjectStatus(ctx context.Context, project string)
	RefreshUpdates(ctx context.Context)
	RegistryList() []RegistryEntry
	Remove(ctx context.Context, id string) error
	RemoveImage(ctx context.Context, id string, force bool) error
	RemoveManagedResources(ctx context.Context, project string, emit func(string)) (int, error)
	RemoveNetwork(ctx context.Context, id string) error
	RemoveRegistryCreds(server string) bool
	RemoveVolume(ctx context.Context, name string, force bool) error
	Restart(ctx context.Context, id string) error
	SDK() *client.Client
	SelfContainerID(ctx context.Context) string
	SelfID() string
	ServerInfo(ctx context.Context) (ServerInfo, error)
	SetSelfID(id string)
	SetUpdateCache(store UpdateCacheStore, key string)
	SetUpdateHook(fn func())
	Stacks(ctx context.Context) ([]StackSummary, error)
	Start(ctx context.Context, id string) error
	StartCredWatcher(ctx context.Context, every time.Duration)
	StartDiskCrawler(ctx context.Context, every time.Duration)
	StartUpdateCrawler(ctx context.Context, every time.Duration, cachePath string)
	StatsSnapshot(ctx context.Context, id string) (ContainerStat, error)
	Stop(ctx context.Context, id string) error
	Top(ctx context.Context, id string) (TopResult, error)
	VerifyRegistry(ctx context.Context, server, user, pass string) error
	VolumeExists(ctx context.Context, name string) (bool, error)
	Volumes(ctx context.Context) ([]VolumeInfo, error)
}

// Compile-time proof that the concrete client implements the full surface — if any
// *Client method signature changes, this line breaks (not a call site).
var _ API = (*Client)(nil)
