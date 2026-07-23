// <hope-code> — a small self-contained code editor with syntax highlighting, for
// plugin `query` views (run your own SQL/JSON/etc). No external deps: a
// transparent <textarea> sits over a highlighted <pre>, scroll-synced, so the
// caret + selection are native while the text shows colored. Emits an "input"
// event with the current value.
import { LoomElement, component, styles, css, prop, reactive, query } from "@toyz/loom";
import { theme } from "../styles";

// SQL keywords for lang="sql".
const SQL_KW = new Set(
  ("select from where and or not in like limit offset order by group having join left right inner outer full cross on as insert into values update set delete create table drop alter view index distinct count sum avg min max null is asc desc between union all exists case when then else end with returning primary key foreign references default").split(" "),
);

// Dockerfile instructions for lang="dockerfile" (matched only when UPPERCASE, the
// convention — so a lowercase word that happens to collide isn't miscolored).
const DOCKERFILE_KW = new Set(
  ("FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS").split(" "),
);

type Tok = { t: string; c: string };

// tokenize splits code into highlight tokens. One pass, string/comment/number/word
// aware; words are keyword-colored for sql, key/value for json.
function tokenize(code: string, lang: string): Tok[] {
  const out: Tok[] = [];
  const re = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*|\s+|[^\s\w])/g;
  let m: RegExpExecArray | null;
  let prevWord = "";
  while ((m = re.exec(code))) {
    const t = m[0];
    let c = "";
    const ch = t[0];
    if (ch === '"' || ch === "'" || ch === "`") c = "str";
    else if (t.startsWith("--") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("#")) c = "com";
    else if (/^\d/.test(t)) c = "num";
    else if (/^[A-Za-z_]/.test(t)) {
      const lw = t.toLowerCase();
      if (lang === "sql" && SQL_KW.has(lw)) c = "kw";
      else if (lang === "dockerfile" && t === t.toUpperCase() && DOCKERFILE_KW.has(t)) c = "kw";
      else if (lang === "json") c = "word";
      else if (lw === "true" || lw === "false" || lw === "null") c = "kw";
    }
    out.push({ t, c });
    if (c === "" && /\S/.test(t)) prevWord = t;
  }
  void prevWord;
  // YAML: color a bare word as a key when the next non-space token is a colon —
  // the dominant structure in a compose file.
  if (lang === "yaml") {
    for (let i = 0; i < out.length; i++) {
      if (out[i].c !== "" || !/^[A-Za-z_][\w-]*$/.test(out[i].t)) continue;
      let j = i + 1;
      while (j < out.length && /^\s+$/.test(out[j].t)) j++;
      if (j < out.length && out[j].t === ":") out[i].c = "key";
    }
  }
  return out;
}

@component("hope-code")
@styles(theme, css`
  :host { display: block; }
  .wrap { position: relative; border: 1px solid var(--line); background: var(--ink); overflow: hidden; }
  .wrap:focus-within { border-color: var(--line2); }
  pre, textarea {
    margin: 0; padding: 10px 12px; border: 0; box-sizing: border-box; width: 100%;
    font: 12.5px/1.6 var(--mono); tab-size: 2; white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word;
  }
  pre { position: absolute; inset: 0; pointer-events: none; overflow: auto; color: var(--mid); }
  textarea { position: relative; background: transparent; color: transparent; caret-color: var(--hi); resize: vertical; min-height: var(--code-min-h, 64px); outline: none; }
  textarea::selection { background: color-mix(in srgb, var(--upd) 30%, transparent); }
  .kw { color: var(--upd); font-weight: 600; }
  .key { color: var(--upd); }
  .str { color: var(--ok); }
  .num { color: var(--warn); }
  .com { color: var(--dim); font-style: italic; }
  .word { color: var(--hi); }
`)
export class HopeCode extends LoomElement {
  @prop accessor lang = "";
  @prop accessor value = "";
  @prop accessor placeholder = "";
  @reactive accessor text = "";
  @query("textarea") accessor ta!: HTMLTextAreaElement;
  @query("pre") accessor pre!: HTMLPreElement;

  update() {
    // Keep internal text in sync with the controlled value when the host changes it.
    if (this.value !== undefined && this.text === "" && this.value !== "") this.text = this.value;
    const toks = tokenize(this.text, this.lang);
    return (
      <div class="wrap">
        <pre aria-hidden="true"><code>{toks.map((k) => (k.c ? <span class={k.c}>{k.t}</span> : k.t))}{"\n"}</code></pre>
        <textarea
          spellcheck={false}
          placeholder={this.placeholder}
          onInput={(e: any) => { this.text = e.target.value; this.dispatchEvent(new CustomEvent("input", { detail: this.text, bubbles: true, composed: true })); this.sync(); }}
          onScroll={() => this.sync()}
        >{this.text}</textarea>
      </div>
    );
  }

  private sync() {
    if (this.pre && this.ta) { this.pre.scrollTop = this.ta.scrollTop; this.pre.scrollLeft = this.ta.scrollLeft; }
  }
}
