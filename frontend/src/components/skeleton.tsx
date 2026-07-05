// <hope-skel> — the one shimmer placeholder block, so loading states across every
// page read the same and content swaps in without a layout jump (no popin). Size
// it to the real element it stands in for.
//
//   <hope-skel w="120" h="14"></hope-skel>   // 120x14px block
//   <hope-skel h="16"></hope-skel>           // full-width, 16px tall
//
// w/h are pixel numbers; w omitted = fill the container.
import { LoomElement, component, styles, css, prop } from "@toyz/loom";
import { theme } from "../styles";

@component("hope-skel")
@styles(theme, css`
  :host { display: block; }
  .s { display: block; border-radius: 2px;
    background: linear-gradient(90deg, var(--raised) 25%, var(--line2) 37%, var(--raised) 63%);
    background-size: 400% 100%; animation: sh 1.4s ease infinite; }
  @keyframes sh { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
  @media (prefers-reduced-motion: reduce) { .s { animation: none; } }
`)
export class HopeSkel extends LoomElement {
  @prop accessor w = "";
  @prop accessor h = "12";

  update() {
    return <span class="s" style={`width:${this.w ? this.w + "px" : "100%"};height:${this.h}px`}></span>;
  }
}
