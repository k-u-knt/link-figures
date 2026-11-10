import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

/**
 * A card's content starts at its padding: the first thing drawn has no top margin. Obsidian's renderer puts a note's
 * front matter first, as a hidden `pre.frontmatter`, so the first thing drawn is the element after it.
 */
test("the first drawn child of a card has no top margin, after a hidden front matter block too", () => {
  const window = new Window();
  const document = window.document;
  const style = document.createElement("style");
  style.textContent = `h1 { margin-top: 30px; } p { margin-top: 16px; }\n` + readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  document.head.appendChild(style);
  document.body.innerHTML =
    '<div class="lf-card-content markdown-rendered" id="a"><h1>Head</h1><p>text</p></div>' +
    '<div class="lf-card-content markdown-rendered" id="b"><pre class="frontmatter language-yaml" style="display: none;"></pre><h1>Fig 1</h1><p>one</p></div>';
  const mt = (sel: string) => window.getComputedStyle(document.querySelector(sel) as never).marginTop;
  expect(mt("#a > h1")).toBe("0px");
  expect(mt("#b > h1")).toBe("0px");
  // Only the first: what follows keeps its margin.
  expect(mt("#a > p")).toBe("16px");
  expect(mt("#b > p")).toBe("16px");
});
