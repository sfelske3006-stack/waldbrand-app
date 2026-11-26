/*
 * Tests für das Modul "Safe Areas und Fluchtwege".
 * Start:  node --test tests/safearea.test.mjs
 * (Im Repository später: node --test tests/model.test.mjs tests/search.test.mjs tests/safearea.test.mjs)
 *
 * Die Tests prüfen Plausibilität und Verhalten, NICHT die fachliche Richtigkeit der Zahlen:
 * die Parameter sind Annahmen (siehe ASSUMPTIONS.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Kern der App: im Repository "../js/", in diesem Arbeitsordner die Kopien unter "../repo-js/"
const APP = fs.existsSync(path.join(here, "../repo-js/params.js")) ? "../repo-js/" : "../js/";
const P = require(APP + "params.js");
const Grid = (globalThis.Grid = require(APP + "grid.js"));
globalThis.TerrainWind = require(APP + "terrain.js");
const FireModel = (globalThis.FireModel = require(APP + "model.js"));
globalThis.Contour = require(APP + "contour.js");
const Osm = require(APP + "osm.js");
const SA = require("../js/safearea.js");
const Demo = require("./safearea-scenario.cjs");

const CL = Object.keys(P.fuelClasses);
const WX = (windKmh = 20) => [{ t: 0, windKmh, windDirDeg: 225, tempC: 30, rh: 28, rain24: 0, rain72: 0 }];

/** Kleines Testraster mit einer rechteckigen Freifläche in einem Brennstoff. */
function makeTestGrid(opt = {}) {
  const halfSizeM = opt.halfSizeM ?? 500, cellM = opt.cellM ?? 25;
  const g = Grid.makeGrid(50.8, 7.3, halfSizeM, cellM, CL);
  g.fuel.fill(CL.indexOf(opt.background ?? "gebuesch"));
  if (opt.slopeTan) {
    const elev = new Float32Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const y = g.y0 + (j + 0.5) * cellM;
      elev[j * g.nx + i] = 200 + opt.slopeTan * y; // steigt nach Norden
    }
    g.elev = elev; g.elevMissing = 0; Grid.terrain(g);
  }
  return g;
}
/** Setzt ein Rechteck (in Metern um den Mittelpunkt) auf eine Brennstoffklasse. */
function fillRect(g, cls, x0, y0, x1, y1) {
  const v = CL.indexOf(cls);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) g.fuel[j * g.nx + i] = v;
  }
}
/** Ergebnisobjekt wie runEnsemble, aber ohne Rechnung: Front erreicht nichts (Infinity). */
function emptyResult(g, fill = Infinity) {
  const n = g.nx * g.ny;
  return {
    horizons: P.horizonsH, runs: 1,
    tPossible: new Float32Array(n).fill(fill),
    tLikely: new Float32Array(n).fill(fill),
    earliest: new Float32Array(n).fill(fill),
    counts: P.horizonsH.map(() => new Uint16Array(n)),
  };
}

// --------------------------------------------------------------------- Flammenlänge
test("Flammenlänge: aus Rothermel ableitbar, plausibel und monoton im Wind", () => {
  let prev = -1;
  for (const w of [0, 10, 20, 30, 40]) {
    const f = SA.flameForClass("gruenland", WX(w), P);
    assert.ok(f && f.flameM > 0, `Wind ${w}: keine Flammenlänge`);
    assert.ok(f.flameM > prev, `Wind ${w}: nicht monoton (${f.flameM} <= ${prev})`);
    prev = f.flameM;
  }
  // Größenordnung: Grasfeuer bei 20 km/h deutlich unter 5 m, über 0,3 m
  const g20 = SA.flameForClass("gruenland", WX(20), P).flameM;
  assert.ok(g20 > 0.3 && g20 < 5, `Grünland 20 km/h: ${g20} m`);
  // Laubstreu im Wald (WAF 0,2) brennt deutlich niedriger als offenes Gras
  assert.ok(SA.flameForClass("laubwald", WX(20), P).flameM < g20);
});

test("Flammenlänge: Byram-Beziehung wird exakt angewandt (L = 0,0775 * I^0,46)", () => {
  const f = SA.flameForClass("gruenland", WX(25), P);
  const soll = 0.0775 * Math.pow(f.intensityKwM, 0.46);
  assert.ok(Math.abs(f.flameM - soll) < 1e-9, `${f.flameM} vs ${soll}`);
});

test("sigma aus rothermel().B ist die exakte Umkehrung (kein zweiter Brennstoffcode nötig)", () => {
  const M = { d1: 0.08, d10: 0.09, d100: 0.1, lh: 0.9, lw: 1.2 };
  for (const m of Object.keys(P.fuelModels)) {
    const r = FireModel.rothermel(P.fuelModels[m], M, 300, 0, P.tonPerAcreToLbFt2);
    const sigma = SA.sigmaFromRothermel(r);
    assert.ok(Math.abs(0.02526 * Math.pow(sigma, 0.54) - r.B) < 1e-9, `FM${m}`);
  }
});

// --------------------------------------------------------------------- Mindestgröße
test("Mindestgröße: Soll-Radius wächst linear mit der Flammenlänge (Faktor 4, Butler & Cohen 1998)", () => {
  const a = SA.requiredRadius(4, 0, 0, { persons: 0, vehicles: 0 }, P);
  const b = SA.requiredRadius(8, 0, 0, { persons: 0, vehicles: 0 }, P);
  assert.equal(a.ssdM, 16);
  assert.equal(b.ssdM, 32);
  assert.equal(b.ssdM / a.ssdM, 2);
});

test("Mindestgröße: nie unter dem Mindestabstand (Butler & Cohen 1998: > 20 m breit)", () => {
  const r = SA.requiredRadius(0.2, 0, 0, { persons: 0, vehicles: 0 }, P);
  assert.equal(r.ssdM, SA.DEFAULTS.minSsdM);
  assert.ok(r.limitedByMin);
});

test("Mindestgröße: Zuschlag für Personal und Fahrzeuge wirkt", () => {
  const ohne = SA.requiredRadius(3, 0, 0, { persons: 0, vehicles: 0 }, P).radiusM;
  const mit = SA.requiredRadius(3, 0, 0, { persons: 20, vehicles: 2 }, P).radiusM;
  assert.ok(mit > ohne);
  assert.ok(Math.abs(mit - ohne - (SA.DEFAULTS.addPer20PersonsM + 2 * SA.DEFAULTS.addPerVehicleM)) < 1e-9);
});

// --------------------------------------------------------------------- Hang- und Windzuschlag
test("Hangzuschlag: bergauf größerer Soll-Radius, bergab kein Abschlag", () => {
  const eben = SA.requiredRadius(2, 0, 0, {}, P).ssdM;
  const bergauf = SA.requiredRadius(2, 0.3, 0, {}, P).ssdM;
  const bergab = SA.requiredRadius(2, -0.3, 0, {}, P).ssdM;
  assert.ok(bergauf > eben, `${bergauf} <= ${eben}`);
  assert.equal(bergab, eben, "bergab darf nicht kleiner werden als eben");
});

test("Windzuschlag: mehr Wind -> größerer Soll-Radius, Δ gedeckelt bei 10", () => {
  const a = SA.deltaFactor(0, 0).delta, b = SA.deltaFactor(0, 30).delta, c = SA.deltaFactor(1.0, 200).delta;
  assert.equal(a, 1);
  assert.ok(b > a);
  assert.equal(c, SA.DEFAULTS.deltaMax);
});

test("Hang/Wind: Stützstellen der Annahme werden reproduziert (20 % Hang + 10 mph -> Δ = 4)", () => {
  const d = SA.deltaFactor(0.2, 16.09344);
  assert.ok(Math.abs(d.delta - 4) < 1e-6, `Δ = ${d.delta}`);
  // über 40 % Hang: laut USFS-Zusammenfassung 6- bis 10-fach
  const steil = SA.deltaFactor(0.4, 16.09344).delta;
  assert.ok(steil >= 6 && steil <= 10, `Δ(40 %) = ${steil}`);
});

// --------------------------------------------------------------------- Flächenbewertung
test("Zu kleine Fläche wird abgelehnt, ausreichend große angenommen", () => {
  // Gebüsch ringsum, darin ein kleiner und ein großer Parkplatz (Zusatzfläche ohne Brandlast)
  const g = makeTestGrid({ background: "gruenland" });
  const extra = new Uint8Array(g.nx * g.ny);
  const mark = (x0, y0, x1, y1) => {
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) extra[j * g.nx + i] = 2; // 2 = Parkplatz
    }
  };
  mark(-400, -400, -340, -340);  // 2 x 2 Zellen = 50 x 50 m -> freier Radius ca. 12 m
  mark(100, 100, 400, 400);      // 12 x 12 Zellen = 300 x 300 m -> freier Radius ca. 138 m
  const res = SA.findAreas({ grid: g, result: emptyResult(g), osm: { drivable: null }, ignition: [], weatherHours: WX(40), P, extra });
  const klein = res.areas.find((a) => a.areaHa < 1);
  const gross = res.areas.find((a) => a.areaHa > 5);
  assert.ok(klein && gross, `gefunden: ${res.areas.map((a) => a.areaHa.toFixed(2)).join(", ")}`);
  assert.equal(klein.status, "ungeeignet");
  assert.ok(klein.inscribedRM < klein.requiredRM);
  assert.match(klein.reason, /[Zz]u klein/);
  assert.equal(gross.status, "geeignet");
  assert.ok(gross.inscribedRM >= gross.requiredRM);
});

test("Fläche mit eigener Brandlast (Acker/Wiese) wird höchstens „bedingt geeignet“", () => {
  const g = makeTestGrid();
  fillRect(g, "acker", 0, 0, 480, 480);
  const res = SA.findAreas({ grid: g, result: emptyResult(g), osm: { drivable: null }, ignition: [], weatherHours: WX(20), P });
  const acker = res.areas.find((a) => a.type === "acker");
  assert.ok(acker, "Ackerfläche nicht gefunden");
  assert.ok(acker.inscribedRM > acker.requiredRM, "Testfläche sollte groß genug sein");
  assert.equal(acker.status, "bedingt");
  assert.match(acker.reason, /abgeerntet/);
});

test("Randbrennstoff bestimmt den Soll-Radius (Wald am Rand -> andere Flammenlänge als Gras)", () => {
  const mk = (rand) => {
    const g = makeTestGrid({ background: rand });
    const extra = new Uint8Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell;
      if (Math.abs(x) < 200 && Math.abs(y) < 200) extra[j * g.nx + i] = 1; // Steinbruch
    }
    return SA.findAreas({ grid: g, result: emptyResult(g), osm: { drivable: null }, ignition: [], weatherHours: WX(25), P, extra })
      .areas.find((a) => a.type === "steinbruch");
  };
  const gras = mk("gruenland"), wald = mk("laubwald");
  assert.ok(gras && wald);
  assert.ok(gras.flameM > wald.flameM, `${gras.flameM} <= ${wald.flameM}`);
  assert.ok(gras.requiredRM > wald.requiredRM);
  assert.equal(gras.edgeClass, "gruenland");
  assert.equal(wald.edgeClass, "laubwald");
});

// --------------------------------------------------------------------- Fluchtwege
test("Fluchtzeit: bergauf länger als bergab (gleiche Entfernung)", () => {
  // Fläche in der Mitte, Gelände steigt nach Norden: Standort südlich flieht bergauf,
  // Standort nördlich flieht bergab.
  const g = makeTestGrid({ halfSizeM: 800, slopeTan: 0.25 });
  const extra = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell;
    if (Math.abs(x) < 150 && Math.abs(y) < 150) extra[j * g.nx + i] = 1; // Steinbruch als Ziel
  }
  const base = { grid: g, result: emptyResult(g), osm: { drivable: null }, ignition: [], weatherHours: WX(10), P, extra };
  const found = SA.findAreas(base);
  const south = g.proj.toLatLng(0, -600), north = g.proj.toLatLng(0, 600);
  const er = SA.escapeRoutes({
    grid: g, osm: null, areas: found.areas, P,
    positions: [{ id: "sued", lat: south[0], lon: south[1] }, { id: "nord", lat: north[0], lon: north[1] }],
  });
  const bergauf = er.routes.find((r) => r.positionId === "sued").fuss;
  const bergab = er.routes.find((r) => r.positionId === "nord").fuss;
  assert.ok(bergauf && bergab, "keine Fußwege gefunden");
  assert.ok(Math.abs(bergauf.lengthM - bergab.lengthM) < 60, `Strecken zu unterschiedlich: ${bergauf.lengthM} / ${bergab.lengthM}`);
  assert.ok(bergauf.timeMin > bergab.timeMin, `bergauf ${bergauf.timeMin} min, bergab ${bergab.timeMin} min`);
  assert.ok(bergauf.ascentM > 50 && bergab.ascentM < 5, `Anstieg ${bergauf.ascentM} / ${bergab.ascentM}`);
});

test("Tobler-Funktion: 5 km/h eben, Maximum bei leichtem Gefälle, langsamer bergauf", () => {
  assert.ok(Math.abs(SA.toblerKmh(0) - 5.0) < 0.05, SA.toblerKmh(0));
  assert.ok(SA.toblerKmh(-0.05) > SA.toblerKmh(0));
  assert.ok(SA.toblerKmh(0.3) < SA.toblerKmh(0));
});

test("Fluchtweg: Fahrzeug nutzt Straße und ist schneller als zu Fuß", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4 });
  const res = SA.plan({ ...sc, P });
  const mitBeiden = res.routes.filter((r) => r.fahrzeug && r.fuss && !r.fahrzeug.atArea && r.fahrzeug.lengthM > 300);
  assert.ok(mitBeiden.length > 0, "kein Standort mit Fahrzeug- und Fußweg");
  for (const r of mitBeiden) {
    assert.ok(r.fahrzeug.timeMin < r.fuss.timeMin + 1e-9 || r.fahrzeug.lengthM > r.fuss.lengthM * 2,
      `${r.positionId}: Fahrzeug ${r.fahrzeug.timeMin} min / ${r.fahrzeug.lengthM} m, Fuß ${r.fuss.timeMin} min / ${r.fuss.lengthM} m`);
  }
});

// --------------------------------------------------------------------- Warnung
test("Warnung: zu knappe Zeit wird als kritisch gemeldet, ausreichende als ok", () => {
  const g = makeTestGrid({ halfSizeM: 800 });
  const extra = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell;
    if (Math.abs(x) < 150 && Math.abs(y) < 150) extra[j * g.nx + i] = 1;
  }
  const mk = (frontMin) => {
    const result = emptyResult(g, frontMin);
    const found = SA.findAreas({ grid: g, result, osm: { drivable: null }, ignition: [], weatherHours: WX(10), P, extra });
    const [la, lo] = g.proj.toLatLng(0, -600);
    const er = SA.escapeRoutes({ grid: g, osm: null, areas: found.areas, P, positions: [{ id: "x", lat: la, lon: lo, label: "Testfahrzeug" }] });
    return SA.checkRoutes({ grid: g, result, routes: er.routes, P })[0];
  };
  const eng = mk(5), weit = mk(600);
  assert.equal(eng.status, "kritisch");
  assert.match(eng.text, /WARNUNG/);
  assert.ok(eng.reserveMin < 0);
  assert.equal(weit.status, "ok");
  assert.ok(weit.reserveMin > 0);
  // Grenzfall „knapp“: Reserve zwischen 0 und warnReserveMin
  const grenz = mk(Math.ceil(eng.escapeMin + SA.DEFAULTS.bufferMin + 3));
  assert.equal(grenz.status, "knapp");
});

test("Warnung: Fluchtzeit + Puffer wird korrekt gegen die „möglich“-Front gerechnet", () => {
  const g = makeTestGrid({ halfSizeM: 400 });
  const result = emptyResult(g, 40);
  const [la, lo] = g.proj.toLatLng(0, 0);
  const routes = [{ positionId: "v", lat: la, lon: lo, label: "V", fahrzeug: { mode: "fahrzeug", timeMin: 12, areaId: "a", atArea: false }, fuss: null }];
  const w = SA.checkRoutes({ grid: g, result, routes, P })[0];
  assert.equal(w.frontMin, 40);
  assert.equal(w.escapeMin, 12);
  assert.equal(w.bufferMin, SA.DEFAULTS.bufferMin);
  assert.equal(w.reserveMin, 40 - 12 - SA.DEFAULTS.bufferMin);
});

test("Warnung: ohne jeden Fluchtweg kritisch, nicht stillschweigend ok", () => {
  const g = makeTestGrid({ halfSizeM: 300 });
  const result = emptyResult(g, 30);
  const [la, lo] = g.proj.toLatLng(0, 0);
  const w = SA.checkRoutes({ grid: g, result, routes: [{ positionId: "v", lat: la, lon: lo, label: "V", fahrzeug: null, fuss: null }], P })[0];
  assert.equal(w.status, "kritisch");
  assert.match(w.text, /Kein Fluchtweg/);
  assert.match(w.text, /LACES/);
});

// --------------------------------------------------------------------- Ohne OSM-Daten
test("Ohne OSM-Daten: deutlicher Hinweis, keine erfundenen Flächen", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4, osm: false, extra: false });
  assert.equal(sc.osm, null);
  const res = SA.plan({ ...sc, P });
  assert.ok(res.notes.some((n) => /Keine OSM-Daten/.test(n) && /KEINE Flächen erfunden/.test(n)), res.notes.join(" | "));
  // Es dürfen nur Flächen auftauchen, die aus den Eingaben der Einsatzleitung folgen
  for (const a of res.areas) {
    assert.equal(a.type, "abgebrannt", `unerwarteter Flächentyp ohne OSM: ${a.type}`);
    assert.match(a.source, /Brandfläche der Einsatzleitung/);
  }
  assert.ok(res.notes.some((n) => /Befahrbarkeit|OSM/.test(n)));
});

test("Ohne OSM und ohne Brandfläche: gar keine Fläche, aber ein Hinweis", () => {
  const g = makeTestGrid();
  const res = SA.findAreas({ grid: g, result: emptyResult(g), osm: null, ignition: [], weatherHours: WX(20), P });
  assert.equal(res.areas.length, 0);
  assert.ok(res.notes.some((n) => /Keine OSM-Daten/.test(n)));
  assert.ok(res.notes.some((n) => /Keine Rückzugsfläche aus den vorhandenen Daten ableitbar/.test(n)));
});

test("Ohne Geländemodell: Hangzuschlag entfällt und wird gemeldet", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4, dem: false });
  const res = SA.plan({ ...sc, P });
  assert.ok(res.notes.some((n) => /Kein Geländemodell/.test(n)), res.notes.join(" | "));
  for (const a of res.areas) assert.equal(a.deltaSlope, 1);
});

// --------------------------------------------------------------------- Determinismus und Laufzeit
test("Determinismus: zwei Läufe liefern identische Ergebnisse", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 6 });
  const strip = (r) => JSON.stringify(SA.forProtocol(r));
  const a = SA.plan({ ...sc, P });
  const b = SA.plan({ ...sc, P });
  assert.equal(strip(a), strip(b));
  // auch die Zellmengen und Wegpunkte müssen gleich sein
  assert.deepEqual([...a.areas[0].cells], [...b.areas[0].cells]);
  const ra = a.routes.find((r) => r.fahrzeug), rb = b.routes.find((r) => r.fahrzeug);
  assert.deepEqual(ra.fahrzeug.latlngs, rb.fahrzeug.latlngs);
});

test("Determinismus: dasselbe Szenario zweimal gebaut gibt dieselbe Planung", async () => {
  const mk = async () => {
    const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 6 });
    return JSON.stringify(SA.forProtocol(SA.plan({ ...sc, P })));
  };
  assert.equal(await mk(), await mk());
});

test("Verwerfen: verworfene Fläche bleibt sichtbar, wird aber kein Fluchtziel mehr", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4 });
  const base = SA.plan({ ...sc, P });
  const ziel = base.routes.map((r) => (r.fahrzeug || r.fuss || {}).areaId).find(Boolean);
  assert.ok(ziel, "kein Fluchtziel im Grundlauf");
  const nach = SA.plan({ ...sc, P, state: { dismissed: [ziel] } });
  assert.ok(nach.areas.some((a) => a.id === ziel && a.dismissed), "verworfene Fläche fehlt in der Liste");
  assert.ok(!nach.routes.some((r) => (r.fahrzeug || r.fuss || {}).areaId === ziel), "verworfene Fläche wird noch angesteuert");
});

test("Laufzeit: Planung auf dem vollen Rechengebiet (400 x 400 Zellen) unter 3 s", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4, halfSizeM: P.grid.halfSizeM, cellM: P.grid.cellM });
  assert.equal(sc.grid.nx, 400);
  const t0 = Date.now();
  const res = SA.plan({ ...sc, P });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `Planung dauerte ${ms} ms`);
  assert.ok(res.durationMs <= ms + 5);
  console.log(`    Laufzeit SafeArea.plan auf ${sc.grid.nx}x${sc.grid.ny} Zellen: ${ms} ms, ${res.areas.length} Flächen, ${res.routes.length} Fluchtwege`);
});

// --------------------------------------------------------------------- Protokoll / Export
test("Protokolldarstellung enthält Zahlen, Begründungen und Quellen", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4 });
  const p = SA.forProtocol(SA.plan({ ...sc, P }));
  assert.ok(p.flaechen.length > 0 && p.fluchtwege.length > 0 && p.warnungen.length > 0);
  const f = p.flaechen[0];
  for (const k of ["id", "typ", "status", "flaeche_ha", "freier_radius_m", "erforderlicher_radius_m", "flammenlaenge_m", "begruendung", "quelle"]) {
    assert.ok(k in f, `Feld ${k} fehlt`);
  }
  assert.ok(p.quellen.some((q) => /Butler/.test(q)) && p.quellen.some((q) => /Byram/.test(q)));
  assert.ok(JSON.stringify(p).length > 500);
});

test("Alle Flächen tragen eine Begründung in einem Satz und eine Quellenangabe", async () => {
  const sc = await Demo.build({ Grid, FireModel, Osm, SafeArea: SA, P }, { runs: 4 });
  for (const a of SA.plan({ ...sc, P }).areas) {
    assert.ok(a.reason && a.reason.length > 20, `${a.id}: keine Begründung`);
    assert.ok(/geeignet|bedingt|ungeeignet/.test(a.status));
    assert.ok(a.source && /OSM|Brandfläche/.test(a.source));
  }
});
