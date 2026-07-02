// Shared domain constants.

// The pseudo-stack that groups containers with no compose project.
export const UNGROUPED = "(ungrouped)";

// Compose grouping labels, resolved from raw container labels with the same
// docker-then-podman fallback the backend uses (io.podman.compose.*), so
// podman-managed containers group + derive project/service correctly in the UI.
type Labels = Record<string, string>;
export function composeProject(l: Labels): string {
  return l["com.docker.compose.project"] || l["io.podman.compose.project"] || "";
}
export function composeService(l: Labels): string {
  return l["com.docker.compose.service"] || l["io.podman.compose.service"] || "";
}
