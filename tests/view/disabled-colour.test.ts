import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

/**
 * A nullable colour switched off (the paper turned off) is a disabled colour input. It must look disabled as the other
 * inspector fields do: Obsidian gives a disabled text or number input opacity 0.5 and a not-allowed cursor, but nothing
 * to a colour input, whose swatch stayed bright.
 */
test("a disabled colour input in the inspector looks disabled, as a disabled text input does", () => {
  const window = new Window();
  const document = window.document;
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  document.head.appendChild(style);
  document.body.innerHTML =
    '<div class="lf-field-control"><input type="checkbox" class="lf-null-toggle"><input type="color" data-key="paper" disabled></div>' +
    '<div class="lf-field-control"><input type="color" data-key="fill"></div>';
  const [off, on] = Array.from(document.querySelectorAll('input[type="color"]'));
  const computed = (el: unknown) => window.getComputedStyle(el as never);
  expect(computed(off).opacity).toBe("0.5");
  expect(computed(off).cursor).toBe("not-allowed");
  expect(computed(on).opacity).not.toBe("0.5");
  expect(computed(on).cursor).toBe("pointer");
});
