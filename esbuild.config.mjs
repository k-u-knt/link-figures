import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyToPlugin } from "./scripts/deploy.mjs";

const watch = process.argv.includes("--watch");

/**
 * jsPDF's optional dependencies. It `import()`s them only inside `jsPDF.html()` and `addSvgAsImage()` (each load is caught and
 * rethrown as "Could not load ..."), neither of which the PDF exporter calls: svg2pdf.js draws SVG natively. Bundling them would
 * add about 0.9 MB to main.js, so they stay out and a call to those two methods would fail with that error.
 */
const JSPDF_OPTIONAL = ["html2canvas", "dompurify", "canvg"];

/** After each (re)build, copy the plugin files into the test vault. */
const copyAfterBuild = {
  name: "copy-to-test-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyToPlugin({ includeEnvVault: false });
    });
  },
};

/**
 * jsPDF's `output("pdfobjectnewwindow")` opens a window and loads PDFObject from a CDN with a <script> element. The PDF
 * exporter only calls `output("blob")` and `output("arraybuffer")`, so that branch is dead code, but Obsidian's plugin
 * review flags any runtime script injection. Replace the branch with an error; fail the build if jsPDF's code changed.
 */
const noJspdfScriptInjection = {
  name: "no-jspdf-script-injection",
  setup(build) {
    build.onLoad({ filter: /[\\/]jspdf[\\/]dist[\\/]jspdf\.es\.min\.js$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(args.path, "utf8");
      const branch = /case"pdfobjectnewwindow":[\s\S]*?(?=case"pdfjsnewwindow":)/;
      if (!branch.test(source)) throw new Error("jsPDF changed: update the no-jspdf-script-injection patch in esbuild.config.mjs");
      const contents = source.replace(branch, 'case"pdfobjectnewwindow":throw new Error("pdfobjectnewwindow is not available in Link Figures");');
      if (contents.includes('createElement("script")')) throw new Error("jsPDF still creates a script element");
      return { contents, loader: "js" };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  external: ["obsidian", "electron", ...builtins, ...JSPDF_OPTIONAL],
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  minify: false,
  treeShaking: true,
  outfile: "main.js",
  plugins: watch ? [noJspdfScriptInjection, copyAfterBuild] : [noJspdfScriptInjection],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
