// End-to-End-Test mit Playwright (Chromium). Start: npm run e2e  (Server wird selbst gestartet)
// Externe Dienste (Kacheln, Open-Meteo, Overpass) werden im Test bewusst blockiert und
// durch Beispielwetter bzw. synthetische OSM-Testdaten ersetzt.
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const ownRequests = [];
const OUT = process.env.SHOT_DIR || path.join(root, "docs");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".bin": "application/octet-stream" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8099, r));

const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok, info }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " – " + info : ""}`); };

// Synthetische OSM-Daten relativ zum Brandschwerpunkt (KEINE echten Daten)
function synthOsm(lat0, lon0) {
  const dy = (m) => m / 111195, dx = (m) => m / (111195 * Math.cos((lat0 * Math.PI) / 180));
  const pt = (x, y) => ({ lat: lat0 + dy(y), lon: lon0 + dx(x) });
  const rect = (x0, y0, x1, y1) => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1), pt(x0, y0)];
  let id = 1;
  const way = (tags, geometry) => ({ type: "way", id: id++, tags, geometry });
  const els = [
    way({ landuse: "meadow" }, rect(-5000, -5000, 5000, 5000)),
    way({ landuse: "forest", leaf_type: "needleleaved" }, rect(-1500, -1200, 700, 1500)),
    way({ landuse: "forest", leaf_type: "broadleaved" }, rect(700, -1200, 1600, 1500)),
    way({ landuse: "residential", name: "Testsiedlung" }, rect(1900, 200, 2600, 1200)),
    way({ highway: "track", tracktype: "grade2" }, [pt(650, -2000), pt(700, 0), pt(750, 2500)]),
    way({ highway: "tertiary", name: "Teststraße" }, [pt(1750, -3000), pt(1750, 3000)]),
    way({ waterway: "stream", name: "Testbach" }, [pt(-2000, -800), pt(3000, -900)]),
    way({ highway: "residential" }, [pt(1750, 600), pt(2600, 600)]),
    way({ highway: "unclassified", name: "Westweg" }, [pt(-1200, -3000), pt(-1200, 3000)]),
    // v0.3: Weg quer zur Ausbreitung (Nordost) mit Abstand zur Front; der Weg bei x = 700 liegt zu nah
    way({ highway: "track", tracktype: "grade1", name: "Nordostweg" }, [pt(400, 2200), pt(1300, 1100), pt(2200, 0)]),
  ];
  for (let k = 0; k < 6; k++) els.push({ type: "way", id: id++, tags: { building: "house" }, center: pt(2000 + k * 80, 700) });
  els.push({ type: "node", id: id++, lat: pt(1760, 300).lat, lon: pt(1760, 300).lon, tags: { emergency: "fire_hydrant" } });
  els.push({ type: "node", id: id++, lat: pt(-300, -700).lat, lon: pt(-300, -700).lon, tags: { emergency: "suction_point" } });
  return { version: 0.6, osm3s: { timestamp_osm_base: "SYNTHETISCHE TESTDATEN" }, elements: els };
}

const browser = await chromium.launch();
const consoleErrors = [], blocked = new Set();
// Neue Seite mit blockierten externen Diensten; optional DGM-Dateien als fehlend (404) simulieren
async function newPage(opts = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const pg = await c.newPage();
  pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  pg.on("request", (r) => { const u = new URL(r.url()); if (u.hostname === "localhost") ownRequests.push(u.pathname + u.search); });
  await pg.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      if (opts.noDem && /\/data\/dgm25\./.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
      return route.continue();
    }
    blocked.add(u.hostname);
    return route.abort("blockedbyclient");
  });
  return pg;
}
async function ack(pg) {
  await pg.goto("http://localhost:8099/", { waitUntil: "load" });
  await pg.check("#chk-ack");
  await pg.click("#btn-ack");
}
const page = await newPage();

try {
  await page.goto("http://localhost:8099/", { waitUntil: "load" });
  check("Seite lädt, Pflichthinweis sichtbar", await page.locator(".warnbar").isVisible() && (await page.locator(".warnbar").innerText()).includes("Modellprognose, unvalidiert"));
  const hdr = await page.locator(".warnbar").innerText();
  check("Kopfzeile: TESTVERSION – nicht für den Einsatz + Versionsnummer", hdr.includes("TESTVERSION – nicht für den Einsatz") && hdr.includes(`Version ${VERSION}`) && await page.locator("#hdr-test").isVisible(), hdr.slice(0, 80));
  check("Modellgrenzen-Dialog erscheint", await page.locator("#modal-ack").isVisible());
  check("Bestätigen-Knopf erst nach Häkchen aktiv", await page.locator("#btn-ack").isDisabled());
  await page.check("#chk-ack");
  await page.click("#btn-ack");
  check("Dialog geschlossen", await page.locator("#modal-ack").isHidden());

  // Polygon per Touch/Maus zeichnen
  await page.click("#btn-draw");
  const box = await page.locator("#map").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2 + 40;
  for (const [ox, oy] of [[-60, -40], [50, -50], [70, 30], [-40, 50]]) await page.mouse.click(cx + ox, cy + oy);
  await page.click("#btn-finish");
  const polyText = await page.locator("#poly-status").innerText();
  check("Polygon gezeichnet (4 Punkte)", polyText.includes("4 Punkten"), polyText.slice(0, 60));

  // Wetter: Open-Meteo im Test blockiert -> Fehlermeldung, dann Beispieldaten
  await page.click("#btn-wx");
  await page.waitForSelector("#wx-status .msg.err", { timeout: 25000 });
  check("Wetter-Abruf blockiert -> sichtbare Fehlermeldung", true, (await page.locator("#wx-status").innerText()).slice(0, 80));
  await page.click("#btn-wx-sample");
  check("Beispieldaten als solche markiert", (await page.locator("#wx-status").innerText()).includes("BEISPIELDATEN") && (await page.locator("#hdr-status").innerText()).includes("BEISPIELDATEN"));

  // Manuelle Überschreibung Wind
  await page.click("#wx-override summary");
  await page.fill("#ov-windKmh", "20");
  await page.locator("#ov-windKmh").dispatchEvent("change");
  check("Überschreibung gekennzeichnet", (await page.locator("#wx-table").innerText()).includes("20*"));

  // Lauf 1: ohne OSM (Ersatzbrennstoff)
  await page.selectOption("#sel-fuel", "nadelwald");
  let t0 = Date.now();
  await page.click("#btn-run");
  await page.waitForSelector("#results table", { timeout: 60000 });
  const tRun1 = (Date.now() - t0) / 1000;
  const res1 = await page.locator("#results").innerText();
  check("Prognose ohne OSM berechnet", /wahrscheinlich/i.test(res1) && /möglich/i.test(res1), `${tRun1.toFixed(1)} s`);
  check("Fallback sichtbar (keine Brennstoffkarte, Beispieldaten)", res1.includes("Keine Brennstoffkarte") && res1.includes("BEISPIELDATEN"));
  const demStatus = await page.locator("#dem-status").innerText();
  check("DGM geladen und angezeigt (Quelle, Lizenz)", demStatus.includes("DGM1 NRW") && demStatus.includes("dl-de/zero-2-0"), demStatus.slice(0, 90));
  check("Mit DGM: Gelände im Ergebnis, keine Hang-Warnung", res1.includes("Gelände: DGM1 NRW") && res1.includes("Gelände im Rechengebiet") && !res1.includes("Hangneigung nicht berücksichtigt"));
  check("Zeitstempel, Modellversion, Wetteralter angezeigt", res1.includes("Berechnet:") && res1.includes("Version") && res1.includes("Alter bei Rechnung"));
  check("Unsicherheitsband-Overlay auf Karte", (await page.locator(".wb-overlay, path.wb-contour").count()) >= 1 && (await page.locator(".hz-label").count()) >= 2);
  check("Prüfgrenze der Riegel (möglich bei Bereitschaft + Wirkzeit) als Linie", (await page.locator("path.wb-ready").count()) >= 1 && (await page.locator(".ready-label").count()) >= 1);
  check("Standard: Konturen (Flächen, Schraffur-Pattern, Referenzlinie), Hinweis Glättung", (await page.locator("path.wb-contour.wb-likely").count()) >= 1 && (await page.locator("path.wb-contour.wb-possible").count()) >= 1 && (await page.locator("path.wb-contour.wb-ref").count()) >= 1 &&
    (await page.locator("path.wb-possible").first().getAttribute("fill")).startsWith("url(#wb-hatch-") && (await page.locator("path.wb-ref").first().getAttribute("fill")) === "none" &&
    (await page.locator("#lg-note").innerText()).includes("geglättete Darstellung des 25-m-Rasters"));
  const sug1 = await page.locator("#suggestions").innerText();
  check("Vorschläge ohne OSM (geometrisch) erscheinen", sug1.includes("Abwehrlinie") && /Riegel|Bereitstellung/.test(sug1));
  check("Geländewind im Ergebnis angegeben (aktiv)", res1.includes("Geländewind: aktiv"), (res1.match(/Geländewind:[^\n]*/) || [""])[0].slice(0, 120));
  check("Anfahrt je Fahrzeug in den Vorschlägen (geschätzt bzw. Vorgabe), Pflichtfahrzeuge, Grundschutz", /Anfahrt:/.test(sug1) && /Pflichtfahrzeug/.test(sug1) && /Grundschutz/.test(sug1) && /(geschätzt, kein Routing|Vorgabe)/.test(sug1));
  const protoTw = await page.evaluate(() => JSON.stringify(Protocol.all().filter((e) => e.typ === "prognose").pop().daten.gelaendewind));
  check("Protokoll: Geländewind aktiv vermerkt", protoTw.includes('"aktiv":true'), protoTw.slice(0, 100));
  // Geländewind aus -> Ergebnis „aus“, wieder an
  await page.uncheck("#chk-twind"); await page.uncheck("#chk-tmoist");
  await page.click("#btn-run");
  await page.waitForFunction(() => document.querySelector("#results")?.innerText.includes("Geländewind: aus"), null, { timeout: 60000 });
  check("Schalter Geländewind aus -> Ergebnis „Geländewind: aus“", true);
  await page.check("#chk-twind"); await page.check("#chk-tmoist");

  // Lauf 2: mit synthetischen OSM-Testdaten
  const c = await page.evaluate(() => { const p = window.__wb.state.poly; return [p.reduce((s, x) => s + x[0], 0) / p.length, p.reduce((s, x) => s + x[1], 0) / p.length]; });
  await page.evaluate((j) => window.__wb.injectOsm(j, "Testdaten (synthetisch)"), synthOsm(c[0], c[1]));
  t0 = Date.now();
  await page.click("#btn-run");
  await page.waitForFunction(() => document.querySelector("#results")?.innerText.includes("SYNTHETISCHE TESTDATEN"), null, { timeout: 60000 });
  const tRun2 = (Date.now() - t0) / 1000;
  const res2 = await page.locator("#results").innerText();
  check("Prognose mit OSM-Testdaten berechnet", res2.includes("Wohnbebauung"), `${tRun2.toFixed(1)} s`);
  check("Rechenzeit unter 30 s", tRun2 < 30, `${tRun2.toFixed(1)} s`);
  const sug2 = await page.locator("#suggestions").innerText();
  const nLines = await page.locator(".sug .badge.l").count();
  const nVeh = await page.locator(".sug .badge.v").count();
  check("Riegel-Vorschläge aus Barrieren", nLines >= 1, `${nLines} Linien`);
  check("Fahrzeugvorschläge mit Begründung", nVeh >= 2 && sug2.includes("Rückzugsweg nicht geprüft"), `${nVeh} Fahrzeuge`);
  check("Wasserinfo (nicht verifiziert) vorhanden", sug2.includes("Entnahmestelle") || sug2.includes("Wasserversorgung"));
  const lineOk = await page.evaluate(() => {
    const sg = window.__wb.state.sug;
    return sg.lines.length ? sg.lines.every((l) => /Vorlaufzeit/.test(l.reason) && l.leadMin >= 0) : !!document.querySelector("#no-line");
  });
  check("Riegel mit Vorlaufzeit bzw. Meldung „Keine geeignete Riegelstellung“", lineOk);
  const vehOk = await page.evaluate(() => {
    const sg = window.__wb.state.sug;
    const noWater = sg.vehicles.filter((v) => /^(ELW|MTF|DLK|GW)/.test(v.vehicle.typ) && /Riegel|Objektschutz|Wasserversorgung/.test(v.taskKind || ""));
    const stage = sg.vehicles.filter((v) => v.stage);
    return { noWater: noWater.length, stage: stage.length, groups: document.querySelectorAll(".veh-group.stage").length };
  });
  check("Fahrzeuge ohne Wasser nicht im Löscheinsatz; Bereitstellungsraum als ein Marker", vehOk.noWater === 0 && (vehOk.stage < 2 || vehOk.groups === 1), JSON.stringify(vehOk));
  await page.screenshot({ path: path.join(OUT, "screenshot.png") });

  // Darstellung umschalten (Raster), Wahl gespeichert; Regression schwarze Kästchen in beiden Ansichten
  async function blackBlocks(pg) {
    // Marker/Beschriftungen ausblenden, nur Prognoseflächen prüfen: zusammenhängende 6x6-px-Blöcke fast schwarz
    await pg.waitForTimeout(400);
    await pg.addStyleTag({ content: ".leaflet-marker-pane,.leaflet-tooltip-pane,.legend,.maptools{visibility:hidden!important}" }).then((h) => h.evaluate((e) => e.setAttribute("data-tmp", "1")));
    const buf = await pg.locator("#map").screenshot();
    await pg.evaluate(() => document.querySelectorAll("style[data-tmp]").forEach((e) => e.remove()));
    return pg.evaluate(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const dark = (px, py) => { const o = (py * c.width + px) * 4; return d[o] < 45 && d[o + 1] < 45 && d[o + 2] < 45; };
      let blocks = 0;
      for (let py = 0; py + 6 <= c.height; py += 3) for (let px = 0; px + 6 <= c.width; px += 3) {
        let all = true;
        for (let yy = 0; yy < 6 && all; yy++) for (let xx = 0; xx < 6 && all; xx++) if (!dark(px + xx, py + yy)) all = false;
        if (all) blocks++;
      }
      return blocks;
    }, buf.toString("base64"));
  }
  const prevView = await page.evaluate(() => { const m = window.__wb.map; return [m.getCenter().lat, m.getCenter().lng, m.getZoom()]; });
  await page.evaluate(() => { const s = window.__wb.state; const c = s.poly.reduce((a, p) => [a[0] + p[0] / s.poly.length, a[1] + p[1] / s.poly.length], [0, 0]); window.__wb.map.setView(c, 17, { animate: false }); });
  const bbK = await blackBlocks(page);
  await page.click(".lg-btn[data-mode='raster']");
  const rasterOk = (await page.locator("path.wb-raster").count()) >= 3 && (await page.locator("path.wb-contour").count()) === 0 && (await page.locator(".wb-overlay").count()) === 0;
  const stored = await page.evaluate(() => localStorage.getItem("wb_display"));
  check("Umschalter Raster: Zellumrisse statt Konturen, Wahl gespeichert", rasterOk && stored === '"raster"', `gespeichert ${stored}`);
  const bbR = await blackBlocks(page);
  check("Keine schwarzen Kästchen (Konturen und Raster, Zoom 17)", bbK === 0 && bbR === 0, `schwarze 6x6-Blöcke: Konturen ${bbK}, Raster ${bbR}`);
  check("Legende zeigt Rasterhinweis", (await page.locator("#lg-note").innerText()).includes("Rasteransicht"));
  await page.click(".lg-btn[data-mode='kontur']");
  await page.evaluate((v) => window.__wb.map.setView([v[0], v[1]], v[2], { animate: false }), prevView);

  // Sperren + Neuberechnung mit Differenz
  await page.locator(".sug button[data-act='lock']").first().click();
  await page.locator(".sug button[data-act='discard']").last().click();
  await page.click("#btn-resuggest");
  check("Neuberechnung zeigt Unterschied", (await page.locator("#sug-diff").innerText()).includes("Neu berechnet"));

  // Szenario B
  await page.fill("#sc-fixdir", "270");
  await page.click("#btn-scenario");
  await page.waitForSelector("#sc-result table", { timeout: 60000 });
  check("Szenario-Vergleich A/B", (await page.locator("#sc-result").innerText()).includes("Wind aus 270"));

  // Protokoll
  await page.click("#tab-protokoll");
  const proto = await page.locator("#proto-verify").innerText();
  check("Protokoll mit intakter Prüfsummenkette", proto.includes("intakt"), proto);
  await page.click("#btn-geojson");
  const gj = JSON.parse(await page.locator("#exp-text").inputValue());
  check("GeoJSON-Export", gj.type === "FeatureCollection" && gj.features.some((f) => f.properties.typ === "prognose"), `${gj.features.length} Features`);
  await page.click("#btn-exp-close");

  // Fahrzeugliste
  await page.click("#tab-fahrzeuge");
  const veh = await page.locator("#veh-table").innerText();
  check("Fahrzeugliste geladen und gekennzeichnet", veh.includes("LF KatS") && veh.includes("Annahme: Normwert") && veh.includes("belegt (Quelle)") && veh.includes("ungeprüft, aus Websuche"));
  const nAll = await page.locator("#veh-table tbody tr").count();
  await page.selectOption("#vf-kommune", "Lohmar");
  const nLohmar = await page.locator("#veh-table tbody tr").count();
  const komm = await page.$$eval("#veh-table tbody tr td:nth-child(4)", (tds) => tds.map((t) => t.innerText.split("\n")[0]));
  check("Fahrzeugliste filterbar nach Kommune", nAll >= 100 && nLohmar >= 1 && nLohmar < nAll && komm.every((k) => k === "Lohmar"), `${nAll} gesamt, Lohmar ${nLohmar}`);
  await page.selectOption("#vf-kommune", "");
  await page.selectOption("#vf-sort", "anfahrt");
  const anfs = await page.$$eval("#veh-table tbody tr td:nth-child(5)", (tds) => tds.map((t) => { const m = t.innerText.match(/ca\. (\d+) min/); return m ? +m[1] : Infinity; }));
  const finite = anfs.filter(Number.isFinite);
  check("Fahrzeugliste sortiert nach Anfahrtszeit (geschätzt)", finite.length >= 50 && finite.every((v, k) => k === 0 || v >= finite[k - 1]), `${finite.slice(0, 5).join(", ")} … ${finite.length} mit Schätzung`);
  check("Grundschutz im Fahrzeugbereich (Nachbarkommunen, Anfahrt zum Gerätehaus)", (await page.locator("#gs-panel").innerText()).includes("Grundschutz") && (await page.locator("#gs-panel .gs").count()) === 2);
  const keepView = await page.evaluate(() => { const m = window.__wb.map; const v = [m.getCenter().lat, m.getCenter().lng, m.getZoom()]; m.setView([50.8, 7.3], 10, { animate: false }); return v; });
  await page.waitForTimeout(300);
  const grp = await page.evaluate(() => {
    const groups = [...document.querySelectorAll(".st-group")].map((e) => parseInt(e.textContent, 10));
    const singles = document.querySelectorAll(".st-marker").length;
    const withCoord = window.__wb.state.stations.filter((s) => Number.isFinite(s.lat) && s.lat !== null).length;
    return { groups: groups.length, inGroups: groups.reduce((a, b) => a + b, 0), singles, withCoord };
  });
  check("Wachen-Marker gruppiert (ohne Zusatzbibliothek), alle Wachen mit Koordinate vertreten", grp.groups >= 1 && grp.inGroups + grp.singles === grp.withCoord, JSON.stringify(grp));
  await page.evaluate((v) => window.__wb.map.setView([v[0], v[1]], v[2], { animate: false }), keepView);
  await page.click("#tab-lage");

  // Tablet hochkant
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "screenshot-tablet.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("Kein horizontales Scrollen (Tablet hochkant)", !overflow);
  const protoAll = await page.evaluate(() => JSON.stringify(Protocol.all()));
  check("Protokoll enthält DGM-Quelle/Stand", protoAll.includes("\"gelaende\"") && protoAll.includes("dl-de/zero-2-0") && protoAll.includes("max_tan_hang"));
  check("Protokoll: Grundschutz, Anfahrt (geschätzt), Gemeindeteil", protoAll.includes("\"grundschutz\"") && protoAll.includes("kein Routing") && protoAll.includes("\"gemeindeteil\""));
  // Cache-Busting: alle eigenen Skripte/CSS/Daten mit ?v=<Version>
  const own = ownRequests.filter((u) => /\.(js|css|json|bin)(\?|$)/.test(u));
  const noV = own.filter((u) => !u.includes(`v=${encodeURIComponent(VERSION)}`));
  check("Cache-Busting: eigene Skripte, CSS und Datendateien mit ?v=Version", own.length >= 15 && noV.length === 0, `${own.length} Abrufe, ohne Version: ${noV.slice(0, 3).join(", ")}`);
} catch (e) {
  check("Testablauf", false, e.message);
}

// Prognose mit Schummerung in hügeligem Gelände (südliches Gemeindegebiet, Hang zum Tal; Lage aus DGM gewählt)
try {
  const pg = await newPage();
  await ack(pg);
  await pg.evaluate(() => window.__wb.demReady());
  const lat0 = 50.8045, lon0 = 7.3405, r = 60;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  await pg.click("#btn-wx-sample");
  await pg.click("#wx-override summary");
  await pg.fill("#ov-windKmh", "6");
  await pg.locator("#ov-windKmh").dispatchEvent("change");
  await pg.selectOption("#sel-fuel", "gruenland");
  await pg.check("#chk-shade");
  await pg.click("#btn-run");
  await pg.waitForSelector("#results table", { timeout: 60000 });
  const res = await pg.locator("#results").innerText();
  check("Hügeliges Gelände: Prognose mit Hang", res.includes("Gelände: DGM1 NRW"), (res.match(/Raster 25 m, [\d,]+ s/) || [""])[0] + "; " + (res.match(/Gelände im Rechengebiet[^\n]*\n?[^\n]*/) || [""])[0].replace(/\n/g, " "));
  check("Schummerung (offline) auf der Karte", (await pg.locator(".wb-shade").count()) === 1);
  await pg.waitForTimeout(1000); // fitBounds-Animation abwarten, dann eine Stufe näher
  await pg.click(".leaflet-control-zoom-in");
  await pg.waitForTimeout(1000);
  await pg.screenshot({ path: path.join(OUT, "screenshot-dgm.png") });
  await pg.context().close();
} catch (e) {
  check("Testablauf DGM-Screenshot", false, e.message);
}

// Screenshots für den Nutzer (deviceScaleFactor 2): Konturen + gültige Riegellinie in hügeligem Gelände nahe
// (synthetischer) Bebauung, danach dieselbe Lage in der Rasteransicht.
try {
  const { hillOsm } = await import("./synth-osm.mjs");
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const pg = await c2.newPage();
  pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  await pg.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); blocked.add(u.hostname); return route.abort("blockedbyclient"); });
  await ack(pg);
  await pg.evaluate(() => { localStorage.removeItem("wb_display"); window.__wb.setDisplay("kontur", false); });
  await pg.evaluate(() => window.__wb.demReady());
  const lat0 = 50.8045, lon0 = 7.3405, r = 60;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  const osmJson = hillOsm(lat0, lon0);
  await pg.evaluate((j) => window.__wb.injectOsm(j, "Testdaten (synthetisch)"), osmJson);
  await pg.click("#btn-wx-sample");
  await pg.click("#wx-override summary");
  for (const [k, v] of [["windKmh", "12"], ["windDirDeg", "225"], ["tempC", "27"], ["rh", "30"]]) { await pg.fill(`#ov-${k}`, v); await pg.locator(`#ov-${k}`).dispatchEvent("change"); }
  await pg.check("#chk-shade");
  await pg.click("#btn-run");
  await pg.waitForFunction(() => document.querySelector("#results")?.innerText.includes("SYNTHETISCHE TESTDATEN") && document.querySelector("#suggestions")?.innerText.length > 0, null, { timeout: 60000 });
  const info = await pg.evaluate(() => {
    const s = window.__wb.state;
    return { lines: s.sug.lines.map((l) => ({ id: l.id, lead: Math.round(l.leadMin), len: Math.round(l.lengthM) })), veh: s.sug.vehicles.map((v) => `${v.vehicle.typ}:${v.taskKind}`), dev: s.run.display.maxAreaDevPct };
  });
  check("Screenshot-Lage: gültige Riegellinie(n) in hügeligem Gelände", info.lines.length >= 1, JSON.stringify(info.lines));
  check("Screenshot-Lage: Objektschutz für Bebauung im Prognosebereich", info.veh.some((v) => v.endsWith("Objektschutz")), info.veh.join(", "));
  // synthetische OSM-Objekte zur Orientierung einzeichnen (nur Test, gekennzeichnet)
  await pg.evaluate((j) => {
    const m = window.__wb.map, grp = L.layerGroup().addTo(m);
    for (const el of j.elements) {
      const t = el.tags || {};
      if (el.type === "way" && el.geometry && (t.highway || t.waterway)) L.polyline(el.geometry.map((p) => [p.lat, p.lon]), { color: t.waterway ? "#1e6fb8" : "#444", weight: t.highway === "track" ? 2 : 3, dashArray: t.highway === "track" ? "4 3" : null, interactive: false }).addTo(grp);
      else if (el.type === "way" && el.geometry && (t.landuse === "residential" || t.natural === "water")) L.polygon(el.geometry.map((p) => [p.lat, p.lon]), { color: t.natural ? "#1e6fb8" : "#555", weight: 1.5, fillColor: t.natural ? "#7fb2d6" : "#b9b2b0", fillOpacity: 0.5, interactive: false }).addTo(grp);
      else if (t.building && el.center) L.rectangle([[el.center.lat - 0.00009, el.center.lon - 0.00013], [el.center.lat + 0.00009, el.center.lon + 0.00013]], { color: "#333", weight: 1, fillColor: "#8a817c", fillOpacity: 0.9, interactive: false }).addTo(grp);
    }
    grp.eachLayer((l) => l.bringToBack && l.bringToBack());
    const cap = document.createElement("div");
    cap.className = "maphint"; cap.style.top = "12px"; cap.style.bottom = "auto"; cap.style.left = "12px"; cap.style.zIndex = "900";
    cap.textContent = "Test-Lage: synthetische OSM-Daten (Wege, Siedlung, Gebäude erfunden), Beispielwetter Wind 12 km/h aus SW; Hintergrund: DGM-Schummerung (Geobasis NRW)";
    document.querySelector(".mapwrap").appendChild(cap);
    document.querySelector(".maptools").style.visibility = "hidden";
  }, osmJson);
  await pg.waitForTimeout(1500); // Zoom-Animation (fitBounds nach der Rechnung) abwarten
  // Ausschnitt: Mitte zwischen Brand und R1, Zoomstufe 14 (ca. 6 m/px)
  await pg.evaluate(() => { const s = window.__wb.state; const l = s.sug.lines[0].latlngs; const m = l[Math.floor(l.length / 2)]; const c = s.poly.reduce((a, p) => [a[0] + p[0] / s.poly.length, a[1] + p[1] / s.poly.length], [0, 0]); window.__wb.map.setView([(c[0] + 2 * m[0]) / 3, (c[1] + 2 * m[1]) / 3], 14, { animate: false }); });
  await pg.waitForTimeout(800);
  await pg.evaluate(() => document.querySelector("#sec-vorschlaege").scrollIntoView());
  await pg.screenshot({ path: path.join(OUT, "screenshot-konturen.png") });
  await pg.click(".lg-btn[data-mode='raster']");
  await pg.waitForTimeout(500);
  await pg.screenshot({ path: path.join(OUT, "screenshot-raster.png") });
  check("Screenshots Konturen/Raster (deviceScaleFactor 2) erstellt", fs.existsSync(path.join(OUT, "screenshot-konturen.png")) && fs.existsSync(path.join(OUT, "screenshot-raster.png")), `max. Flächenabweichung Kontur ${info.dev.toFixed(1)} %`);
  await c2.close();
} catch (e) {
  check("Testablauf Screenshots Konturen/Raster", false, e.message);
}

// Fahrzeugeinsatz (0.4.2, deviceScaleFactor 2): Lage in der Gemarkung Seelscheid OHNE OSM-Daten (wie beim
// Nutzer: Overpass nicht erreichbar) -> geometrische Riegellinie R1 (Bereitschaft 25 min) und Auffanglinie R2
// (40 min), Flankensicherung, Grundschutz am Gerätehaus, Bereitstellungsraum nur mit begründeten Fahrzeugen.
try {
  const c2 = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const pg = await c2.newPage();
  pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  await pg.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); blocked.add(u.hostname); return route.abort("blockedbyclient"); });
  await ack(pg);
  await pg.evaluate(() => window.__wb.demReady());
  await pg.waitForFunction(() => !!window.__wb.grenzenReady(), null, { timeout: 15000 });
  const lat0 = 50.8705, lon0 = 7.3120, r = 60;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  await pg.click("#btn-wx-sample");
  await pg.click("#wx-override summary");
  for (const [k, v] of [["windKmh", "12"], ["windDirDeg", "225"], ["tempC", "27"], ["rh", "30"]]) { await pg.fill(`#ov-${k}`, v); await pg.locator(`#ov-${k}`).dispatchEvent("change"); }
  await pg.selectOption("#sel-fuel", "mischwald");
  await pg.check("#chk-shade");
  await pg.click("#btn-run");
  await pg.waitForFunction(() => document.querySelector("#suggestions")?.innerText.length > 0, null, { timeout: 60000 });
  const d = await pg.evaluate(() => {
    const s = window.__wb.state.sug;
    return {
      lines: s.lines.map((l) => ({ id: l.id, len: Math.round(l.lengthM), second: !!l.secondStage })),
      gs: s.grundschutz.filter((a) => a.vehicle).map((a) => a.vehicle.id),
      veh: s.vehicles.map((v) => ({ id: v.vehicleId, kind: v.taskKind, role: v.role || null, stage: !!v.stage, reason: v.reason })),
      late: Object.keys(s.dispatch.late).length, second: !!s.lineInfo.second,
      notes: s.notes.filter((n) => /zweite Riegelstellung/.test(n)),
    };
  });
  check("0.4.2: Grundschutzfahrzeug steht am Gerätehaus, nicht im Bereitstellungsraum", d.gs.length === 2 && !d.veh.some((v) => d.gs.includes(v.id)), `GS ${d.gs.join(", ")}`);
  // Zweite Riegelstellung wird nur erzeugt, wenn Fahrzeuge für die vorderste Linie zu spät bereit sind;
  // sonst muss die App begründen, warum keine gefunden wurde.
  check("0.4.2: Auffanglinie für die spätere Bereitschaftsstufe (oder begründet keine)",
    !(d.second && d.late) || d.lines.some((l) => l.second) || d.notes.length === 1,
    `${d.lines.length} Linie(n), zu spät: ${d.late}, Hinweise: ${d.notes.length}`);
  check("0.4.2: wasserführende Fahrzeuge der zweiten Stufe im Einsatz statt als Reserve", ["nk-hlf20", "nk-lf20"].every((id) => d.veh.some((v) => v.id === id && !v.stage)), d.veh.filter((v) => /^nk-/.test(v.id)).map((v) => `${v.id}:${v.kind}`).join(", "));
  check("0.4.2: jedes Fahrzeug im Bereitstellungsraum mit Rolle und Begründung", d.veh.filter((v) => v.stage).every((v) => v.role && /Bereitschaft:/.test(v.reason) && v.reason.length > 60), d.veh.filter((v) => v.stage).map((v) => v.role).join(", "));
  await pg.waitForTimeout(1500);
  // Ausschnitt: Brandfläche, Riegellinie(n) und alle Fahrzeugstandorte
  await pg.evaluate(() => {
    const s = window.__wb.state, pts = [...s.poly];
    for (const l of s.sug.lines) pts.push(...l.latlngs);
    for (const v of s.sug.vehicles) pts.push([v.lat, v.lon]);
    window.__wb.map.fitBounds(L.latLngBounds(pts).pad(0.3), { animate: false });
  });
  await pg.waitForTimeout(900);
  // Entzerrung: Kartenbeschriftungen dürfen sich nicht mehr überdecken
  const ov = await pg.evaluate(() => {
    const els = [...document.querySelectorAll("#map .veh-marker,#map .veh-group,#map .line-label,#map .ready-label,#map .hz-label")];
    const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    let n = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) n++;
    }
    return { labels: rs.length, overlaps: n };
  });
  check("0.4.2: Kartenbeschriftungen überdecken sich nicht", ov.overlaps === 0, `${ov.labels} Label, ${ov.overlaps} Überdeckungen`);
  // Legende für diesen Screenshot ausblenden: sonst verdeckt sie den Bereitstellungsraum
  await pg.evaluate(() => { document.querySelector("#legend").style.visibility = "hidden"; });
  await pg.evaluate(() => document.querySelector("#sec-vorschlaege").scrollIntoView());
  await pg.screenshot({ path: path.join(OUT, "screenshot-fahrzeuge.png") });
  check("Screenshot Fahrzeuge (deviceScaleFactor 2) erstellt", fs.existsSync(path.join(OUT, "screenshot-fahrzeuge.png")));
  await c2.close();
} catch (e) {
  check("Testablauf Screenshot Fahrzeuge", false, e.message);
}

// Gemeindeteil: automatisch aus Gemarkung, manuelle Wahl überschreibt (Bereitschaft 25/40 min, Vorgabe Auftraggeber)
try {
  const pg = await newPage();
  await ack(pg);
  await pg.evaluate(() => window.__wb.demReady());
  await pg.waitForFunction(() => !!window.__wb.grenzenReady(), null, { timeout: 15000 });
  // Brand nahe Gerätehaus Seelscheid (Gemarkung Seelscheid)
  const lat0 = 50.8705, lon0 = 7.3120, r = 50;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  await pg.click("#btn-wx-sample");
  await pg.selectOption("#sel-fuel", "mischwald");
  await pg.click("#btn-run");
  await pg.waitForFunction(() => document.querySelector("#suggestions")?.innerText.length > 0, null, { timeout: 60000 });
  const st1 = await pg.locator("#teil-status").innerText();
  const li1 = await pg.evaluate(() => window.__wb.state.sug.lineInfo);
  check("Gemeindeteil automatisch: Seelscheid (Gemarkung), früheste Bereitschaft 25 min", st1.includes("Gemeindeteil Seelscheid") && li1.readyMin === 25 && li1.anfahrtSource === "Vorgabe", `${li1.readyMin} min; ${st1.slice(0, 120)}`);
  const se1 = await pg.evaluate(() => window.__wb.state.sug.vehicles.filter((v) => /^se-/.test(v.vehicleId) && v.anfahrt).map((v) => v.anfahrt.ready));
  await pg.evaluate(() => window.__wb.setTeil("Neunkirchen"));
  await pg.waitForFunction(() => document.querySelector("#teil-status")?.innerText.includes("Gemeindeteil Neunkirchen"), null, { timeout: 15000 });
  const se2 = await pg.evaluate(() => window.__wb.state.sug.vehicles.filter((v) => /^se-/.test(v.vehicleId) && v.anfahrt).map((v) => v.anfahrt.ready));
  const protoT = await pg.evaluate(() => Protocol.all().some((e) => e.typ === "gemeindeteil_wahl" && e.daten.modus === "Neunkirchen"));
  check("Manuelle Wahl „Neunkirchen“ überschreibt: LZ Seelscheid 40 min, im Protokoll vermerkt", se1.every((v) => v === 25) && se2.length >= 3 && se2.every((v) => v === 40) && protoT, `vorher ${se1.join("/")}, nachher ${se2.join("/")}`);
  check("Zweite Prüfgrenze (40 min + Wirkzeit) auf der Karte", (await pg.locator("path.wb-ready2").count()) >= 1 || !(await pg.evaluate(() => window.__wb.state.sug.lineInfo.second)));
  const gsInfo = await pg.evaluate(() => window.__wb.state.sug.grundschutz.map((a) => `${a.wache.name}: ${a.vehicle ? a.vehicle.bezeichnung + " (" + a.kommune + "), " + (a.anfahrt.ok ? Math.round(a.anfahrt.min) + " min" : "unbekannt") : "keins"}`));
  check("Grundschutz mit Kreisdaten: zwei verschiedene Fahrzeuge aus Nachbarkommunen", gsInfo.length === 2 && !gsInfo.some((t) => t.includes("keins") || t.includes("(Neunkirchen-Seelscheid)")), gsInfo.join(" | "));
  check("Grundschutz-Marker an den Gerätehäusern", (await pg.locator(".gs-marker").count()) >= 1 || (await pg.locator(".st-group").count()) >= 1);
  await pg.evaluate(() => window.__wb.setTeil("auto"));
  await pg.context().close();
} catch (e) {
  check("Testablauf Gemeindeteil/Grundschutz", false, e.message);
}

// Ortssuche (0.5.0): Lazy Loading, Straße, Adresse, Ortsteil, Rettungspunkt, Koordinate, Zündpunkt,
// Rettungspunkt-Ebene, Beschriftungen, Pflicht-Attribution. Externe Dienste bleiben blockiert.
try {
  const pg = await newPage();
  const mark = ownRequests.length;
  const reqs = (re) => ownRequests.slice(mark).filter((u) => re.test(u)).length;
  await ack(pg);
  await pg.waitForTimeout(300);
  check("Suche: Index vor dem ersten Fokus nicht geladen (lazy)", reqs(/^\/data\/suche-index\.json/) === 0 && reqs(/^\/data\/rettungspunkte-kwf\.json/) === 0, `${reqs(/suche-index/)} Abrufe`);
  const aria = await pg.evaluate(() => {
    const i = document.getElementById("sx-input"), l = document.getElementById("sx-list");
    return { role: i.getAttribute("role"), controls: i.getAttribute("aria-controls"), ac: i.getAttribute("aria-autocomplete"), exp: i.getAttribute("aria-expanded"),
      lrole: l.getAttribute("role"), label: (document.querySelector("label[for=sx-input]") || {}).textContent, h: Math.round(i.getBoundingClientRect().height) };
  });
  check("Suche: ARIA-Combobox mit Listbox, beschriftet, Touch-Ziel >= 48 px", aria.role === "combobox" && aria.controls === "sx-list" && aria.ac === "list" && aria.exp === "false" && aria.lrole === "listbox" && !!aria.label && aria.h >= 48, JSON.stringify(aria));
  await pg.click("#sx-input");
  await pg.waitForFunction(() => window.Search.status().geladen, null, { timeout: 30000 });
  check("Suche: Index + Rettungspunkte erst beim Fokus geladen (je 1 Abruf, mit ?v=Version)",
    reqs(new RegExp(`^/data/suche-index\\.json\\?v=${VERSION}$`)) === 1 && reqs(new RegExp(`^/data/rettungspunkte-kwf\\.json\\?v=${VERSION}$`)) === 1,
    ownRequests.slice(mark).filter((u) => /suche-index|rettungspunkte/.test(u)).join(", "));

  // Straße: Rechteck (BBox) und Ergebniskarte
  await pg.fill("#sx-input", "Zum Wirbel");
  await pg.waitForSelector("#sx-opt-0.sx-strasse");
  const strLabel = await pg.textContent("#sx-opt-0 .sx-label");
  await pg.keyboard.press("ArrowDown");
  const act = await pg.getAttribute("#sx-input", "aria-activedescendant");
  await pg.keyboard.press("Enter");
  await pg.waitForSelector("#sx-card:not([hidden])");
  await pg.waitForTimeout(1300);
  const st = await pg.evaluate(() => ({
    title: document.querySelector(".sx-card-title").textContent,
    rect: [...document.querySelectorAll("#map path")].filter((p) => p.getAttribute("stroke-dasharray")).length,
    c: window.__wb.map.getCenter(), sub: document.querySelector("#sx-card .sx-sub").textContent,
  }));
  check("Suche Straße: Treffer, Tastaturauswahl, BBox-Rechteck auf der Karte", strLabel.trim() === "Zum Wirbel" && act === "sx-opt-0" && st.title === "Zum Wirbel" && st.rect >= 1 && /Straße/.test(st.sub), JSON.stringify({ strLabel, act, rect: st.rect, sub: st.sub.slice(0, 60) }));

  // Adresse mit Hausnummer + „Als Zündpunkt setzen“
  await pg.fill("#sx-input", "Zum Wirbel 12a");
  await pg.waitForSelector("#sx-opt-0.sx-adresse");
  const adrLabel = await pg.textContent("#sx-opt-0 .sx-label");
  await pg.keyboard.press("Enter");
  await pg.waitForSelector("#sx-card:not([hidden])");
  await pg.waitForTimeout(1300);
  const adr = await pg.evaluate(() => ({ pins: document.querySelectorAll(".sx-pin").length, c: window.__wb.map.getCenter(), z: window.__wb.map.getZoom(), title: document.querySelector(".sx-card-title").textContent, coord: document.querySelector("#sx-card .sx-coord").textContent }));
  check("Suche Adresse mit Hausnummer: Marker, Karte zentriert, Koordinate + UTM in der Ergebniskarte",
    adrLabel.trim() === "Zum Wirbel 12a" && adr.pins === 1 && Math.abs(adr.c.lat - 50.848274) < 0.0006 && Math.abs(adr.c.lng - 7.400211) < 0.0006 && adr.z >= 17 && /UTM 32N \d{6} \d{7}/.test(adr.coord),
    JSON.stringify(adr));
  await pg.selectOption("#sel-radius", "50");
  await pg.click("#sx-ign");
  await pg.waitForTimeout(300);
  const ign = await pg.evaluate(() => {
    const s = window.__wb.state;
    const lat = s.poly.reduce((a, p) => a + p[0], 0) / s.poly.length, lon = s.poly.reduce((a, p) => a + p[1], 0) / s.poly.length;
    return { n: s.poly.length, lat, lon, status: document.getElementById("poly-status").innerText, proto: Protocol.all().some((e) => e.typ === "brandflaeche" && /Suchtreffer „Zum Wirbel 12a“/.test(e.daten.text || "")) };
  });
  check("Suche: „Als Zündpunkt setzen“ erzeugt Brandfläche am Treffer und wird protokolliert",
    ign.n === 24 && Math.abs(ign.lat - 50.848274) < 0.0006 && Math.abs(ign.lon - 7.400211) < 0.0008 && /24 Punkten/.test(ign.status) && ign.proto, JSON.stringify(ign).slice(0, 200));

  // Ortsteil
  await pg.fill("#sx-input", "Hermerath");
  await pg.waitForSelector("#sx-opt-0.sx-ortsteil");
  await pg.click("#sx-opt-0");
  await pg.waitForSelector("#sx-card:not([hidden])");
  await pg.waitForTimeout(1300);
  const ot = await pg.evaluate(() => ({ title: document.querySelector(".sx-card-title").textContent, sub: document.querySelector("#sx-card .sx-sub").textContent,
    rect: [...document.querySelectorAll("#map path")].filter((p) => p.getAttribute("stroke-dasharray")).length, c: window.__wb.map.getCenter() }));
  check("Suche Ortsteil: Klick zentriert auf die Ortslage (BBox-Rechteck)", ot.title === "Hermerath" && /Ortsteil/.test(ot.sub) && ot.rect >= 1 && Math.abs(ot.c.lat - 50.85) < 0.08, JSON.stringify(ot).slice(0, 160));

  // Rettungspunkt-Nummer (tolerant) mit Pflicht-Quellenvermerk
  await pg.fill("#sx-input", "01 501 su");
  await pg.waitForSelector("#sx-opt-0.sx-rettungspunkt");
  await pg.keyboard.press("Enter");
  await pg.waitForSelector("#sx-card:not([hidden])");
  const rpCard = await pg.evaluate(() => document.getElementById("sx-card").innerHTML);
  check("Suche Rettungspunkt-Nummer: Treffer mit Quellenvermerk (Version, Datenurheber-PDF, CC BY-ND 4.0, Haftungsausschluss)",
    /01-501-SU/.test(rpCard) && /© KWF-Rettungspunkte v2\.21/.test(rpCard) && /docs\.rettungspunkte-forst\.de\/Metadaten_KWF_Rettungspunkte\.pdf/.test(rpCard)
    && /href="https:\/\/rettungspunkte-forst\.de"/.test(rpCard) && /CC BY-ND 4\.0/.test(rpCard) && /Haftungsausschluss/.test(rpCard), rpCard.slice(0, 120));

  // Koordinate (Grad/Dezimalminuten) -> Marker + UTM
  await pg.fill("#sx-input", "N 50° 48.27' E 7° 20.43'");
  await pg.waitForSelector("#sx-opt-0.sx-koordinate");
  await pg.keyboard.press("Enter");
  await pg.waitForSelector("#sx-card:not([hidden])");
  // flyTo abwarten (Animation)
  await pg.waitForFunction(() => { const c = window.__wb.map.getCenter(); return Math.abs(c.lat - 50.8045) < 0.0005 && Math.abs(c.lng - 7.3405) < 0.0005; }, null, { timeout: 15000 }).catch(() => {});
  await pg.waitForTimeout(400);
  const co = await pg.evaluate(() => ({ coord: document.querySelector("#sx-card .sx-coord").textContent, c: window.__wb.map.getCenter(), pins: document.querySelectorAll(".sx-pin").length }));
  check("Suche Koordinate: Grad/Dezimalminuten erkannt, Marker, UTM 32N angezeigt",
    /50,804500° N · 7,340500° O · UTM 32N 383068 5629397/.test(co.coord) && co.pins === 1 && Math.abs(co.c.lat - 50.8045) < 0.001 && Math.abs(co.c.lng - 7.3405) < 0.001, JSON.stringify(co));

  // Esc: Liste schließen, zweites Esc leert das Feld
  await pg.fill("#sx-input", "Seelsch");
  await pg.waitForSelector("#sx-list:not([hidden])");
  await pg.keyboard.press("Escape");
  const listHidden = await pg.evaluate(() => document.getElementById("sx-list").hidden);
  await pg.keyboard.press("Escape");
  check("Suche Tastatur: Esc schließt die Liste, zweites Esc leert das Feld", listHidden === true && (await pg.inputValue("#sx-input")) === "");

  // Kartenebene Rettungspunkte an/aus (Ebenenschalter), Nummern, Tooltip, Attribution
  await pg.evaluate(() => { window.__wb.map.stop(); window.__wb.map.setView([50.70771, 7.215326], 14, { animate: false }); window.__wb.setRpLayer(true); });
  await pg.waitForFunction(() => document.querySelectorAll(".sx-rp-marker").length > 3, null, { timeout: 20000 });
  await pg.waitForTimeout(800);
  const on14 = await pg.evaluate(() => ({ m: document.querySelectorAll(".sx-rp-marker").length,
    lab: [...document.querySelectorAll(".sx-rp-label")].filter((e) => getComputedStyle(e).display !== "none").length,
    attr: document.querySelector(".leaflet-control-attribution").textContent,
    attrHref: [...document.querySelectorAll(".leaflet-control-attribution a")].map((a) => a.getAttribute("href")),
    ctl: [...document.querySelectorAll(".leaflet-control-layers-overlays label")].map((l) => l.textContent.trim()) }));
  check("Rettungspunkt-Ebene: Marker mit Nummer, im Ebenenschalter abschaltbar, Attribution in der Karte",
    on14.m > 3 && on14.lab > 3 && on14.ctl.some((t) => /Rettungspunkte \(KWF/.test(t)) && /© KWF-Rettungspunkte v2\.21/.test(on14.attr) && /Datenurheber/.test(on14.attr)
    && on14.attrHref.includes("https://rettungspunkte-forst.de") && on14.attrHref.includes("https://docs.rettungspunkte-forst.de/Metadaten_KWF_Rettungspunkte.pdf"),
    JSON.stringify({ m: on14.m, lab: on14.lab, ctl: on14.ctl.slice(-1) }));
  const tip = await pg.evaluate(async () => {
    const m = document.querySelector(".sx-rp-marker").closest(".leaflet-marker-icon");
    const title = m.getAttribute("title") || m.getAttribute("alt");
    m.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const p = document.querySelector(".leaflet-popup-content");
    return { title, pop: p ? p.textContent : "" };
  });
  check("Rettungspunkt-Ebene: Tooltip/Beschriftung und Popup mit Beschreibung, Koordinate und Quelle", /^Rettungspunkt /.test(tip.title) && /Rettungspunkt /.test(tip.pop) && /KWF-Rettungspunkte v2\.21/.test(tip.pop) && /° N/.test(tip.pop), JSON.stringify(tip).slice(0, 160));
  // Entzerrung: sichtbare Nummern dürfen sich nicht überdecken, auch nicht mit Wachen-/Fahrzeuglabeln
  await pg.evaluate(() => window.__wb.rpLayer.refresh());
  await pg.waitForTimeout(500);
  const ov = await pg.evaluate(() => {
    const els = [...document.querySelectorAll("#map .sx-rp-label, #map .veh-marker, #map .veh-group, #map .st-group, #map .gs-marker, #map .line-label, #map .ready-label, #map .hz-label")]
      .filter((e) => getComputedStyle(e).display !== "none");
    const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    let n = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) n++;
    }
    return { labels: rs.length, overlaps: n, aus: document.querySelectorAll(".sx-rp-label.sx-rp-label-off").length };
  });
  check("Rettungspunkt-Nummern überdecken keine anderen Beschriftungen (Entzerrung)", ov.overlaps === 0 && ov.labels > 3, `${ov.labels} Label sichtbar, ${ov.aus} ausgeblendet, ${ov.overlaps} Überdeckungen`);
  await pg.evaluate(() => window.__wb.map.setZoom(12, { animate: false }));
  await pg.waitForTimeout(500);
  const z12 = await pg.evaluate(() => document.querySelectorAll(".sx-rp-marker").length);
  await pg.evaluate(() => { window.__wb.map.setView([50.70771, 7.215326], 14, { animate: false }); window.__wb.setRpLayer(false); });
  await pg.waitForTimeout(500);
  const off = await pg.evaluate(() => ({ m: document.querySelectorAll(".sx-rp-marker").length, attr: document.querySelector(".leaflet-control-attribution").textContent }));
  check("Rettungspunkt-Ebene: unter Zoom 13 ausgeblendet, Ebene abschaltbar (Marker und Attribution verschwinden)", z12 === 0 && off.m === 0 && !/KWF-Rettungspunkte/.test(off.attr), `Zoom 12: ${z12}, aus: ${off.m}`);

  // Pflicht-Attribution im Reiter „Grenzen & Quellen“
  await pg.click("#tab-info");
  const src = await pg.evaluate(() => {
    const el = document.getElementById("search-sources");
    return { text: el.innerText, links: [...el.querySelectorAll("a")].map((a) => a.textContent.trim() + " -> " + a.getAttribute("href")), sichtbar: !document.getElementById("panel-info").hidden };
  });
  check("Reiter „Grenzen & Quellen“: Pflicht-Attribution KWF (Links, CC BY-ND 4.0, unverändert, v2.21, Stand 10/2026) und Geobasis NRW",
    src.sichtbar && /© KWF-Rettungspunkte v2\.21, Datenurheber, www\.rettungspunkte-forst\.de/.test(src.text.replace(/\s+/g, " "))
    && src.links.includes("www.rettungspunkte-forst.de -> https://rettungspunkte-forst.de")
    && src.links.includes("Datenurheber -> https://docs.rettungspunkte-forst.de/Metadaten_KWF_Rettungspunkte.pdf")
    && /CC BY-ND 4\.0/.test(src.text) && /unverändert/.test(src.text) && /Version 2\.21, Stand 10\/2026/.test(src.text)
    && /Geobasis NRW/.test(src.text) && /dl-de\/zero-2-0/.test(src.text), src.links.join(" | ").slice(0, 200));
  await pg.context().close();
} catch (e) {
  check("Testablauf Ortssuche", false, e.message);
}

// Online-Suche (Nominatim): nur auf ausdrückliche Aktion, mit Attribution, abschaltbar. Nominatim wird GEMOCKT.
try {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pg = await c.newPage();
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  const nominatim = [];
  await pg.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "localhost") return route.continue();
    if (u.hostname === "nominatim.openstreetmap.org") {
      nominatim.push(u.toString());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ lat: "50.8601", lon: "7.3302", display_name: "Mockhof, Neunkirchen-Seelscheid (MOCK)", name: "Mockhof", osm_type: "node", osm_id: 42, boundingbox: ["50.8600", "50.8602", "7.3301", "7.3303"] }]) });
    }
    blocked.add(u.hostname);
    return route.abort("blockedbyclient");
  });
  await ack(pg);
  await pg.click("#sx-input");
  await pg.waitForFunction(() => window.Search.status().geladen, null, { timeout: 30000 });
  await pg.fill("#sx-input", "Mockhofweg Nirgendwo");
  await pg.waitForSelector("#sx-opt-online");
  await pg.waitForTimeout(600);
  check("Online-Suche: kein Autocomplete – ohne Knopfdruck keine Anfrage an Nominatim", nominatim.length === 0, `${nominatim.length} Anfragen`);
  await pg.click("#sx-opt-online");
  await pg.waitForSelector("#sx-opt-0.sx-online");
  const on = await pg.evaluate(() => ({ label: document.querySelector("#sx-opt-0 .sx-label").textContent, status: document.getElementById("sx-status").textContent }));
  const nu = new URL(nominatim[0]);
  await pg.keyboard.press("Enter");
  await pg.waitForSelector("#sx-card:not([hidden])");
  const onSrc = await pg.textContent("#sx-card .sx-src");
  check("Online-Suche: genau 1 Anfrage auf Knopfdruck, auf das Gebiet begrenzt, Attribution © OpenStreetMap",
    nominatim.length === 1 && nu.searchParams.get("bounded") === "1" && !!nu.searchParams.get("viewbox") && on.label === "Mockhof" && /OpenStreetMap/.test(on.status) && /OpenStreetMap/.test(onSrc),
    JSON.stringify(on).slice(0, 140));
  // abschaltbar
  await pg.click("#tab-info");
  await pg.uncheck("#chk-search-online");
  await pg.click("#tab-lage");
  await pg.fill("#sx-input", "Mockhofweg Nirgendwo zwei");
  await pg.waitForTimeout(600);
  const offRow = await pg.evaluate(() => ({ row: !!document.getElementById("sx-opt-online"), en: window.Search.config.online.enabled }));
  check("Online-Suche abschaltbar: ohne Erlaubnis kein Online-Eintrag und keine Anfrage", offRow.row === false && offRow.en === false && nominatim.length === 1, JSON.stringify(offRow));
  await c.close();
} catch (e) {
  check("Testablauf Online-Suche", false, e.message);
}

// Screenshots Ortssuche (deviceScaleFactor 2, Tablet quer): Trefferliste mit Typ-Symbolen und Rettungspunkt-Ebene
// sowie Ergebniskarte mit Quellenangabe und „Als Zündpunkt setzen“.
try {
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  const pg = await c2.newPage();
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  await pg.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); blocked.add(u.hostname); return route.abort("blockedbyclient"); });
  await ack(pg);
  await pg.click("#sx-input");
  await pg.waitForFunction(() => window.Search.status().geladen, null, { timeout: 30000 });
  await pg.evaluate(() => { window.__wb.map.setView([50.8182, 7.2708], 14, { animate: false }); window.__wb.setRpLayer(true); });
  await pg.waitForFunction(() => document.querySelectorAll(".sx-rp-marker").length > 0, null, { timeout: 20000 });
  await pg.waitForTimeout(800);
  // Hinweisleiste der Karte mit Erklärung zum Bild (wie bei den übrigen Screenshots), frei von Maßstab und Attribution
  const caption = (pg2, text) => pg2.evaluate((t) => {
    let cap = document.getElementById("shot-caption");
    if (!cap) { cap = document.createElement("div"); cap.id = "shot-caption"; cap.className = "maphint"; document.querySelector(".mapwrap").appendChild(cap); }
    cap.style.zIndex = "900"; cap.style.left = "72px"; cap.style.bottom = "76px"; cap.style.maxWidth = "min(560px, calc(100% - 100px))";
    cap.textContent = t;
  }, text);
  await caption(pg, "Ortssuche: Trefferliste mit Typ-Symbol (Ortsteil, Straße, Kommune), Tastaturbedienung; grüne Quadrate = KWF-Rettungspunkte mit Nummer (abschaltbare Kartenebene). Kartenhintergrund im Test gesperrt.");
  await pg.fill("#sx-input", "Seelscheid");
  await pg.waitForSelector("#sx-opt-0");
  await pg.keyboard.press("ArrowDown");
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(OUT, "screenshot-suche.png") });
  const shotOk = fs.existsSync(path.join(OUT, "screenshot-suche.png"));
  const opts = await pg.evaluate(() => [...document.querySelectorAll("#sx-list [role=option]")].map((o) => o.querySelector(".sx-typ").textContent));
  check("Screenshot Suche (deviceScaleFactor 2) erstellt, Trefferliste mit mehreren Typ-Symbolen", shotOk && new Set(opts).size >= 2, opts.join(", "));
  // zweites Bild: Ergebniskarte mit Quelle und Knopf „Als Zündpunkt setzen“
  await pg.fill("#sx-input", "01-501-SU");
  await pg.waitForSelector("#sx-opt-0.sx-rettungspunkt");
  await pg.keyboard.press("Enter");
  await pg.waitForSelector("#sx-card:not([hidden])");
  await caption(pg, "Suchtreffer Rettungspunkt: Nummer, Beschreibung, Koordinate und UTM, Quellenvermerk mit Lizenz und Haftungsausschluss, Knopf „Als Zündpunkt setzen“ (legt die Brandfläche mit dem gewählten Startradius an).");
  await pg.waitForTimeout(1400);
  await pg.screenshot({ path: path.join(OUT, "screenshot-suche-treffer.png") });
  check("Screenshot Suchtreffer (Rettungspunkt mit Quellenvermerk und Zündpunkt-Knopf) erstellt", fs.existsSync(path.join(OUT, "screenshot-suche-treffer.png")) && await pg.locator("#sx-ign").isVisible());
  await c2.close();
} catch (e) {
  check("Testablauf Screenshots Ortssuche", false, e.message);
}

// GitHub-Pages-Simulation: Projekt unter Unterpfad /waldbrand-app/ (alle Pfade relativ, kein Abruf außerhalb)
try {
  const PREFIX = "/waldbrand-app/";
  const outside = [], notFound = [], served2 = [];
  const sub = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    served2.push(u);
    if (!u.startsWith(PREFIX)) { outside.push(req.url); res.writeHead(404); res.end(); return; }
    const p = path.join(root, decodeURIComponent(u.slice(PREFIX.length - 1)).replace(/\/$/, "/index.html"));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { notFound.push(req.url); res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => sub.listen(8098, r));
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pg = await c.newPage();
  const subErr = [];
  pg.on("pageerror", (e) => subErr.push(e.message));
  await pg.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); return route.abort("blockedbyclient"); });
  await pg.goto(`http://localhost:8098${PREFIX}`, { waitUntil: "load" });
  await pg.check("#chk-ack"); await pg.click("#btn-ack");
  await pg.evaluate(() => window.__wb.demReady());
  await pg.evaluate((p) => window.__wb.setPolygon(p), [[50.858, 7.334], [50.8585, 7.3355], [50.8575, 7.336]]);
  await pg.click("#btn-wx-sample");
  await pg.click("#btn-run");
  await pg.waitForSelector("#results table", { timeout: 60000 });
  const r = await pg.locator("#results").innerText();
  const demOk = (await pg.locator("#dem-status").innerText()).includes("DGM1 NRW");
  const vehOk = await pg.evaluate(() => window.__wb.state.vehicles.length);
  check("Unterpfad /waldbrand-app/ (GitHub Pages): lädt, DGM + Fahrzeuge + Grenzen, Prognose, keine Abrufe außerhalb, keine 404", r.includes("Geländewind:") && demOk && vehOk >= 100 && outside.length === 0 && notFound.length === 0 && subErr.length === 0, `außerhalb: ${outside.slice(0, 3).join(", ")}; 404: ${notFound.slice(0, 3).join(", ")}; Fehler: ${subErr.slice(0, 2).join(" | ")}`);
  // Ortssuche unter dem Unterpfad: Index und Rettungspunkte werden relativ geladen und finden Treffer
  await pg.click("#sx-input");
  await pg.waitForFunction(() => window.Search.status().geladen, null, { timeout: 30000 });
  await pg.fill("#sx-input", "Zum Wirbel 12a");
  await pg.waitForSelector("#sx-opt-0.sx-adresse");
  const subHit = await pg.textContent("#sx-opt-0 .sx-label");
  const subIdx = served2.filter((u) => /suche-index\.json|rettungspunkte-kwf\.json/.test(u));
  check("Unterpfad: Ortssuche lädt data/suche-index.json und data/rettungspunkte-kwf.json relativ und findet die Adresse",
    subHit.trim() === "Zum Wirbel 12a" && subIdx.length === 2 && subIdx.every((u) => u.startsWith(PREFIX)) && outside.length === 0 && notFound.length === 0 && subErr.length === 0,
    subIdx.join(", "));
  // Wassermodul unter dem Unterpfad: css/water.css und js/water*.js werden relativ geladen, der Reiter rechnet
  await pg.click("#tab-wasser");
  await pg.waitForTimeout(400);
  const subW = await pg.evaluate(() => {
    const ui = window.__wb.water();
    return { has: typeof window.Water === "object" && typeof window.WaterUI === "object",
      css: !!getComputedStyle(document.documentElement).getPropertyValue("--w-level").trim(),
      panel: document.getElementById("wasser-panel").innerText.length,
      hint: document.getElementById("wasser-hinweis").innerText.replace(/\s+/g, " ").slice(0, 80),
      basins: ui && ui.result ? ui.result.plan.basins.length : null };
  });
  const subFiles = served2.filter((u) => /water/.test(u));
  check("Unterpfad: Wassermodul (js/water*.js, css/water.css) relativ geladen, Reiter „Wasser“ nutzbar",
    subW.has && subW.css && subFiles.length === 4 && subFiles.every((u) => u.startsWith(PREFIX)) && (subW.panel > 200 || /Keine/.test(subW.hint)) && outside.length === 0 && notFound.length === 0 && subErr.length === 0,
    `${subFiles.length} Dateien: ${subFiles.join(", ")}; Becken ${subW.basins}; Hinweis: ${subW.hint}`);
  await c.close();
  sub.close();
} catch (e) {
  check("Testablauf Unterpfad", false, e.message);
}

// Screenshot Geländewind (deviceScaleFactor 2): Pfeile + Prognose in einem Tal (Tal bei Eischeid, aus DGM gewählt)
try {
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const pg = await c2.newPage();
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  await pg.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); blocked.add(u.hostname); return route.abort("blockedbyclient"); });
  await ack(pg);
  await pg.evaluate(() => { localStorage.removeItem("wb_display"); window.__wb.setDisplay("kontur", false); window.__wb.setTerrain({ wind: true, moisture: true }); });
  await pg.evaluate(() => window.__wb.demReady());
  const lat0 = 50.8267, lon0 = 7.3815, r = 50;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  await pg.click("#btn-wx-sample");
  await pg.click("#wx-override summary");
  for (const [k, v] of [["windKmh", "9"], ["windDirDeg", "225"], ["tempC", "27"], ["rh", "30"]]) { await pg.fill(`#ov-${k}`, v); await pg.locator(`#ov-${k}`).dispatchEvent("change"); }
  await pg.selectOption("#sel-fuel", "gruenland");
  await pg.check("#chk-shade");
  await pg.check("#chk-twlayer");
  await pg.click("#btn-run");
  await pg.waitForSelector("#results table", { timeout: 60000 });
  await pg.waitForTimeout(1500);
  const tw = await pg.evaluate(() => window.__wb.state.run.twDisplay);
  check("Ebene Geländewind: Pfeile (ausgedünnt, 250 m) und Legende", (await pg.locator("path.wb-twind").count()) >= 2 && await pg.locator("#lg-wind").isVisible() && tw && tw.arrows > 100, JSON.stringify(tw));
  await pg.evaluate((c) => window.__wb.map.setView([c[0] + 0.006, c[1] + 0.012], 14, { animate: false }), [lat0, lon0]);
  await pg.evaluate(() => { document.querySelector(".maptools").style.visibility = "hidden"; const cap = document.createElement("div"); cap.className = "maphint"; cap.style.top = "12px"; cap.style.bottom = "auto"; cap.style.left = "12px"; cap.style.zIndex = "900"; cap.textContent = "Test-Lage Tal bei Eischeid: Beispielwetter, Wind 9 km/h aus SW, Grünland einheitlich (ohne OSM); Pfeile = Geländewind (vereinfacht), Hintergrund DGM-Schummerung; Fahrzeugmarker für die Aufnahme ausgeblendet"; document.querySelector(".mapwrap").appendChild(cap); const st = document.createElement("style"); st.textContent = ".veh-marker,.veh-group,.st-group,.gs-marker{display:none!important}"; document.head.appendChild(st); });
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: path.join(OUT, "screenshot-gelaendewind.png") });
  check("Screenshot Geländewind (deviceScaleFactor 2) erstellt", fs.existsSync(path.join(OUT, "screenshot-gelaendewind.png")));
  await c2.close();
} catch (e) {
  check("Testablauf Screenshot Geländewind", false, e.message);
}

// Fehlende DGM-Datei -> Fallback ohne Hang mit sichtbarer Warnung
try {
  const pg = await newPage({ noDem: true });
  await ack(pg);
  await pg.evaluate(() => window.__wb.demReady());
  const st = await pg.locator("#dem-status").innerText();
  check("Ohne DGM-Datei: Hinweis im Datenbereich", st.includes("Kein Geländemodell") && st.includes("Hangneigung wird nicht berücksichtigt"), st.slice(0, 80));
  const pts = [[50.858, 7.334], [50.8585, 7.3355], [50.8575, 7.336]];
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  await pg.click("#btn-wx-sample");
  await pg.click("#btn-run");
  await pg.waitForSelector("#results table", { timeout: 60000 });
  const res = await pg.locator("#results").innerText();
  check("Ohne DGM-Datei: Prognose mit Warnung „Hangneigung nicht berücksichtigt“", res.includes("Hangneigung nicht berücksichtigt") && res.includes("kein Geländemodell"));
  check("Ohne DGM-Datei: Schummerung deaktiviert", await pg.locator("#chk-shade").isDisabled());
  await pg.context().close();
} catch (e) {
  check("Testablauf ohne DGM", false, e.message);
}

// ---------------------------------------------------------------- Wasserversorgung (Modul, 0.6.0)
// Lage wie beim Konturen-Screenshot (hügeliges Gelände, synthetische OSM-Daten mit Hydrant und Teich):
// erzeugt Riegel- und Objektschutzfahrzeuge, also Abnehmer mit Wasserbedarf.
try {
  const { hillOsm } = await import("./synth-osm.mjs");
  const c2 = await browser.newContext({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });
  const pg = await c2.newPage();
  pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  pg.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + e.message));
  await pg.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); blocked.add(u.hostname); return route.abort("blockedbyclient"); });
  await ack(pg);
  await pg.evaluate(() => window.__wb.demReady());
  const lat0 = 50.8045, lon0 = 7.3405, r = 60;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  const osmJson = hillOsm(lat0, lon0);
  await pg.evaluate((j) => window.__wb.injectOsm(j, "Testdaten (synthetisch)"), osmJson);
  await pg.click("#btn-wx-sample");
  await pg.click("#wx-override summary");
  for (const [k, v] of [["windKmh", "12"], ["windDirDeg", "225"], ["tempC", "27"], ["rh", "30"]]) { await pg.fill(`#ov-${k}`, v); await pg.locator(`#ov-${k}`).dispatchEvent("change"); }
  await pg.check("#chk-shade");
  await pg.click("#btn-run");
  await pg.waitForFunction(() => document.querySelector("#suggestions")?.innerText.length > 0, null, { timeout: 60000 });

  // 1) Reiter „Wasser“ erscheint und zeigt den Pflichthinweis des Moduls
  await pg.click("#tab-wasser");
  await pg.waitForSelector("#w-kpi table", { timeout: 20000 });
  const tabOk = await pg.evaluate(() => ({
    selected: document.getElementById("tab-wasser").getAttribute("aria-selected"),
    visible: !document.getElementById("panel-wasser").hidden,
    disclaimer: document.querySelector("#wasser-panel .w-disclaimer").innerText.replace(/\s+/g, " "),
    hint: document.getElementById("wasser-hinweis").innerText,
  }));
  check("Wasser: Reiter erscheint mit Pflichthinweis „Simulation mit Annahmen, keine Einsatzplanung“",
    tabOk.selected === "true" && tabOk.visible && /Simulation mit Annahmen, keine Einsatzplanung/.test(tabOk.disclaimer) && !tabOk.hint.trim(),
    tabOk.disclaimer.slice(0, 90));

  // 2) Plan und Simulation gerechnet; Abnehmer stammen aus den Fahrzeugaufgaben
  const w1 = await pg.evaluate(() => {
    const ui = window.__wb.water(), r = ui.result, s = window.__wb.state.sug;
    const wanted = s.vehicles.filter((v) => ["Riegel", "Flanke", "Objektschutz"].includes(v.taskKind));
    return {
      basins: r.plan.basins.length, reserve: r.plan.basins.filter((b) => b.reserve).map((b) => b.id),
      consumers: r.plan.consumers.length, wanted: wanted.length, kinds: [...new Set(wanted.map((v) => v.taskKind))],
      readyMins: [...new Set(r.plan.consumers.map((c) => c.readyMin))].sort((a, b) => a - b),
      sources: r.plan.sources.length, unverified: r.plan.sources.filter((x) => !x.verified).length,
      pendel: r.plan.vehicles.filter((v) => v.role === "pendel").length,
      kpi: r.sim.kpi, ms: r.ms, it: r.iterations,
      kpiText: document.getElementById("w-kpi").innerText.replace(/\s+/g, " "),
      diag: document.querySelectorAll("#w-diag li").length,
      charts: document.querySelectorAll("#wasser-panel canvas.w-chart").length,
      markers: { basin: document.querySelectorAll("#map .wbasin").length, src: document.querySelectorAll("#map .wsrc").length, cons: document.querySelectorAll("#map .wcons").length, veh: document.querySelectorAll("#map .wveh").length, route: document.querySelectorAll("#map path.w-route").length },
    };
  });
  check("Wasser: Simulation rechnet (Becken, Entnahmestellen, Pendelfahrzeuge, Kennzahlen)",
    w1.basins >= 1 && w1.sources >= 1 && w1.pendel >= 1 && w1.kpi.demandLpm > 0 && w1.ms < 2000 &&
    /Bedarf/.test(w1.kpiText) && /Lieferung/.test(w1.kpiText) && /Defizit/.test(w1.kpiText) && /erstes Leerlaufen/.test(w1.kpiText),
    `${w1.basins} Becken, ${w1.sources} Entnahmestellen, ${w1.pendel} Pendelfahrzeuge, Bedarf ${Math.round(w1.kpi.demandLpm)} l/min, Deckung ${w1.kpi.coveragePct.toFixed(0)} %, ${w1.ms.toFixed(0)} ms, ${w1.it} Nachplanung(en)`);
  check("Wasser: Abnehmer sind genau die Fahrzeuge für Riegel/Auffanglinie, Flanke, Objektschutz (je eigene Bereitschaftszeit)",
    w1.consumers === w1.wanted && w1.consumers >= 1 && w1.readyMins.length >= 1 && w1.readyMins.every((m) => m >= 0),
    `${w1.consumers} Abnehmer (${w1.kinds.join(", ")}), Bereitschaft ${w1.readyMins.join("/")} min`);
  check("Wasser: Kartenebenen und Diagramme (Becken, Entnahmestellen, Abnehmer, Fahrzeuge, Pendelrouten)",
    w1.markers.basin === w1.basins && w1.markers.src >= 1 && w1.markers.cons >= 1 && w1.markers.veh >= 1 && w1.charts === w1.basins,
    JSON.stringify(w1.markers) + `, ${w1.charts} Diagramme`);
  check("Wasser: ungeprüfte Entnahmestellen (OSM) gekennzeichnet",
    w1.unverified >= 1 && (await pg.locator("#map .wsrc.unverified").count()) >= 1 && /ungeprüft/.test(await pg.locator("#w-srctable").innerText()),
    `${w1.unverified} von ${w1.sources} ungeprüft`);
  check("Wasser: Becken ohne Abnehmer werden als Reservestandort gekennzeichnet, nicht eingeplant",
    await pg.evaluate(() => {
      const r = window.__wb.water().result;
      const bad = r.plan.basins.filter((b) => (b.demandLpm === 0) !== !!b.reserve);
      const planned = r.plan.basins.filter((b) => b.reserve && (b.shuttleTarget || b.supply.kind !== "keine"));
      const tagged = [...document.querySelectorAll("#wasser-panel .w-basinhead")].filter((e) => /Reservestandort/.test(e.innerText)).length;
      return bad.length === 0 && planned.length === 0 && tagged === r.plan.basins.filter((b) => b.reserve).length;
    }), w1.reserve.length ? `Reservestandorte: ${w1.reserve.join(", ")}` : "in dieser Lage kein Becken ohne Abnehmer");

  // 3) Zeitregler: Fahrzeuge und Füllstände bewegen sich
  const snap = () => pg.evaluate(() => ({
    clock: document.getElementById("w-clock").textContent,
    veh: [...document.querySelectorAll("#map .leaflet-marker-icon")].filter((e) => e.querySelector(".wveh")).map((e) => e.style.transform),
    fills: [...document.querySelectorAll("#map .wbasin .fill")].map((e) => e.style.height),
    states: [...document.querySelectorAll("#map .wveh")].map((e) => e.className),
  }));
  await pg.evaluate(() => window.__wb.water().setTime(60));
  const sA = await snap();
  await pg.evaluate(() => window.__wb.water().setTime(180));
  const sB = await snap();
  check("Wasser: Zeitregler bewegt Fahrzeuge und ändert Füllstände (Uhr 1:00 h -> 3:00 h)",
    sA.clock === "1:00 h" && sB.clock === "3:00 h" && JSON.stringify(sA.veh) !== JSON.stringify(sB.veh) && JSON.stringify(sA.fills) !== JSON.stringify(sB.fills) && new Set([...sA.states, ...sB.states]).size > 1,
    `${sA.veh.length} Fahrzeugmarker, Füllstände ${sA.fills.join("/")} -> ${sB.fills.join("/")}`);
  // Abspielen bei 60x und Pause
  await pg.evaluate(() => { const u = window.__wb.water(); u.setTime(100); u.setSpeed(60); u.play(); });
  await pg.waitForTimeout(2500);
  const tPlay = await pg.evaluate(() => Number(document.getElementById("w-clock").getAttribute("data-min")));
  await pg.evaluate(() => window.__wb.water().pause());
  await pg.waitForTimeout(700);
  const tPause = await pg.evaluate(() => Number(document.getElementById("w-clock").getAttribute("data-min")));
  await pg.waitForTimeout(600);
  const tPause2 = await pg.evaluate(() => Number(document.getElementById("w-clock").getAttribute("data-min")));
  check("Wasser: Abspielen (60×) läuft, Pause hält an", tPlay > 100 && tPause === tPause2, `nach 2,5 s bei ${tPlay} min, nach Pause konstant ${tPause} min`);

  // 4) Ausschlüsse: Pflichtfahrzeuge, Grundschutz, eigene Kommune, Abnehmer selbst
  const ex = await pg.evaluate(() => {
    const r = window.__wb.water().result, s = window.__wb.state;
    const byId = new Map(r.plan.excluded.map((e) => [e.id, e.reason]));
    const gs = s.sug.grundschutz.filter((a) => a.vehicle).map((a) => a.vehicle.id);
    const planned = r.plan.vehicles.filter((v) => v.role !== "reserve").map((v) => v.id);
    const nks = s.vehicles.filter((v) => v.kommune === "Neunkirchen-Seelscheid").map((v) => v.id);
    return {
      pflicht: s.sug.dispatch.pflicht, gs, n: r.plan.excluded.length,
      pflichtReasons: s.sug.dispatch.pflicht.map((id) => byId.get(id) || null),
      gsReasons: gs.map((id) => byId.get(id) || null),
      nksAll: nks.every((id) => byId.has(id)), nksN: nks.length,
      consumerIds: r.plan.consumers.map((c) => c.id),
      consumerExcluded: r.plan.consumers.every((c) => byId.has(c.id)),
      inPlan: planned.filter((id) => [...s.sug.dispatch.pflicht, ...gs, ...nks].includes(id)),
      panel: document.getElementById("w-excluded").innerText.slice(0, 160),
    };
  });
  check("Wasser: Pflicht-, Grundschutz- und Neunkirchen-Seelscheider Fahrzeuge sind ausgeschlossen und begründet",
    ex.pflichtReasons.every((t) => t && /Pflichtfahrzeug|eigenen Kommune/.test(t)) &&
    ex.gsReasons.every((t) => t && /Grundschutz|eigenen Kommune/.test(t)) &&
    ex.nksAll && ex.consumerExcluded && ex.inPlan.length === 0 && /nicht für die Wasserversorgung/.test(ex.panel),
    `${ex.n} ausgeschlossen (Pflicht ${ex.pflicht.join(", ")}, Grundschutz ${ex.gs.join(", ")}, ${ex.nksN} Fahrzeuge der eigenen Kommune), Abnehmer ${ex.consumerIds.length} nicht doppelt verplant`);

  // 5) Becken verschieben rechnet neu und wird protokolliert
  const mv = await pg.evaluate(() => {
    const ui = window.__wb.water();
    const b0 = ui.result.plan.basins[0];
    const before = { id: b0.id, lat: b0.lat, lon: b0.lon, unmet: ui.result.sim.kpi.unmetLpm, cov: ui.result.sim.kpi.coveragePct };
    const t0 = performance.now();
    ui.moveBasin(b0.id, b0.lat - 0.0040, b0.lon - 0.0055); // ca. 550 m nach Südwesten
    const ms = performance.now() - t0;
    const r2 = ui.result, b1 = r2.plan.basins.find((x) => x.id === before.id);
    const pe = Protocol.all().filter((e) => e.typ === "wasser_becken").pop();
    return { before, after: { lat: b1.lat, manual: b1.manual, unmet: r2.sim.kpi.unmetLpm, cov: r2.sim.kpi.coveragePct, calc: r2.ms }, ms,
      proto: pe ? pe.daten : null, verify: Protocol.verify().ok, plans: Protocol.all().filter((e) => e.typ === "wasser_plan").length };
  });
  check("Wasser: Becken verschieben rechnet neu (manuell markiert, Protokolleintrag, Kette intakt)",
    Math.abs(mv.after.lat - mv.before.lat) > 1e-4 && mv.after.manual === true && mv.after.calc < 2000 && mv.verify &&
    mv.proto && mv.proto.aktion === "verschoben" && mv.proto.id === mv.before.id && mv.proto.defizit_nachher_lpm === Math.round(mv.after.unmet),
    `Deckung ${mv.before.cov.toFixed(0)} % -> ${mv.after.cov.toFixed(0)} %, Defizit ${Math.round(mv.before.unmet)} -> ${Math.round(mv.after.unmet)} l/min, Neuberechnung ${mv.after.calc.toFixed(0)} ms, ${mv.plans} Protokolleinträge wasser_plan`);
  // Becken hinzufügen/löschen
  const ad = await pg.evaluate(() => {
    const ui = window.__wb.water();
    const n0 = ui.result.plan.basins.length, b = ui.result.plan.basins[0];
    ui.addBasin(b.lat + 0.0012, b.lon + 0.0016);
    const n1 = ui.result.plan.basins.length;
    const last = ui.result.plan.basins[ui.result.plan.basins.length - 1];
    ui.deleteBasin(last.id);
    return { n0, n1, n2: ui.result.plan.basins.length, ok: !!ui.result.sim };
  });
  check("Wasser: Becken hinzufügen und löschen bleibt rechenbar", ad.n1 === ad.n0 + 1 && ad.n2 === ad.n0 && ad.ok, JSON.stringify(ad));
  await pg.evaluate(() => window.__wb.water().setInput(window.__wb.waterInput())); // wieder automatische Becken

  // 6) Protokoll und GeoJSON-Export
  const px = await pg.evaluate(() => {
    const types = Protocol.all().map((e) => e.typ);
    const plan = Protocol.all().filter((e) => e.typ === "wasser_plan").pop();
    const ann = Protocol.all().find((e) => e.typ === "wasser_annahmen");
    return { annahmen: !!ann, annText: ann ? JSON.stringify(ann.daten).slice(0, 120) : "", plan: plan ? plan.daten : null,
      size: plan ? JSON.stringify(plan.daten).length : 0, verify: Protocol.verify(), types: [...new Set(types)].filter((t) => t.startsWith("wasser")) };
  });
  check("Wasser: Protokoll mit wasser_annahmen und wasser_plan (Kennzahlen, Diagnose), Kette intakt",
    px.annahmen && px.plan && px.plan.bedarf_lpm > 0 && px.plan.diagnose.length >= 1 && typeof px.plan.deckung_pct === "number" && px.verify.ok && px.size < 12000,
    `${px.types.join(", ")}; Eintrag ${px.size} Byte; ${px.verify.count} Einträge`);
  await pg.click("#tab-protokoll");
  await pg.click("#btn-geojson");
  const gjw = JSON.parse(await pg.locator("#exp-text").inputValue());
  const byTyp = (t) => gjw.features.filter((f) => f.properties.typ === t);
  const srcF = byTyp("entnahmestelle");
  check("Wasser: GeoJSON-Export mit Pufferbecken, Abnehmern, Pendelrouten und eingestuften Entnahmestellen",
    byTyp("pufferbecken").length >= 1 && byTyp("wasserabnehmer").length >= 1 &&
    (byTyp("pendelroute").length + byTyp("schlauchleitung").length) >= 1 &&
    byTyp("pendelroute").every((f) => /LUFTLINIE/.test(f.properties.geometrie)) &&
    srcF.every((f) => "ergiebigkeit_lpm" in f.properties && "grundlage" in f.properties),
    `${byTyp("pufferbecken").length} Becken, ${byTyp("wasserabnehmer").length} Abnehmer, ${byTyp("pendelroute").length} Pendelrouten, ${byTyp("schlauchleitung").length} Schlauchleitungen, ${srcF.length} Entnahmestellen`);
  await pg.click("#btn-exp-close");
  await pg.click("#tab-wasser");

  // 7) Keine überlappenden Beschriftungen: entzerrte Label weichen den Wassermarkern aus
  await pg.evaluate(() => {
    const s = window.__wb.state, r = window.__wb.water().result, p = [...s.poly];
    for (const l of s.sug.lines) p.push(...l.latlngs);
    for (const v of s.sug.vehicles) p.push([v.lat, v.lon]);
    for (const b of r.plan.basins) p.push([b.lat, b.lon]);
    for (const x of r.plan.sources) p.push([x.lat, x.lon]);
    window.__wb.map.fitBounds(L.latLngBounds(p).pad(0.15), { animate: false });
  });
  await pg.waitForTimeout(1200);
  const ovW = await pg.evaluate(() => {
    const rect = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2);
    const labels = rect("#map .veh-marker,#map .veh-group,#map .line-label,#map .ready-label,#map .hz-label");
    const fixed = rect("#map .wbasin,#map .wsrc,#map .wcons,#map .water-marker,#map .vx-marker");
    const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    let n = 0;
    for (const a of labels) for (const b of fixed) if (hit(a, b)) n++;
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (hit(labels[i], labels[j])) n++;
    return { labels: labels.length, fixed: fixed.length, overlaps: n };
  });
  check("Wasser: Kartenbeschriftungen überdecken die Wassermarker (Becken, Entnahmestellen, Abnehmer) nicht",
    ovW.overlaps === 0, `${ovW.labels} Label, ${ovW.fixed} Wasser-/Festmarker, ${ovW.overlaps} Überdeckungen`);

  // 8) Screenshot aus der echten App (nicht aus der Demo)
  await pg.evaluate(() => { window.__wb.water().setTime(150); });
  await pg.evaluate(() => {
    document.querySelector(".panel").scrollTop = 0; // Pflichthinweis des Moduls im Bild lassen
    document.querySelector("#legend").style.visibility = "hidden";
    document.querySelector(".maptools").style.visibility = "hidden";
    const cap = document.createElement("div");
    cap.className = "maphint"; cap.style.top = "12px"; cap.style.bottom = "auto"; cap.style.left = "12px"; cap.style.zIndex = "900";
    cap.textContent = "Test-Lage (hügeliges Gelände, synthetische OSM-Daten: Hydrant und Teich erfunden), Beispielwetter Wind 12 km/h aus SW; Zeitpunkt 2:30 h – Becken mit Füllstand, Pendelrouten (Luftlinien), Fahrzeuge im Zeitverlauf";
    document.querySelector(".mapwrap").appendChild(cap);
  });
  await pg.waitForTimeout(900);
  await pg.screenshot({ path: path.join(OUT, "screenshot-wasser.png") });
  check("Wasser: Screenshot docs/screenshot-wasser.png (deviceScaleFactor 2) erstellt", fs.existsSync(path.join(OUT, "screenshot-wasser.png")));

  // 9) Tablet-Hochformat: keine Querscrollung, große Bedienelemente
  await pg.setViewportSize({ width: 834, height: 1112 });
  await pg.waitForTimeout(600);
  const tab = await pg.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    play: document.getElementById("w-play").getBoundingClientRect().height,
    add: document.getElementById("w-add").getBoundingClientRect().height,
  }));
  check("Wasser: Tablet-Hochformat ohne horizontales Scrollen, Bedienelemente ≥ 44 px",
    tab.overflow <= 1 && tab.play >= 44 && tab.add >= 44, `Überhang ${tab.overflow} px, Start-Taste ${tab.play.toFixed(0)} px, „Becken hinzufügen“ ${tab.add.toFixed(0)} px`);
  await c2.close();
} catch (e) {
  check("Testablauf Wasserversorgung", false, e.message);
}

// Wasserversorgung OHNE OSM-Daten (wie beim Nutzer, wenn Overpass nicht erreichbar): klarer Hinweis,
// KEINE erfundenen Entnahmestellen, Modul rechnet trotzdem (Becken ohne Versorgung).
try {
  const pg = await newPage();
  await ack(pg);
  await pg.evaluate(() => window.__wb.demReady());
  await pg.waitForFunction(() => !!window.__wb.grenzenReady(), null, { timeout: 15000 });
  const lat0 = 50.8705, lon0 = 7.3120, r = 60;
  const pts = Array.from({ length: 12 }, (_, k) => [lat0 + (r / 111195) * Math.cos((k / 12) * 2 * Math.PI), lon0 + (r / (111195 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin((k / 12) * 2 * Math.PI)]);
  await pg.evaluate((p) => window.__wb.setPolygon(p), pts);
  await pg.click("#btn-wx-sample");
  await pg.click("#wx-override summary");
  for (const [k, v] of [["windKmh", "12"], ["windDirDeg", "225"], ["tempC", "27"], ["rh", "30"]]) { await pg.fill(`#ov-${k}`, v); await pg.locator(`#ov-${k}`).dispatchEvent("change"); }
  await pg.selectOption("#sel-fuel", "mischwald");
  await pg.click("#btn-run");
  await pg.waitForFunction(() => document.querySelector("#suggestions")?.innerText.length > 0, null, { timeout: 60000 });
  await pg.click("#tab-wasser");
  await pg.waitForTimeout(400);
  const noOsm = await pg.evaluate(() => {
    const ui = window.__wb.water(), r = ui && ui.result;
    return {
      hint: document.getElementById("wasser-hinweis").innerText.replace(/\s+/g, " "),
      srcMarkers: document.querySelectorAll("#map .wsrc").length,
      sources: r ? r.plan.sources.length : null, basins: r ? r.plan.basins.length : null,
      warn: r ? r.plan.warnings.concat(r.sim.diagnosis.map((d) => d.text)) : [],
      pendel: r ? r.plan.vehicles.filter((v) => v.role === "pendel").length : null,
      siteNotes: r ? [...new Set(r.plan.basins.map((b) => b.siteNote))] : [],
    };
  });
  check("Wasser ohne OSM-Daten: klarer Hinweis, keine erfundenen Entnahmestellen, Befahrbarkeit ungeprüft",
    /Keine OSM-Daten geladen/.test(noOsm.hint) && /keine Entnahmestellen angenommen/.test(noOsm.hint) &&
    noOsm.sources === 0 && noOsm.srcMarkers === 0 && noOsm.pendel === 0 && noOsm.basins >= 1 &&
    noOsm.warn.some((t) => /Keine Entnahmestelle/.test(t)) && noOsm.siteNotes.some((t) => /Befahrbarkeit nicht geprüft/.test(t)),
    `${noOsm.basins} Becken, ${noOsm.sources} Entnahmestellen, Warnung: ${(noOsm.warn.find((t) => /Keine Entnahmestelle/.test(t)) || "").slice(0, 90)}`);
  // Entnahmestelle von Hand setzen -> Plan rechnet damit (Degradation ist behebbar)
  const manual = await pg.evaluate(() => {
    const s = window.__wb.state;
    const c = s.poly.reduce((a, p) => [a[0] + p[0] / s.poly.length, a[1] + p[1] / s.poly.length], [0, 0]);
    s.manualWater.push({ id: "manuell/test", lat: c[0] - 0.012, lon: c[1] - 0.010, kind: "manuell erfasst", source: "manuell", verified: true });
    window.__wb.water().setInput(window.__wb.waterInput());
    const r = window.__wb.water().result;
    return { sources: r.plan.sources.length, typ: r.plan.sources[0].typ, cap: r.plan.sources[0].capLpm, why: r.plan.sources[0].capWhy, pendel: r.plan.vehicles.filter((v) => v.role === "pendel").length };
  });
  check("Wasser ohne OSM: von Hand erfasste Entnahmestelle wird als Annahme eingestuft und versorgt den Plan",
    manual.sources === 1 && manual.cap > 0 && /ANNAHME/.test(manual.why) && manual.pendel >= 1,
    `${manual.typ}, ${manual.cap} l/min (${manual.why}), ${manual.pendel} Pendelfahrzeug(e)`);
  await pg.context().close();
} catch (e) {
  check("Testablauf Wasser ohne OSM", false, e.message);
}

const explainable = consoleErrors.filter((t) => /ERR_BLOCKED_BY_CLIENT|Failed to load resource|net::ERR/.test(t));
const other = consoleErrors.filter((t) => !explainable.includes(t));
check("Keine Konsolenfehler außer blockierten externen Abrufen", other.length === 0, other.slice(0, 3).join(" | "));
console.log(`Blockierte externe Hosts im Test: ${[...blocked].join(", ") || "keine"}`);
console.log(`Erklärbare Netzwerkfehler in der Konsole: ${explainable.length}`);
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
process.exit(failed.length ? 1 : 0);
