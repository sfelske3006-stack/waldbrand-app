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
  check("Fahrzeugliste geladen und gekennzeichnet", veh.includes("LF KatS") && veh.includes("Annahme: Normwert") && veh.includes("Website"));
  await page.click("#tab-lage");

  // Tablet hochkant
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "screenshot-tablet.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("Kein horizontales Scrollen (Tablet hochkant)", !overflow);
  const protoAll = await page.evaluate(() => JSON.stringify(Protocol.all()));
  check("Protokoll enthält DGM-Quelle/Stand", protoAll.includes("\"gelaende\"") && protoAll.includes("dl-de/zero-2-0") && protoAll.includes("max_tan_hang"));
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
