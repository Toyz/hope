// Inspector — the DI handle + state for the docked container inspector. Any page
// opens it with a container (host + id + display name); the shell renders the
// inspector column and <hope-inspector> loads it. State lives here (read by the
// inspector on mount) and every change also fires InspectorTarget on the bus so
// the shell (and a mounted inspector) react without prop-drilling.
import { bus } from "@toyz/loom";
import { InspectorTarget } from "./events";

export class Inspector {
  host = "";
  id = "";
  name = "";

  get isOpen(): boolean {
    return this.id !== "";
  }

  open(host: string, id: string, name: string) {
    this.host = host;
    this.id = id;
    this.name = name;
    bus.emit(new InspectorTarget(host, id, name));
  }

  close() {
    this.host = "";
    this.id = "";
    this.name = "";
    bus.emit(new InspectorTarget("", "", ""));
  }
}
