import { build } from "esbuild";

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
