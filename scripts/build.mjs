import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

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
  .replace(/\s*<link rel="stylesheet" href="styles\.css"\s*\/>/, "")
  .replace(/\s*<script type="module" src="anp\.js"><\/script>/, "")
  .replace("</head>", `  <style>\n${css}\n</style>\n</head>`)
  .replace("</body>", `  <script type="module">\n${js}\n</script>\n</body>`);

await writeFile("public/anp.html", selfContained);
console.log(`[build] public/anp.html written (self-contained, ${(selfContained.length / 1024).toFixed(0)} KB)`);

// 3) dist/ — the downloadable frontend folder (host it anywhere, point at a relay)
await mkdir("dist", { recursive: true });
for (const f of ["index.html", "styles.css", "anp.js", "anp.html"]) {
  await copyFile(`public/${f}`, `dist/${f}`);
}
await writeFile(
  "dist/README.txt",
  [
    "ANP Chat — frontend distribution",
    "",
    "This folder is a static web frontend. It has no backend of its own; it",
    "finds other people through a 'relay' server (WebSocket) and then connects",
    "browsers directly over WebRTC.",
    "",
    "How to use:",
    "  1. Host this folder on any static web server (GitHub Pages, Netlify,",
    "     `npx serve`, nginx, …) OR run the bundled relay which also serves it:",
    "         npm install && npm start   ->   http://localhost:8787/",
    "  2. Open the page, pick a display name, and you're in #general.",
    "  3. Share the page URL (or a #channel=name link) with others on the same",
    "     relay; you'll auto-discover and connect. Use the DM button for",
    "     end-to-end encrypted 1:1 chats.",
    "",
    "anp.html is the same app as a single self-contained file (JS+CSS inlined).",
    "",
    "Note: opening index.html directly from disk (file://) does NOT work for the",
    "multi-file version (browsers block module scripts over file://). Serve it",
    "over http(s), or use the relay above.",
  ].join("\n"),
);
console.log("[build] dist/ written (downloadable frontend folder)");
