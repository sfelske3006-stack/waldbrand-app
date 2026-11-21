// Baut eine Einzeldatei-Vorschau (dist/vorschau.html) für die Veröffentlichung als Artifact.
// Leaflet wird dort von cdnjs (exakte Version) geladen, alles andere inline.
// Aufruf: node tools/build-artifact.mjs          (ohne Geländemodell: Vorschau rechnet ohne Hang, mit Warnung)
//        node tools/build-artifact.mjs --dgm    (bettet data/dgm25.* als Base64 ein, ca. +1,8 MB)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
let html = rd("index.html");

let leafletCss = rd("vendor/leaflet/leaflet.css").replace(/url\(images\/([\w-]+\.png)\)/g, (_, f) => {
  const b64 = fs.readFileSync(path.join(root, "vendor/leaflet/images", f)).toString("base64");
  return `url(data:image/png;base64,${b64})`;
});
const appCss = rd("css/app.css");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("<!--LEAFLET-JS-->"));
const scripts = ["config.js", "js/params.js", "js/grid.js", "js/dem.js", "js/model.js", "js/contour.js", "js/weather.js", "js/osm.js", "js/suggest.js", "js/protocol.js", "js/app.js"]
  .map((f) => `<script>/* ${f} */\n${rd(f).replace(/<\/script/gi, "<\\/script")}\n</script>`).join("\n");
const vehicles = JSON.parse(rd("data/fahrzeuge.json"));
const withDgm = process.argv.includes("--dgm") && fs.existsSync(path.join(root, "data/dgm25.bin"));
const dgmInline = withDgm
  ? `window.__INLINE_DGM = { meta: ${rd("data/dgm25.json").trim()}, b64: "${fs.readFileSync(path.join(root, "data/dgm25.bin")).toString("base64")}" };\n`
  : "";

const out = `<title>Waldbrand-Lagebild NKS</title>
<style>
${leafletCss}
${appCss}
</style>
${body}
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<script>
window.__ARTIFACT_MODE = true;
window.__INLINE_FAHRZEUGE = ${JSON.stringify(vehicles)};
${dgmInline}</script>
${scripts}
`;
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/vorschau.html"), out);
console.log(`dist/vorschau.html geschrieben (${(out.length / 1024).toFixed(0)} KB)`);
