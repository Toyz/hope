// <hope-doc> — renders a DocPage's blocks in hope's panel aesthetic. Inline markup in
// prose: `code`, **bold**, [text](href).
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "./theme";
import { PAGES, type Block } from "./content";

// Minimal inline parser: splits on `code`, **bold**, [text](href), in that priority.
function inline(text: string): any[] {
  const out: any[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(<code class="ic">{m[1]}</code>);
    else if (m[2] != null) out.push(<strong>{m[2]}</strong>);
    else out.push(<a class="il" href={m[4]}>{m[3]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

@component("hope-doc")
@styles(theme, css`
  :host { display: block; }
  .wrap { max-width: 820px; padding: 26px 34px 80px; }
  .h1 { font: 600 26px/1.15 var(--mono); color: var(--hi); margin: 0; letter-spacing: -.01em; }
  .lead { margin: 12px 0 0; color: var(--mid); font: 14px/1.6 var(--sans); max-width: 68ch; }
  .rule { height: 1px; background: var(--line); margin: 22px 0 6px; }
  h2 { font: 600 15px/1.2 var(--mono); color: var(--hi); margin: 32px 0 4px; letter-spacing: .01em; }
  h3 { font: 600 13px/1.2 var(--mono); color: var(--mid); margin: 22px 0 2px; }
  p { color: var(--mid); font: 14px/1.7 var(--sans); margin: 12px 0; max-width: 70ch; }
  .ic { font: 12.5px/1 var(--mono); color: var(--hi); background: var(--raised); border: 1px solid var(--line); padding: 1px 5px; }
  strong { color: var(--hi); font-weight: 600; }
  .il { color: var(--upd); border-bottom: 1px solid color-mix(in srgb, var(--upd) 40%, transparent); }
  .il:hover { color: var(--hi); border-bottom-color: var(--hi); }
  ul { margin: 12px 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; max-width: 72ch; }
  li { position: relative; padding-left: 18px; color: var(--mid); font: 14px/1.6 var(--sans); }
  li::before { content: ""; position: absolute; left: 2px; top: 9px; width: 5px; height: 5px; background: var(--dim); }
  pre { margin: 14px 0; background: var(--ink); border: 1px solid var(--line); border-left: 2px solid var(--line2);
    overflow-x: auto; }
  pre .lang { display: block; padding: 6px 14px; border-bottom: 1px solid var(--line); color: var(--dim);
    font: 600 9px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
  pre code { display: block; padding: 14px; color: var(--hi); font: 12.5px/1.6 var(--mono); white-space: pre; }
  .note { margin: 16px 0; padding: 12px 15px; border: 1px solid var(--line2); border-left-width: 3px;
    color: var(--mid); font: 13px/1.6 var(--sans); background: var(--panel); }
  .note strong, .note .ic { color: var(--hi); }
  .note.info { border-left-color: var(--upd); }
  .note.ok { border-left-color: var(--ok); }
  .note.warn { border-left-color: var(--warn); }
  .kv { margin: 14px 0; border-top: 1px solid var(--line); }
  .kv .r { display: grid; grid-template-columns: minmax(120px, 200px) 1fr; gap: 18px; padding: 9px 2px;
    border-bottom: 1px solid var(--line); }
  .kv .k { color: var(--dim); font: 12px/1.5 var(--mono); }
  .kv .v { color: var(--mid); font: 13px/1.5 var(--sans); }
  .missing { padding: 40px; color: var(--dim); font: 13px var(--mono); }
`)
export class HopeDoc extends LoomElement {
  @prop accessor slug = "";

  private block(b: Block) {
    switch (b.t) {
      case "h": return b.level === 3 ? <h3>{b.text}</h3> : <h2>{b.text}</h2>;
      case "p": return <p>{inline(b.text)}</p>;
      case "code": return <pre>{b.lang ? <span class="lang">{b.lang}</span> : null}<code>{b.code}</code></pre>;
      case "note": return <div class={"note " + (b.tone || "info")}>{inline(b.text)}</div>;
      case "list": return <ul>{b.items.map((i) => <li>{inline(i)}</li>)}</ul>;
      case "kv": return <div class="kv">{b.rows.map(([k, v]) => <div class="r"><span class="k">{k}</span><span class="v">{inline(v)}</span></div>)}</div>;
    }
  }

  update() {
    const page = PAGES[this.slug];
    if (!page) return <div class="missing">Not found.</div>;
    return (
      <div class="wrap">
        <h1 class="h1">{page.title}</h1>
        {page.lead ? <p class="lead">{page.lead}</p> : null}
        <div class="rule"></div>
        {page.blocks.map((b) => this.block(b))}
      </div>
    );
  }
}
