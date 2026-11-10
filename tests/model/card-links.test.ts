import { cardLinks, firstLink, renameInCardText, stripBlockIds } from "../../src/model/card-links";

describe("cardLinks", () => {
  test("parses `![[a#h|x]]` and `[[b#^id]]` with offsets", () => {
    const text = "See ![[a#h|x]] and [[b#^id]].";
    const links = cardLinks(text);
    expect(links).toEqual([
      { embed: true, target: "a", subpath: "#h", alias: "x", start: 4, end: 14 },
      { embed: false, target: "b", subpath: "#^id", alias: null, start: 19, end: 28 },
    ]);
    for (const link of links) expect(text.slice(link.start, link.end)).toMatch(/^!?\[\[.*\]\]$/);
    expect(firstLink(text)).toEqual(links[0]);
    expect(firstLink("no links")).toBeNull();
  });

  test("skips fenced and inline code", () => {
    const text = "`[[in code]]`\n\n```\n![[fenced]]\n```\n\n~~~md\n[[tilde]]\n~~~\n\n[[real]]";
    expect(cardLinks(text).map((l) => l.target)).toEqual(["real"]);
    expect(firstLink("`[[x]]` then ![[y]]")?.target).toBe("y");
    expect(firstLink("```\n[[x]]")).toBeNull();
  });
});

describe("renameInCardText", () => {
  test("renameInCardText keeps subpath, alias and size; leaves other targets and code alone", () => {
    const resolve = (target: string) => (target === "Results" || target === "Notes/Results" ? "Notes/Results.md" : target === "plot.png" ? "img/plot.png" : `${target}.md`);
    const text = [
      "![[Results#Figure 2|legend]] and [[Notes/Results#^b1]]",
      "[[Other]] ![[plot.png|300]]",
      "`[[Results]]`",
      "```",
      "![[Results]]",
      "```",
      "[[Results]]",
    ].join("\n");
    expect(renameInCardText(text, resolve, "Notes/Results.md", "Final")).toBe(
      ["![[Final#Figure 2|legend]] and [[Final#^b1]]", "[[Other]] ![[plot.png|300]]", "`[[Results]]`", "```", "![[Results]]", "```", "[[Final]]"].join("\n"),
    );
    expect(renameInCardText("![[plot.png|300]]", resolve, "img/plot.png", "img/plot 2.png")).toBe("![[img/plot 2.png|300]]");
    // Nothing to rename: the same string.
    expect(renameInCardText("[[Other]]", resolve, "Notes/Results.md", "Final")).toBe("[[Other]]");
  });
});

describe("stripBlockIds", () => {
  test("drops ` ^id` at the very end of a line, and a line holding only `^id`, with LF or CRLF line ends", () => {
    expect(stripBlockIds("Panel A ^cl-par\nNext")).toBe("Panel A\nNext");
    expect(stripBlockIds("Panel A ^cl-par\r\nNext ^b2c\r\n")).toBe("Panel A\r\nNext\r\n");
    expect(stripBlockIds("- one\n- two\n^list-id\n\nAfter")).toBe("- one\n- two\n\nAfter");
    expect(stripBlockIds("- one\r\n^list-id\r\nAfter")).toBe("- one\r\nAfter");
    expect(stripBlockIds("Last ^end")).toBe("Last");
  });

  test("leaves prose and what is not Obsidian's block id as it is", () => {
    // An exponent, a caret mid-line, no space before it, a character an id cannot hold, text after it, and code.
    for (const text of ["x ^2", "E = mc ^2\n", "a ^b c", "word^id", "note ^not_an.id", "x ^id trailing", "`x ^id`", "```\nkeep ^id\n```"]) {
      expect(stripBlockIds(text)).toBe(text);
    }
  });
});
