import { LIVE_LINKS } from "../constants";
import type { Resolved } from "../links/types";
import type { CardNode } from "../model/types";
import type { RenderContext } from "../registry/node-type";
import { renderMarkdown, type RenderedMarkdown } from "./markdown-render";

/** What a card's body says when its note section cannot be shown, by the resolver's reason. */
const MISSING_TEXT: Record<Extract<Resolved, { kind: "missing" }>["reason"], string> = {
  file: "Note not found",
  subpath: "Heading or block not found",
  "no-image": "Nothing to show in that section",
  decode: "The note could not be read",
};

/** One drawing of a card's content: settles once it has been drawn (or failed to), and is released when replaced. */
export type CardBody = RenderedMarkdown;

/**
 * Draws `node`'s content into `el`, replacing what was there: a text card's Markdown, rendered by Obsidian's renderer
 * from the figure's place in the vault; a note card's linked section, as the stage resolved it (`ctx.resolved`, the path
 * content panels take for `file#subpath`), rendered from the note's own place so its links and embeds resolve as they
 * do there. A note card whose section cannot be found says so; one not resolved yet shows its link.
 */
export function renderCard(el: HTMLElement, node: CardNode, ctx: RenderContext): CardBody {
  el.empty();
  // Its links take their own clicks (`openCardLink`), not the stage's.
  const holder = el.createDiv({ cls: ["lf-card-content", "markdown-rendered", LIVE_LINKS] });
  const label = `card ${node.id}`;
  if (node.file === undefined) return renderMarkdown(ctx, node.text ?? "", holder, ctx.figurePath, label);
  const resolved = ctx.resolved(node.id);
  if (resolved?.kind === "content") return renderMarkdown(ctx, resolved.markdown, holder, resolved.file.path, label);
  holder.classList.add("lf-card-link");
  const link = `${node.file}${node.subpath ?? ""}`;
  holder.textContent = resolved === undefined ? link : `${link}: ${resolved.kind === "missing" ? MISSING_TEXT[resolved.reason] : "not a note section"}`;
  return { drawn: Promise.resolve(), release: () => {} };
}

/**
 * A click (`click`, or a middle-click's `auxclick`) in a card's body: on a link Obsidian's renderer made of an internal
 * link (`a.internal-link`, its target in `data-href`), the target is opened in a new tab beside the figure, whatever
 * modifier is held, and nothing else happens. An external link is left to Obsidian (it opens in the browser). True when
 * the click was a link's.
 */
export function openCardLink(ev: MouseEvent, ctx: Pick<RenderContext, "openLink">): boolean {
  if (ev.type === "auxclick" && ev.button !== 1) return false;
  const target = ev.target as Element | null;
  const link = typeof target?.closest === "function" ? target.closest<HTMLAnchorElement>("a.internal-link") : null;
  if (!link) return false;
  const linktext = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
  ev.preventDefault();
  ev.stopPropagation();
  if (linktext !== "") ctx.openLink(linktext, ev, "tab");
  return true;
}
