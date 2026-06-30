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

// NDJSON stream frames.
export interface LogFrame {
  type: "stdout" | "stderr";
  data: string;
  source?: string; // set on multiplexed stack/service streams
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
}

@service("System")
export class System {
  info(): unknown {
    return undefined!;
  }
  diskUsage(): unknown {
    return undefined!;
  }
}

// Stack lifecycle operations exposed in the UI (all Docker-API based).
export type StackOp = "restart" | "redeploy" | "pull" | "start" | "stop";
export type ContainerOp = "start" | "stop" | "restart" | "kill";
