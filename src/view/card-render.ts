import { Component, MarkdownRenderer } from "obsidian";
import type { Resolved } from "../links/types";
import type { CardNode } from "../model/types";
import type { RenderContext } from "../registry/node-type";

/** What a card's body says when its note section cannot be shown, by the resolver's reason. */
const MISSING_TEXT: Record<Extract<Resolved, { kind: "missing" }>["reason"], string> = {
  file: "Note not found",
  subpath: "Heading or block not found",
  "no-image": "Nothing to show in that section",
  decode: "The note could not be read",
};

/** One drawing of a card's content: settles once it has been drawn (or failed to), and is released when replaced. */
export interface CardBody {
  drawn: Promise<void>;
  release(): void;
}

/**
 * Draws `node`'s content into `el`, replacing what was there: a text card's Markdown, rendered by Obsidian's renderer
 * from the figure's place in the vault; a note card's linked section, as the stage resolved it (`ctx.resolved`, the path
 * content panels take for `file#subpath`), rendered from the note's own place so its links and embeds resolve as they
 * do there. A note card whose section cannot be found says so; one not resolved yet shows its link.
 */
export function renderCard(el: HTMLElement, node: CardNode, ctx: RenderContext): CardBody {
  el.empty();
  const holder = el.createDiv({ cls: ["lf-card-content", "markdown-rendered"] });
  if (node.file === undefined) return renderMarkdown(holder, node, node.text ?? "", ctx.figurePath, ctx);
  const resolved = ctx.resolved(node.id);
  if (resolved?.kind === "content") return renderMarkdown(holder, node, resolved.markdown, resolved.file.path, ctx);
  holder.classList.add("lf-card-link");
  const link = `${node.file}${node.subpath ?? ""}`;
  holder.textContent = resolved === undefined ? link : `${link}: ${resolved.kind === "missing" ? MISSING_TEXT[resolved.reason] : "not a note section"}`;
  return { drawn: Promise.resolve(), release: () => {} };
}

function renderMarkdown(holder: HTMLElement, node: CardNode, markdown: string, sourcePath: string, ctx: RenderContext): CardBody {
  // Owns the components the renderer creates, so a new drawing or the card's removal releases them.
  const owner = new Component();
  ctx.component.addChild(owner);
  const drawn = MarkdownRenderer.render(ctx.app, markdown, holder, sourcePath, owner).catch((error: unknown) => {
    console.error(`Link Figures: could not render card ${node.id}`, error);
  });
  return { drawn, release: () => ctx.component.removeChild(owner) };
}
