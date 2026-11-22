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

// GitHub-Pages-Simulation: Projekt unter Unterpfad /waldbrand-app/ (alle Pfade relativ, kein Abruf außerhalb)
try {
  const PREFIX = "/waldbrand-app/";
  const outside = [], notFound = [];
  const sub = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
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
