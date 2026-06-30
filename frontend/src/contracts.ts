// Typed contracts mirroring the sov routers. The @service name MUST match the
// Go wire name (struct prefix): AuthRouter -> "Auth", etc. Method names match
// sov's lower-first-letter rule (Login -> login). These shapes also type the
// transport.call<T>() results used directly in the pages.
import { service } from "@toyz/loom-rpc";

// ---- shared shapes (match internal/docker JSON tags) ----

export interface ContainerSummary {
  id: string;
  name: string;
  service: string;
  image: string;
  state: string; // running | exited | restarting | ...
  status: string; // "Up 3 days" / "Restarting (2) ..."
  health: string; // healthy | unhealthy | starting | ""
  created: number;
  number: number;
  ports: string[];
  labels?: Record<string, string>;
}

export interface StackSummary {
  project: string;
  working_dir: string;
  config_files: string[] | null;
  containers: ContainerSummary[];
  running: number;
  total: number;
  restarting: boolean;
  compose_available: boolean;
}

export interface LoginResult {
  token: string;
  subject: string;
  expires_at: string;
}

export interface OpResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface ComposeFileResult {
  project: string;
  content: string;
}

export interface ContainerStat {
  id: string;
  cpu_percent: number;
  mem_used: number;
  mem_limit: number;
}

export interface ImageUpdate {
  id: string;
  image: string;
  status: "current" | "outdated" | "unknown";
  detail?: string;
}

export interface ClusterUpdate {
  id: string;
  project: string;
  service: string;
  name: string;
  image: string;
  status: "current" | "outdated" | "unknown";
  detail?: string;
}

export interface UpdatesResult {
  updates: ClusterUpdate[];
  outdated: number;
  checked_at: string;
}

export interface DiskResult {
  usage: any; // raw docker df (LayersSize, Images, Containers, Volumes, BuildCache)
  checked_at: string;
}

export interface ImageUser {
  id: string;
  name: string;
  service: string;
  project: string;
}

export interface ImageInfo {
  id: string;
  tags: string[];
  size: number;
  created: number; // unix seconds
  dangling: boolean;
  in_use: boolean;
  used_by: ImageUser[];
}

export interface PruneResult {
  deleted: number;
  reclaimed: number;
}

// NDJSON stream frames.
export interface LogFrame {
  type: "stdout" | "stderr";
  data: string;
  source?: string; // set on multiplexed stack/service streams
}

// Streamed operation (redeploy) frames: progress "log" lines then a terminal
// "done" frame with the outcome.
export interface OpFrame {
  type: "log" | "done";
  data?: string;
  ok: boolean;
  error?: string;
}

// ---- service contracts (wire names) ----

@service("Auth")
export class Auth {
  login(_username: string, _password: string): LoginResult {
    return undefined!;
  }
}

@service("Stacks")
export class Stacks {
  list(): StackSummary[] {
    return undefined!;
  }
  start(_project: string): OpResult {
    return undefined!;
  }
  stop(_project: string): OpResult {
    return undefined!;
  }
  pull(_project: string): OpResult {
    return undefined!;
  }
  restart(_project: string): OpResult {
    return undefined!;
  }
  redeploy(_project: string): OpResult {
    return undefined!;
  }
  composeFile(_project: string): ComposeFileResult {
    return undefined!;
  }
  stats(_project: string): ContainerStat[] {
    return undefined!;
  }
  updates(_project: string): ImageUpdate[] {
    return undefined!;
  }
}

@service("Containers")
export class Containers {
  inspect(_id: string): unknown {
    return undefined!;
  }
  start(_id: string): OpResult {
    return undefined!;
  }
  stop(_id: string): OpResult {
    return undefined!;
  }
  restart(_id: string): OpResult {
    return undefined!;
  }
  kill(_id: string): OpResult {
    return undefined!;
  }
  remove(_id: string): OpResult {
    return undefined!;
  }
  pull(_id: string): OpResult {
    return undefined!;
  }
  redeploy(_id: string): OpResult {
    return undefined!;
  }
}


@service("System")
export class System {
  info(): unknown {
    return undefined!;
  }
  updates(): UpdatesResult {
    return undefined!;
  }
  refreshUpdates(): UpdatesResult {
    return undefined!;
  }
  diskUsage(): DiskResult {
    return undefined!;
  }
  refreshDiskUsage(): DiskResult {
    return undefined!;
  }
  images(): ImageInfo[] {
    return undefined!;
  }
  removeImage(_id: string, _force: boolean): unknown {
    return undefined!;
  }
  pruneImages(_all: boolean): PruneResult {
    return undefined!;
  }
  hosts(): HostView[] {
    return undefined!;
  }
  setActiveHost(_id: string): { active: string } {
    return undefined!;
  }
  fleet(): FleetHost[] {
    return undefined!;
  }
  refreshFleetUpdates(): FleetHost[] {
    return undefined!;
  }
  fleetImages(): FleetImagesHost[] {
    return undefined!;
  }
  networks(): NetworkInfo[] {
    return undefined!;
  }
  volumes(): VolumeInfo[] {
    return undefined!;
  }
  removeNetwork(_id: string): unknown {
    return undefined!;
  }
  removeVolume(_id: string): unknown {
    return undefined!;
  }
  fleetNetworks(): FleetNetworksHost[] {
    return undefined!;
  }
  fleetVolumes(): FleetVolumesHost[] {
    return undefined!;
  }
  agents(): AgentView[] {
    return undefined!;
  }
}

// AgentView is one connected agent's detail (build info + daemon + counts).
export interface AgentView {
  id: string;
  remote: string;
  connected_at: string;
  version: string;
  revision: string;
  go_version: string;
  platform: string;
  build_time: string;
  docker_version: string;
  containers: number;
  running: number;
  images: number;
  online: boolean;
}

export interface FleetNetworksHost {
  id: string;
  kind: "local" | "agent";
  online: boolean;
  error?: string;
  networks: NetworkInfo[];
}
export interface FleetVolumesHost {
  id: string;
  kind: "local" | "agent";
  online: boolean;
  error?: string;
  volumes: VolumeInfo[];
}

// ResourceUser is a container attached to a network or mounting a volume.
export interface ResourceUser {
  id: string;
  name: string;
  service: string;
  project: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  created: number;
  used_by: ResourceUser[];
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  created_at: string;
  size: number; // bytes; -1 if the daemon didn't compute it
  used_by: ResourceUser[];
}

// FleetImagesHost is one host's images for the cross-fleet images view.
export interface FleetImagesHost {
  id: string;
  kind: "local" | "agent";
  online: boolean;
  error?: string;
  images: ImageInfo[];
}

// FleetHost is one host's slice of the cross-fleet overview.
export interface FleetHost {
  id: string;
  kind: "local" | "agent";
  online: boolean;
  error?: string;
  outdated: number;
  updates: ClusterUpdate[];
  checked_at: string;
  stacks: StackSummary[];
}

// HostView is one selectable Docker host: the local socket or a connected agent.
export interface HostView {
  id: string;
  kind: "local" | "agent";
  connected: boolean;
  active: boolean;
  remote?: string;
  connected_at?: string;
}

// Stack lifecycle operations exposed in the UI (all Docker-API based).
export type StackOp = "restart" | "redeploy" | "pull" | "start" | "stop";
export type ContainerOp = "start" | "stop" | "restart" | "kill" | "pull" | "redeploy";
