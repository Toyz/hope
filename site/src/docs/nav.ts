export interface NavItem {
  slug: string;
  title: string;
  depth?: number;
}

export interface NavSection {
  section: string;
  items: NavItem[];
}

export const HOME = "overview";

export const NAV: NavSection[] = [
  {
    section: "start",
    items: [
      { slug: "overview", title: "overview" },
      { slug: "getting-started", title: "getting started" },
      { slug: "configuration", title: "configuration" },
    ],
  },
  {
    section: "fleet",
    items: [
      { slug: "fleet", title: "fleet overview" },
      { slug: "stacks", title: "stacks & containers", depth: 1 },
      { slug: "images", title: "images", depth: 1 },
      { slug: "updates", title: "updates & freshness", depth: 1 },
      { slug: "agents", title: "agents", depth: 1 },
      { slug: "audit", title: "audit", depth: 1 },
    ],
  },
  {
    section: "plugins",
    items: [
      { slug: "plugins", title: "plugin engine" },
      { slug: "plugin-getting-started", title: "getting started", depth: 1 },
      { slug: "plugins/trust", title: "discovery & trust", depth: 1 },
      { slug: "plugins/surfaces", title: "surfaces & pages", depth: 1 },
      { slug: "plugins/views", title: "views & cells", depth: 1 },
      { slug: "plugins/components", title: "components", depth: 1 },
      { slug: "dynamic-forms", title: "actions & forms", depth: 1 },
      { slug: "plugins/streams", title: "streams & events", depth: 1 },
    ],
  },
  {
    section: "networking",
    items: [
      { slug: "networking", title: "networking overview" },
      { slug: "tunnels", title: "tunnels", depth: 1 },
      { slug: "registries", title: "registries", depth: 1 },
    ],
  },
  {
    section: "interfaces",
    items: [
      { slug: "interfaces", title: "interfaces overview" },
      { slug: "api", title: "rpc api", depth: 1 },
    ],
  },
];
