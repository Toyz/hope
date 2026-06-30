// Registers the line-icon set hope uses with loom's <loom-icon>. Imported once
// from main.tsx (side effect). Paths are 24x24 stroke icons (Lucide-style) to
// match loom-icon's stroke rendering.
import { LoomIcon } from "@toyz/loom/element/icon";

LoomIcon.registerAll({
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "rotate": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  "redeploy": '<path d="M21 12a9 9 0 1 1-3-6.74L21 8"/><path d="M21 3v5h-5"/><path d="M12 8v4l3 2"/>',
  "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  "play": '<path d="M6 4v16l13-8z"/>',
  "stop": '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "terminal": '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  "file": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  "logout": '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  "alert": '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
});
