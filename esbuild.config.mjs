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
  plugins: watch ? [copyAfterBuild] : [],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
