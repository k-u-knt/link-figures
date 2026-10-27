import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyToPlugin } from "./scripts/deploy.mjs";

const watch = process.argv.includes("--watch");

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
  external: ["obsidian", "electron", ...builtins],
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
