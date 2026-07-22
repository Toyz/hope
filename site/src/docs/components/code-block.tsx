import { LoomElement, component, css, prop, styles } from "@toyz/loom";
import { theme } from "../../theme";

type Rule = readonly [type: string, pattern: RegExp];

const COMMON_RULES: Rule[] = [
  ["number", /^-?(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i],
  ["punctuation", /^[{}()[\],.;:=+\-*/%<>|&!?]/],
  ["space", /^\s+/],
];

const SCRIPT_RULES: Rule[] = [
  ["comment", /^\/\*[\s\S]*?\*\//],
  ["comment", /^\/\/.*$/m],
  ["decorator", /^@[A-Za-z_$][\w$]*/],
  ["string", /^`(?:[^`\\]|\\.)*`/],
  ["string", /^"(?:[^"\\]|\\.)*"/],
  ["string", /^'(?:[^'\\]|\\.)*'/],
  [
    "keyword",
    /^(?:as|async|await|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|keyof|let|new|null|of|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\b/,
  ],
  ["type", /^[A-Z][A-Za-z0-9_$]*/],
  ...COMMON_RULES,
  ["ident", /^[A-Za-z_$][\w$]*/],
];

const GO_RULES: Rule[] = [
  ["comment", /^\/\*[\s\S]*?\*\//],
  ["comment", /^\/\/.*$/m],
  ["string", /^`[^`]*`/],
  ["string", /^"(?:[^"\\]|\\.)*"/],
  ["string", /^'(?:[^'\\]|\\.)*'/],
  [
    "keyword",
    /^(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/,
  ],
  ["literal", /^(?:true|false|nil|iota)\b/],
  [
    "type",
    /^(?:any|bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/,
  ],
  ...COMMON_RULES,
  ["ident", /^[A-Za-z_][\w]*/],
];

const SHELL_RULES: Rule[] = [
  ["comment", /^#.*$/m],
  ["string", /^"(?:[^"\\]|\\.)*"/],
  ["string", /^'[^']*'/],
  ["variable", /^\$\{[^}]+\}/],
  ["variable", /^\$[A-Za-z_][\w]*/],
  [
    "keyword",
    /^(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|readonly|return|set|then|unset|while)\b/,
  ],
  [
    "command",
    /^(?:curl|docker|docker-compose|echo|git|go|hope|make|node|npm|npx|pnpm|podman|yarn)\b/,
  ],
  ["flag", /^--?[A-Za-z][\w-]*/],
  ...COMMON_RULES,
  ["ident", /^[A-Za-z_./~][\w./~:-]*/],
];

const JSON_RULES: Rule[] = [
  ["comment", /^\/\*[\s\S]*?\*\//],
  ["comment", /^\/\/.*$/m],
  ["key", /^"(?:[^"\\]|\\.)*"(?=\s*:)/],
  ["string", /^"(?:[^"\\]|\\.)*"/],
  ["literal", /^(?:true|false|null)\b/],
  ...COMMON_RULES,
];

const TOML_RULES: Rule[] = [
  ["comment", /^#.*$/m],
  ["section", /^\[\[?[^\]\n]+\]\]?/],
  ["string", /^"""[\s\S]*?"""/],
  ["string", /^'''[\s\S]*?'''/],
  ["string", /^"(?:[^"\\]|\\.)*"/],
  ["string", /^'[^']*'/],
  ["literal", /^(?:true|false)\b/],
  ["key", /^[A-Za-z_][\w.-]*(?=\s*=)/],
  ...COMMON_RULES,
  ["ident", /^[A-Za-z_][\w.-]*/],
];

const YAML_RULES: Rule[] = [
  ["comment", /^#.*$/m],
  ["string", /^"(?:[^"\\]|\\.)*"/],
  ["string", /^'[^']*'/],
  ["key", /^[A-Za-z_][\w.-]*(?=\s*:)/],
  ["literal", /^(?:true|false|null|yes|no|on|off)\b/i],
  ["anchor", /^[&*!][A-Za-z_][\w.-]*/],
  ...COMMON_RULES,
  ["ident", /^[A-Za-z_][\w./:-]*/],
];

const RULES: Record<string, Rule[]> = {
  bash: SHELL_RULES,
  go: GO_RULES,
  javascript: SCRIPT_RULES,
  js: SCRIPT_RULES,
  json: JSON_RULES,
  jsonc: JSON_RULES,
  sh: SHELL_RULES,
  shell: SHELL_RULES,
  toml: TOML_RULES,
  ts: SCRIPT_RULES,
  tsx: SCRIPT_RULES,
  typescript: SCRIPT_RULES,
  yaml: YAML_RULES,
  yml: YAML_RULES,
};

function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlight(code: string, lang: string) {
  const rules = RULES[lang.toLowerCase()];
  if (!rules) return escapeHTML(code);

  const tokens: string[] = [];
  let offset = 0;
  while (offset < code.length) {
    const remaining = code.slice(offset);
    const match = rules.find(([, pattern]) => pattern.test(remaining));
    if (!match) {
      tokens.push(escapeHTML(code[offset]));
      offset += 1;
      continue;
    }

    const [type, pattern] = match;
    const text = pattern.exec(remaining)?.[0] ?? "";
    if (!text) {
      tokens.push(escapeHTML(code[offset]));
      offset += 1;
      continue;
    }

    const escaped = escapeHTML(text);
    tokens.push(
      type === "space"
        ? escaped
        : `<span class="tok-${type}">${escaped}</span>`,
    );
    offset += text.length;
  }
  return tokens.join("");
}

@component("hope-code-block")
@styles(
  theme,
  css`
    :host {
      display: block;
      margin: 14px 0;
      border: 1px solid var(--line);
      background: #070a0f;
    }
    pre {
      overflow-x: auto;
      margin: 0;
      padding: 13px 14px;
      border: 0;
      border-top: 1px solid var(--line);
      background: #070a0f;
      color: var(--hi);
      white-space: pre;
      font: 12px/1.7 var(--mono);
      scrollbar-width: thin;
      scrollbar-color: var(--line2) #070a0f;
    }
    pre::-webkit-scrollbar {
      width: 9px;
      height: 9px;
    }
    pre::-webkit-scrollbar-track,
    pre::-webkit-scrollbar-corner {
      background: #070a0f;
    }
    pre::-webkit-scrollbar-thumb {
      background: var(--line2);
      border: 2px solid #070a0f;
    }
    pre::-webkit-scrollbar-thumb:hover {
      background: var(--dim);
    }
    code {
      font: inherit;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 28px;
      padding: 0 12px;
    }
    .lang {
      color: var(--dim);
      font: 600 8.5px/1 var(--mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    button {
      border: 0;
      background: transparent;
      color: var(--dim);
      cursor: pointer;
      font: 600 9px/1 var(--mono);
      text-transform: uppercase;
    }
    button:hover,
    button.copied {
      color: var(--hi);
    }
    .tok-comment {
      color: var(--dim);
      font-style: italic;
    }
    .tok-keyword,
    .tok-decorator {
      color: #c792ea;
    }
    .tok-string {
      color: #addb67;
    }
    .tok-number,
    .tok-literal {
      color: #f2c56b;
    }
    .tok-type,
    .tok-section {
      color: #82aaff;
    }
    .tok-key,
    .tok-variable,
    .tok-anchor {
      color: #7fdbca;
    }
    .tok-command {
      color: #89ddff;
    }
    .tok-flag {
      color: #f78c6c;
    }
    .tok-punctuation {
      color: var(--mid);
    }
    .tok-ident {
      color: var(--hi);
    }
  `,
)
export class HopeCodeBlock extends LoomElement {
  @prop accessor lang = "";
  @prop accessor code = "";

  private async copy() {
    await navigator.clipboard.writeText(this.code);
    const button = this.shadow.querySelector("button");
    if (!button) return;
    button.textContent = "copied";
    button.classList.add("copied");
    window.setTimeout(() => {
      button.textContent = "copy";
      button.classList.remove("copied");
    }, 1200);
  }

  update() {
    const code = this.code.replace(/^\n+|\n+$/g, "");
    return (
      <>
        <div class="header">
          <span class="lang">{this.lang || "text"}</span>
          <button type="button" onClick={() => void this.copy()}>
            copy
          </button>
        </div>
        <pre>
          <code rawHTML={highlight(code, this.lang)}></code>
        </pre>
      </>
    );
  }
}
