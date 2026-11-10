import { markdownToPlainText } from "../../src/export/markdown-text";

describe("markdownToPlainText", () => {
  test("headings, emphasis, links and wikilinks become their text", () => {
    const md = [
      "# Figure 1",
      "## *Mouse* cortex",
      "Cells **stained** for __NeuN__, *GFAP* and _Iba1_, ~~not~~ ==DAPI== with `code`.",
      "See [the methods](https://example.org/m) and [[Methods]], [[Methods#Imaging]], [[Methods|the protocol]] and [[#Stats]].",
    ].join("\n");
    expect(markdownToPlainText(md)).toBe(
      [
        "Figure 1",
        "Mouse cortex",
        "Cells stained for NeuN, GFAP and Iba1, not DAPI with code.",
        "See the methods and Methods, Methods > Imaging, the protocol and Stats.",
      ].join("\n"),
    );
  });

  test("- items become • items", () => {
    expect(markdownToPlainText("Panels:\n- a, cortex\n* b, **hippocampus**\n  + b2\n- [ ] c\n1. first")).toBe(
      "Panels:\n• a, cortex\n• b, hippocampus\n  • b2\n• c\n1. first",
    );
  });

  test("embeds are dropped", () => {
    expect(markdownToPlainText("Before ![[plot.png]] after\n![[plot.png|300]]\n![scale](bar.png)\nEnd")).toBe("Before after\nEnd");
  });

  test("blank lines separate paragraphs", () => {
    const md = "First line\nsecond line\n\n\n\nNext paragraph ^block1\n\n---\n\n> quoted\n> [!note] Callout title\n\n%%hidden%%\nLast";
    expect(markdownToPlainText(md)).toBe("First line\nsecond line\n\nNext paragraph\n\nquoted\nCallout title\n\nLast");
  });

  test("front matter and code fences: the matter is dropped, the code kept", () => {
    expect(markdownToPlainText("---\ntags: [a]\n---\nText\n\n```\nx = 1\n```")).toBe("Text\n\nx = 1");
  });
});
