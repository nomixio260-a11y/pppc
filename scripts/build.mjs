import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

// 1) Normal bundle served by the relay (public/anp.js + index.html + styles.css)
await build({
  entryPoints: ["src/client/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "public/anp.js",
  sourcemap: true,
  minify: false,
});
console.log("[build] public/anp.js written");

// 2) Single self-contained file: inline the (minified) JS and CSS into one
//    HTML so it works when opened straight from disk (file://), with no
//    separate asset requests and no server. Downloadable, double-click to use.
const inlineBundle = await build({
  entryPoints: ["src/client/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  minify: true,
});
// escape any "</script" so a string literal can't close the inline tag early
const js = inlineBundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile("public/styles.css", "utf8");
const indexHtml = await readFile("public/index.html", "utf8");

// strip the external <link>/<script> and inline instead
const selfContained = indexHtml
  .replace(/\s*<link rel="stylesheet" href="\/styles\.css"\s*\/>/, "")
  .replace(/\s*<script type="module" src="\/anp\.js"><\/script>/, "")
  .replace("</head>", `  <style>\n${css}\n</style>\n</head>`)
  .replace("</body>", `  <script type="module">\n${js}\n</script>\n</body>`);

await writeFile("public/anp.html", selfContained);
console.log(`[build] public/anp.html written (self-contained, ${(selfContained.length / 1024).toFixed(0)} KB)`);
