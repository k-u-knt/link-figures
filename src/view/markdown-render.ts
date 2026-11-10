import { Component, MarkdownRenderer } from "obsidian";
import type { RenderContext } from "../registry/node-type";

/** One rendering of Markdown on the stage: settles once drawn (or failed to), and `release` frees what it created. */
export interface RenderedMarkdown {
  drawn: Promise<void>;
  release(): void;
}

/**
 * Renders `markdown` into `el` with Obsidian's renderer, from `sourcePath` (so relative links and embeds resolve as they
 * do in that note), under a `Component` of its own that is a child of the view (`ctx.component`): `release` removes it,
 * which frees what the renderer made. A failure is logged as about `label`; `drawn` never rejects.
 */
export function renderMarkdown(ctx: Pick<RenderContext, "app" | "component">, markdown: string, el: HTMLElement, sourcePath: string, label: string): RenderedMarkdown {
  const owner = new Component();
  ctx.component.addChild(owner);
  const drawn = MarkdownRenderer.render(ctx.app, markdown, el, sourcePath, owner).catch((error: unknown) => {
    console.error(`Link Figures: could not render ${label}`, error);
  });
  return { drawn, release: () => ctx.component.removeChild(owner) };
}
