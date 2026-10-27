import { Notice } from "obsidian";
import type LinkFiguresPlugin from "../main";

/** How long the outcome stays on screen: it is read, and written into the README, by hand. */
const NOTICE_MS = 20_000;

/** The Local Font Access API, which TypeScript's DOM library does not describe. */
interface FontAccess {
  queryLocalFonts?: () => Promise<readonly unknown[]>;
}

/**
 * Whether `queryLocalFonts` exists here, and what it gives. It may need a user activation, so the call is made before
 * anything is awaited. Never rejects: a refusal is reported by the name of its error.
 */
export async function checkLocalFonts(win: FontAccess = window as FontAccess): Promise<string> {
  if (typeof win.queryLocalFonts !== "function") return "window.queryLocalFonts does not exist in this Obsidian.";
  try {
    const fonts = await win.queryLocalFonts();
    return `window.queryLocalFonts exists and returned ${fonts.length} ${fonts.length === 1 ? "font" : "fonts"}.`;
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return `window.queryLocalFonts exists but failed: ${typeof name === "string" ? name : String(error)}.`;
  }
}

/** Commands for the developer, not the user: they answer questions that the plan leaves to be found out in Obsidian. */
export function registerDevCommands(plugin: LinkFiguresPlugin): void {
  plugin.addCommand({
    id: "check-fonts",
    name: "Check local font access",
    callback: () => {
      void checkLocalFonts().then((outcome) => {
        console.info(`Link Figures: ${outcome}`);
        new Notice(`Link Figures: ${outcome}`, NOTICE_MS);
      });
    },
  });
}
