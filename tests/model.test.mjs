// Unit- und Szenariotests für den Berechnungskern. Start: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = require("../js/params.js");
const Grid = require("../js/grid.js");
globalThis.Grid = Grid;
const TW = require("../js/terrain.js");
globalThis.TerrainWind = TW;
const Dispatch = require("../js/dispatch.js");
globalThis.Dispatch = Dispatch;
const F = require("../js/model.js");
const Protocol = (() => { globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; return require("../js/protocol.js"); })();
const Suggest = require("../js/suggest.js");
const Dem = require("../js/dem.js");
const fs = require("node:fs");
const path = require("node:path");

const CL = Object.keys(P.fuelClasses);

// Synthetische Wachen-Koordinaten für Tests (KEINE echten Koordinaten): relativ zum Rasterursprung,
// LZ1 ca. 2,5 km südwestlich, LZ2 ca. 5 km westlich. Ids wie in data/fahrzeuge.json.
function testStations(g) {
  const at = (x, y) => g.proj.toLatLng(x, y);
  const [a1, o1] = at(-1800, -1800), [a2, o2] = at(-5000, 300);
  return [
    { id: "lz-nk", name: "Teststandort 1 (synthetisch)", kommune: "Testkommune A", lat: a1, lon: o1, typ: "FF" },
    { id: "lz-se", name: "Teststandort 2 (synthetisch)", kommune: "Testkommune B", lat: a2, lon: o2, typ: "FF" },
  ];
}
const TEST_WACHE = (g) => testStations(g).map((s) => ({ ...s }));

// Vergleichswerte: Anderson (1982), GTR INT-122, Tabelle der Ausbreitungsraten bei
// 8 % Tote-Brennstoff-Feuchte, 100 % Lebendfeuchte, 5 mi/h Wind in Flammenhöhe, eben (ch/h).
// HINWEIS: Werte aus Literaturkenntnis übernommen; Abgleich mit der Primärquelle ist offen.
const ANDERSON_REF = { 1: 78, 2: 35, 3: 104, 8: 1.6, 9: 7.5, 10: 7.9, 5: 18 };

test("Rothermel: Ausbreitungsraten nahe Anderson-Referenz (±25 %)", () => {
  for (const [m, ref] of Object.entries(ANDERSON_REF)) {
    const r = F.rothermel(P.fuelModels[m], { d1: 0.08, d10: 0.08, d100: 0.08, lh: 1, lw: 1 }, 5 * 88, 0, P.tonPerAcreToLbFt2);
    const chH = (r.R * 60) / 66;
    assert.ok(Math.abs(chH - ref) / ref <= 0.25, `FM${m}: ${chH.toFixed(1)} ch/h vs. ${ref}`);
  }
});

test("Rothermel: Feuchte über Extinktionsfeuchte -> keine Ausbreitung", () => {
  const r = F.rothermel(P.fuelModels[1], { d1: 0.15, d10: 0.15, d100: 0.15, lh: 1, lw: 1 }, 440, 0, P.tonPerAcreToLbFt2);
  assert.equal(r.R, 0);
});

test("Rothermel: mehr Wind -> schneller, Hang -> schneller", () => {
  const M = { d1: 0.06, d10: 0.07, d100: 0.08, lh: 1, lw: 1 };
  const a = F.rothermel(P.fuelModels[9], M, 0, 0, P.tonPerAcreToLbFt2).R;
  const b = F.rothermel(P.fuelModels[9], M, 300, 0, P.tonPerAcreToLbFt2).R;
  const c = F.rothermel(P.fuelModels[9], M, 0, 0.3, P.tonPerAcreToLbFt2).R;
  assert.ok(b > a && c > a);
});

test("Ellipse: L/B = 1 bei Windstille, steigt mit Wind, max. 8", () => {
  assert.ok(Math.abs(F.lengthToWidth(0) - 1) < 0.01);
  assert.ok(F.lengthToWidth(10) > F.lengthToWidth(5));
  assert.equal(F.lengthToWidth(100), 8);
});

test("Gleichgewichtsfeuchte plausibel (trocken < feucht)", () => {
  assert.ok(F.equilibriumMoisture(30, 20) < F.equilibriumMoisture(15, 80));
});

function synthGrid(cls = "gruenland") {
  const g = Grid.makeGrid(50.85, 7.33, 1500, 25, CL);
  g.fuel.fill(CL.indexOf(cls));
  return g;
}
const center = (g) => Int32Array.from([Math.floor(g.ny / 2) * g.nx + Math.floor(g.nx / 2)]);
const wx = (n, o) => Array.from({ length: n }, () => ({ windKmh: 15, windDirDeg: 270, tempC: 25, rh: 35, rain24: 0, rain72: 0, ...o }));

function extent(g, arr, T) {
  let minI = 1e9, maxI = -1, minJ = 1e9, maxJ = -1;
  for (let k = 0; k < arr.length; k++) if (arr[k] <= T) {
    const i = k % g.nx, j = (k - i) / g.nx;
    minI = Math.min(minI, i); maxI = Math.max(maxI, i); minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j);
  }
  return { minI, maxI, minJ, maxJ };
}

test("Szenario eben/homogen/konstanter Westwind: Ellipse nach Osten gestreckt", () => {
  const g = synthGrid();
  const pre = F.precomputeRates(wx(2), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const arr = F.travelTime(g, CL, pre.rates, center(g), 30);
  const c = Math.floor(g.nx / 2);
  const e = extent(g, arr, 30);
  const east = e.maxI - c, west = c - e.minI, north = e.maxJ - c, south = c - e.minJ;
  assert.ok(east > 3 * west, `Ost ${east} vs. West ${west}`);
  assert.ok(east > north && Math.abs(north - south) <= 2, `N ${north} S ${south}`);
});

test("Windstille: annähernd kreisförmig", () => {
  const g = synthGrid();
  const pre = F.precomputeRates(wx(2, { windKmh: 0 }), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const arr = F.travelTime(g, CL, pre.rates, center(g), 60);
  const c = Math.floor(g.nx / 2), e = extent(g, arr, 60);
  const r = [e.maxI - c, c - e.minI, e.maxJ - c, c - e.minJ];
  assert.ok(Math.max(...r) - Math.min(...r) <= 1, r.join(","));
});

test("Regen/hohe Feuchte: minimale bzw. keine Ausbreitung", () => {
  const g = synthGrid();
  const pre = F.precomputeRates(wx(2, { rh: 98, tempC: 10, rain24: 10 }), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const arr = F.travelTime(g, CL, pre.rates, center(g), 60);
  let n = 0; for (const a of arr) if (a <= 60) n++;
  assert.ok(n <= 9, `${n} Zellen`);
});

test("Barriere (Straße) stoppt die Ausbreitung (kein Überspringen modelliert)", () => {
  const g = synthGrid();
  const c = Math.floor(g.nx / 2);
  const bar = CL.indexOf("barriere");
  for (let j = 0; j < g.ny; j++) g.fuel[j * g.nx + c + 10] = bar; // Nord-Süd-Linie 250 m östlich
  const pre = F.precomputeRates(wx(7), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const arr = F.travelTime(g, CL, pre.rates, center(g), 360);
  for (let j = 0; j < g.ny; j++) for (let i = c + 10; i < g.nx; i++) assert.equal(arr[j * g.nx + i], Infinity);
});

test("Diagonale 4-zusammenhängende Barriere ist dicht", () => {
  const g = synthGrid();
  const bar = CL.indexOf("barriere");
  const pts = [[200, -1500], [1400, 1500]].map(([x, y]) => [x, y]);
  Grid.rasterLine(g, pts, (i) => { g.fuel[i] = bar; });
  const pre = F.precomputeRates(wx(7, { windDirDeg: 250 }), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const arr = F.travelTime(g, CL, pre.rates, center(g), 360);
  // Punkt weit östlich jenseits der Linie darf nicht erreicht werden
  const k = Grid.cellOf(g, 1450, 0);
  assert.equal(arr[k], Infinity);
});

test("Windwechsel: Front dreht", () => {
  const g = synthGrid();
  const hours = [...wx(1, { windDirDeg: 270 }), ...wx(6, { windDirDeg: 180 })];
  const pre = F.precomputeRates(hours, CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const arr = F.travelTime(g, CL, pre.rates, center(g), 120);
  const c = Math.floor(g.nx / 2), e = extent(g, arr, 120);
  assert.ok(e.maxJ - c > c - e.minJ + 3, "nach Drehung auf Süd muss es nach Norden laufen");
  assert.ok(e.maxI - c > c - e.minI, "erste Stunde nach Osten");
});

test("Ensemble deterministisch bei festem Seed und Band möglich >= wahrscheinlich", async () => {
  const g = synthGrid();
  const inp = { grid: g, classList: CL, ignition: center(g), weatherHours: wx(7), P, runs: 6, horizonsH: [1, 2] };
  const a = await F.runEnsemble(inp);
  const b = await F.runEnsemble(inp);
  assert.deepEqual(Array.from(a.counts[1]).slice(0, 5000), Array.from(b.counts[1]).slice(0, 5000));
  const m = F.metrics(a, g, inp.ignition, P);
  for (const r of m.perH) assert.ok(r.possibleHa >= r.likelyHa);
  assert.ok(m.perH[1].possibleHa >= m.perH[0].possibleHa);
  assert.ok(Math.abs(m.mainDirDeg - 90) < 20, `Richtung ${m.mainDirDeg}`);
});

test("Projektion hin und zurück", () => {
  const pr = Grid.makeProjection(50.85, 7.33);
  const [x, y] = pr.toXY(50.86, 7.35);
  const [la, lo] = pr.toLatLng(x, y);
  assert.ok(Math.abs(la - 50.86) < 1e-9 && Math.abs(lo - 7.35) < 1e-9);
  assert.ok(Math.abs(y - 1111.95) < 1);
});

test("Protokoll: SHA-256 Referenzwert und Kettenprüfung", () => {
  assert.equal(Protocol.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  Protocol.clear();
  Protocol.add("a", { x: 1 }); Protocol.add("b", { y: 2 });
  assert.ok(Protocol.verify().ok);
  const list = Protocol.all(); list[0] = { ...list[0], daten: { x: 2 } };
  assert.equal(Protocol.verify(list).ok, false);
});

test("Vorschläge ohne OSM: geometrische Linie und Fahrzeuge mit Begründung", async () => {
  const g = Grid.makeGrid(50.85, 7.33, 3000, 25, CL);
  g.fuel.fill(CL.indexOf("gruenland"));
  const ign = center(g);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7), P, runs: 6 });
  const m = F.metrics(res, g, ign, P);
  const veh = [{ id: "a", typ: "HLF 20", loeschfahrzeug: true, tank_l: 1600, wache: "lz-nk" }, { id: "b", typ: "LF 20", loeschfahrzeug: true, tank_l: 2000, wache: "lz-nk" }, { id: "c", typ: "ELW 1", loeschfahrzeug: false, wache: "lz-se" }];
  const s = Suggest.compute(g, res, null, ign, veh, P, m.mainDirDeg, null, { stations: TEST_WACHE(g) });
  assert.ok(s.lines.length >= 1, "mindestens eine Linie");
  assert.ok(s.vehicles.length >= 2, "Fahrzeuge zugeordnet");
  for (const v of s.vehicles) assert.ok(v.reason.length > 20 && v.arrivalMin >= P.suggestions.setupMin + P.suggestions.vehicleSafetyMin);
});

// ------------------------------------------------------------------ Gelände / Hangneigung
function tiltedGrid(cls, tan, axis = "north") {
  const g = Grid.makeGrid(50.85, 7.33, 1500, 25, CL);
  g.fuel.fill(CL.indexOf(cls));
  g.elev = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [x, y] = Grid.cellCenter(g, j * g.nx + i);
    g.elev[j * g.nx + i] = 200 + tan * (axis === "north" ? y : x);
  }
  Grid.terrain(g);
  return g;
}

test("Schiefe Ebene (Anstieg nach Norden, windstill): bergauf schneller als bergab, Faktor ~ 1 + phiS", async () => {
  const tan = 0.3;
  const g = tiltedGrid("laubwald", tan);
  const pre = F.precomputeRates(wx(2, { windKmh: 0 }), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const slope = { r0: pre.r0, slopeK: pre.slopeK, maxTan: P.dem.maxTanSlope };
  const arr = F.travelTime(g, CL, pre.rates, center(g), 1e6, slope);
  const c = CL.indexOf("laubwald");
  const phiS = pre.slopeK[c] * tan * tan;
  // Ankunftszeit 10 Zellen (250 m) bergauf (Nord) / bergab (Süd) / quer (Ost, West)
  const ci = Math.floor(g.nx / 2), cj = Math.floor(g.ny / 2);
  const tN = arr[(cj + 10) * g.nx + ci], tS = arr[(cj - 10) * g.nx + ci];
  const tE = arr[cj * g.nx + ci + 10], tW = arr[cj * g.nx + ci - 10];
  // Erwartet: tS / tN = (R0 (1 + phiS)) / R0 = 1 + phiS (windstill, bergab Grundrate)
  const ratio = tS / tN;
  assert.ok(tN < tS, `bergauf ${tN.toFixed(0)} min vs. bergab ${tS.toFixed(0)} min`);
  assert.ok(Math.abs(ratio - (1 + phiS)) / (1 + phiS) < 0.05, `Verhältnis ${ratio.toFixed(3)} vs. erwartet ${(1 + phiS).toFixed(3)}`);
  assert.ok(Math.abs(tE - tW) < 1e-6 && Math.abs(tE - tS) / tS < 0.05, `quer: O ${tE} W ${tW} S ${tS}`);
  assert.ok(phiS > 1 && phiS < 3, `phiS ${phiS} für FM9 bei tan 0,3 plausibel`);
  // Hangkoeffizient entspricht Rothermel 5.275*beta^-0.3 aus rothermel()
  const ro = F.rothermel(P.fuelModels[9], { d1: 0.08, d10: 0.09, d100: 0.1, lh: 0.9, lw: 1.2 }, 0, tan, P.tonPerAcreToLbFt2);
  assert.ok(Math.abs(ro.phiS - phiS) < 1e-4, `${ro.phiS} vs ${phiS}`);
  // Horn: Neigung und Exposition (Gefälle nach Süden = 180°)
  const k = Math.floor(g.ny / 2) * g.nx + Math.floor(g.nx / 2);
  assert.ok(Math.abs(g.slope[k] - tan) < 1e-3 && Math.abs(g.aspect[k] - 180) < 1e-3, `slope ${g.slope[k]} aspect ${g.aspect[k]}`);
});

test("Hangfaktor wird bei maxTanSlope begrenzt", () => {
  const g1 = tiltedGrid("gruenland", P.dem.maxTanSlope), g2 = tiltedGrid("gruenland", 2.0);
  const pre = F.precomputeRates(wx(2, { windKmh: 0 }), CL, P, { dDir: 0, windFactor: 1, dMoist: 0 });
  const slope = { r0: pre.r0, slopeK: pre.slopeK, maxTan: P.dem.maxTanSlope };
  const a1 = F.travelTime(g1, CL, pre.rates, center(g1), 20, slope);
  const a2 = F.travelTime(g2, CL, pre.rates, center(g2), 20, slope);
  const kN = (Math.floor(g1.ny / 2) + 10) * g1.nx + Math.floor(g1.nx / 2);
  assert.ok(Math.abs(a1[kN] - a2[kN]) < 1e-9, `${a1[kN]} vs ${a2[kN]}`);
});

test("Flaches DGM (Geländewind aus) ergibt exakt das bisherige Ergebnis (Ensemble)", async () => {
  const flat = synthGrid();
  flat.elev = new Float32Array(flat.nx * flat.ny).fill(250);
  const plain = synthGrid();
  const base = { classList: CL, ignition: center(plain), weatherHours: wx(7), P, runs: 4, horizonsH: [1, 2], terrain: false };
  const a = await F.runEnsemble({ ...base, grid: plain });
  const b = await F.runEnsemble({ ...base, grid: flat });
  assert.equal(a.slopeUsed, false);
  assert.equal(b.slopeUsed, true);
  assert.deepEqual(Array.from(b.reference), Array.from(a.reference));
  assert.deepEqual(Array.from(b.counts[1]), Array.from(a.counts[1]));
});

test("Hang im Ensemble: Fläche größer als eben, Ausbreitung bergauf", async () => {
  const g = tiltedGrid("gruenland", 0.25);
  const plain = synthGrid();
  const base = { classList: CL, ignition: center(g), weatherHours: wx(3, { windKmh: 0 }), P, runs: 4, horizonsH: [1] };
  const a = await F.runEnsemble({ ...base, grid: plain });
  const b = await F.runEnsemble({ ...base, grid: g });
  const ma = F.metrics(a, plain, base.ignition, P), mb = F.metrics(b, g, base.ignition, P);
  assert.ok(mb.perH[0].refHa > ma.perH[0].refHa, `${mb.perH[0].refHa} vs ${ma.perH[0].refHa}`);
  assert.ok(Math.abs(mb.mainDirDeg - 0) < 15 || Math.abs(mb.mainDirDeg - 360) < 15, `Richtung ${mb.mainDirDeg}`);
});

test("DGM: bilineare Abfrage, null außerhalb und bei NoData", () => {
  const meta = { nx: 3, ny: 2, west: 7, east: 7.003, north: 51, south: 50.998, dLon: 0.001, dLat: 0.001, nodata: -32768, scale: 0.1 };
  const buf = new Int16Array([1000, 1100, 1200, 2000, 2100, -32768]).buffer;
  const d = Dem.fromBuffer(meta, buf);
  assert.ok(Math.abs(d.sample(50.9995, 7.0005) - 100) < 1e-9); // Mitte Zelle (0,0)
  assert.ok(Math.abs(d.sample(50.9995, 7.001) - 105) < 1e-9); // zwischen 100 und 110
  assert.ok(Math.abs(d.sample(50.999, 7.0005) - 150) < 1e-9); // zwischen 100 und 200
  assert.equal(d.sample(50.9985, 7.0025), null); // NoData-Zelle beteiligt
  assert.equal(d.sample(51.1, 7.001), null); // außerhalb
  assert.throws(() => Dem.fromBuffer(meta, new ArrayBuffer(4)));
});

test("Fehlende DGM-Datei: load() liefert null + Fehler, Raster ohne Höhe, Rechnung wie bisher", async () => {
  const fetch404 = async () => ({ ok: false, status: 404 });
  const r = await Dem.load("data/dgm25.json", fetch404);
  assert.equal(r.dem, null);
  assert.match(r.error, /404/);
  const g = Grid.makeGrid(50.85, 7.33, 1500, 25, CL, r.dem);
  assert.equal(g.elev, undefined);
  g.fuel.fill(CL.indexOf("gruenland"));
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: center(g), weatherHours: wx(3), P, runs: 2, horizonsH: [1] });
  assert.equal(res.slopeUsed, false);
});

test("Mitgeliefertes DGM (data/dgm25.*): Format, Höhenbereich plausibel, Abdeckung Gemeindegebiet", { skip: !fs.existsSync(path.join(process.cwd(), "data/dgm25.bin")) && "data/dgm25.bin fehlt" }, async () => {
  const dir = path.join(process.cwd(), "data");
  const fsFetch = async (u) => {
    const p = path.join(dir, path.basename(u));
    if (!fs.existsSync(p)) return { ok: false, status: 404 };
    const b = fs.readFileSync(p);
    return { ok: true, status: 200, json: async () => JSON.parse(b.toString("utf8")), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
  const { dem, error } = await Dem.load("data/dgm25.json", fsFetch);
  assert.equal(error, null);
  assert.equal(dem.meta.license, "dl-de/zero-2-0");
  // Ortsmitte Neunkirchen (ca. 50,858 N / 7,335 O) und Seelscheid (ca. 50,83 N / 7,30 O; Annahme Lage)
  for (const [la, lo] of [[50.858, 7.335], [50.83, 7.30]]) {
    const h = dem.sample(la, lo);
    assert.ok(h > 60 && h < 380, `Höhe ${h} m bei ${la}/${lo}`);
  }
  const g = Grid.makeGrid(50.858, 7.335, 5000, 25, CL, dem);
  assert.equal(g.elevMissing, 0);
  assert.ok(g.terrainStats.maxTan > 0.1 && g.terrainStats.maxTan < 3, `max tan ${g.terrainStats.maxTan}`);
});

// ------------------------------------------------------------------ v0.3: Konturen, Riegel, Fahrzeuge
const Contour = require("../js/contour.js");
globalThis.Contour = Contour;
const Osm = require("../js/osm.js");
const { hillOsm, makeTools } = await import("./synth-osm.mjs");
const FZ_DATA = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../data/fahrzeuge.json"), "utf8"));
// Fahrzeuge der FF Neunkirchen-Seelscheid (Teilmenge der mitgelieferten Liste) für die bisherigen Szenariotests
const VEH = FZ_DATA.fahrzeuge.filter((v) => v.kommune === "Neunkirchen-Seelscheid");

test("Ensemble: tPossible/tLikely exakt konsistent mit den Horizont-Zählern", async () => {
  const g = synthGrid();
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: center(g), weatherHours: wx(7), P, runs: 24, horizonsH: [1, 2, 4] });
  let bad = 0;
  for (let h = 0; h < 3; h++) for (let k = 0; k < g.nx * g.ny; k++) {
    if ((res.counts[h][k] / res.runs >= P.ensemble.possible) !== (res.tPossible[k] <= res.horizons[h] * 60)) bad++;
    if ((res.counts[h][k] / res.runs >= P.ensemble.likely) !== (res.tLikely[k] <= res.horizons[h] * 60)) bad++;
  }
  assert.equal(bad, 0);
  assert.deepEqual(res.quantileRuns, { possible: 3, likely: 12 });
});

function maskField(nx, ny, cells) { const f = new Float32Array(nx * ny).fill(Infinity); for (const [i, j] of cells) f[j * nx + i] = 0; return f; }

test("Marching Squares: Block, Loch, zwei Teilflächen, Einzelzelle", () => {
  const nx = 20, ny = 20;
  const block = []; for (let j = 5; j < 10; j++) for (let i = 5; i < 10; i++) block.push([i, j]);
  let c = Contour.contourPolygons(maskField(nx, ny, block), nx, ny, 30, { smooth: 0 });
  assert.equal(c.polygons.length, 1);
  assert.ok(Math.abs(c.area - (25 - 0.5)) < 1e-9, `Block ${c.area}`); // Ecken um je 1/8 Zelle abgeschrägt
  // Ring mit Loch (7x7 ohne 3x3 Mitte)
  const donut = []; for (let j = 2; j < 9; j++) for (let i = 2; i < 9; i++) if (!(i >= 4 && i <= 6 && j >= 4 && j <= 6)) donut.push([i, j]);
  c = Contour.contourPolygons(maskField(nx, ny, donut), nx, ny, 30, { smooth: 2 });
  assert.equal(c.polygons.length, 1);
  assert.equal(c.polygons[0].holes.length, 1, "ein Loch");
  assert.ok(Math.abs(c.area - 40) / 40 < 0.05, `Ringfläche ${c.area} vs. 40`);
  // zwei Teilflächen + Einzelzelle
  const two = [...block, [15, 15], [16, 15], [15, 16], [16, 16], [2, 17]];
  c = Contour.contourPolygons(maskField(nx, ny, two), nx, ny, 30, { smooth: 2 });
  assert.equal(c.polygons.length, 3);
  for (const p of c.polygons) assert.ok(Contour.ringArea(p.outer) > 0, "Außenring gegen den Uhrzeigersinn");
  // Rasteransicht: Zellumriss hat exakt die Rasterfläche
  const rings = Contour.cellOutline(nx, ny, (k) => donut.some(([i, j]) => j * nx + i === k));
  const polys = Contour.nestRings(rings);
  assert.equal(polys.reduce((s, p) => s + p.area, 0), donut.length);
});

test("Isochrone: lineare Interpolation trifft ein lineares Zeitfeld exakt", () => {
  const nx = 30, ny = 30;
  const f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) f[j * nx + i] = 10 * (i + 0.5); // Zeit wächst nach Osten
  const rings = Contour.isochrone(f, nx, ny, 123);
  const xs = rings[0].filter((p) => p[1] > 1 && p[1] < ny - 1 && p[0] > 1).map((p) => p[0]);
  for (const x of xs) assert.ok(Math.abs(x - 12.3) < 1e-6, `x ${x}`);
});

async function ensembleFor(cls, wind, dir, radius, half = 4000) {
  const g = Grid.makeGrid(50.85, 7.33, half, 25, CL);
  g.fuel.fill(CL.indexOf(cls));
  const poly = Array.from({ length: 16 }, (_, k) => g.proj.toLatLng(Math.sin((k / 16) * 2 * Math.PI) * radius, Math.cos((k / 16) * 2 * Math.PI) * radius));
  const ign = Grid.polygonCells(g, poly);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh: wind, windDirDeg: dir, tempC: 26, rh: 30 }), P });
  return { g, res, ign };
}

test("Konturen: Flächenabweichung zur Rasterfläche < 5 % (Flächen ab 100 Zellen = 6,25 ha), dokumentiert", async (t) => {
  const rows = [];
  for (const [name, cls, wind, dir, r] of [["Gras 20 km/h", "gruenland", 20, 250, 40], ["Nadelwald 25 km/h", "nadelwald", 25, 200, 100], ["Mischwald 15 km/h", "mischwald", 15, 250, 60], ["Laubwald windstill", "laubwald", 0, 0, 30]]) {
    const { g, res, ign } = await ensembleFor(cls, wind, dir, r);
    const layers = Contour.displayLayers(g.nx, g.ny, res, P, { mode: "kontur", ignition: ign });
    for (const l of layers) for (const k of ["likely", "possible", "reference"]) {
      const st = l.stats[k];
      const dev = (100 * (st.shownCells - st.rasterCells)) / st.rasterCells;
      rows.push(`${name} ${l.H} h ${k}: Raster ${st.rasterCells} Zellen, Kontur ${dev >= 0 ? "+" : ""}${dev.toFixed(1)} %`);
      if (st.rasterCells >= 100) assert.ok(Math.abs(dev) < 5, `${name} ${l.H} h ${k}: ${dev.toFixed(1)} %`);
    }
    const raster = Contour.displayLayers(g.nx, g.ny, res, P, { mode: "raster" });
    for (const l of raster) for (const k of ["likely", "possible", "reference"]) assert.equal(l.stats[k].shownCells, l.stats[k].rasterCells, "Rasteransicht flächentreu");
  }
  t.diagnostic(rows.join("\n"));
});

test("Regression schwarze Kästchen: Referenzlauf nur als Linie, keine Zellflächen; Rasteransicht verliert keine Zellen", async () => {
  // Szenario wie im Nutzer-Screenshot: langsame Ausbreitung (Horizonte dicht beieinander) mit nicht brennbaren Zellen
  const { g, res, ign } = await ensembleFor("mischwald", 15, 250, 80, 2000);
  for (let k = 0; k < 40; k++) g.fuel[(Math.floor(g.ny / 2) + (k % 5) - 2) * g.nx + Math.floor(g.nx / 2) + 6 + Math.floor(k / 5)] = CL.indexOf("siedlung");
  for (const mode of ["kontur", "raster"]) {
    const layers = Contour.displayLayers(g.nx, g.ny, res, P, { mode, ignition: ign });
    for (const l of layers) {
      // Referenzlauf: geschlossene Linienzüge; die Darstellung zeichnet sie ohne Füllung (app.js, wb-ref)
      for (const r of l.reference.rings) assert.ok(r.length >= 3 && r.every((p) => p.every(Number.isFinite)));
      // Bänder: wahrscheinlich ⊆ möglich (je Horizont), damit keine Zelle ohne Farbe bleibt
      assert.ok(l.stats.likely.rasterCells <= l.stats.possible.rasterCells);
    }
  }
  // Früherer Fehler: Zellen mit Referenz-Umriss wurden deckend schwarz gemalt (bis ~30 % der farbigen Zellen).
  // Neue Anzeige malt keine Zellen schwarz; Raster-Umriss entlang der Zellränder hat exakt die Rasterfläche.
  const ras = Contour.displayLayers(g.nx, g.ny, res, P, { mode: "raster" });
  for (const l of ras) assert.equal(l.stats.reference.shownCells, l.stats.reference.rasterCells);
});

// Synthetische Lage: Westwind, Grünland, Wege in Nord-Süd-Richtung östlich (vor der Front), ein Weg
// westlich (rückwärtig), ein Weg in West-Ost-Richtung durch den Brand (parallel zur Ausbreitung).
function windOsm(lat0, lon0, opts = {}) {
  const { pt, rect, way, building } = makeTools(lat0, lon0);
  const els = [
    way({ landuse: "meadow" }, rect(-5000, -5000, 5000, 5000)),
    way({ highway: "track", name: "Ost 300" }, [pt(300, -1500), pt(300, 1500)]),
    way({ highway: "track", name: "Ost 900" }, [pt(900, -2000), pt(900, 2000)]),
    way({ highway: "track", name: "Ost 1600" }, [pt(1600, -2500), pt(1600, 2500)]),
    way({ highway: "track", name: "West" }, [pt(-400, -1500), pt(-400, 1500)]),
    way({ highway: "track", name: "Längsweg" }, [pt(-1500, 30), pt(3000, 30)]),
    way({ landuse: "residential", name: "Dorf Ost" }, rect(2000, -300, 2400, 300)),
  ];
  for (let k = 0; k < 5; k++) els.push(building(2050 + k * 70, 0));
  if (opts.onlyNear) return { elements: [els[0], way({ highway: "track", name: "Durch den Brand" }, [pt(20, -800), pt(20, 800)])] };
  return { elements: els };
}
async function windScenario(osmFn, windKmh = 8, cls = "gruenland", vehicles = VEH) {
  const g = Grid.makeGrid(50.85, 7.33, 4000, 25, CL);
  const [lat0, lon0] = g.proj.toLatLng(0, 0);
  const osm = Osm.applyOsm(g, osmFn(lat0, lon0), P);
  if (cls !== "gruenland") for (let k = 0; k < g.fuel.length; k++) if (g.fuel[k] === CL.indexOf("gruenland")) g.fuel[k] = CL.indexOf(cls);
  const poly = Array.from({ length: 16 }, (_, k) => g.proj.toLatLng(Math.sin((k / 16) * 2 * Math.PI) * 50, Math.cos((k / 16) * 2 * Math.PI) * 50));
  const ign = Grid.polygonCells(g, poly);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh, windDirDeg: 270, tempC: 26, rh: 30 }), P });
  const m = F.metrics(res, g, ign, P);
  const s = Suggest.compute(g, res, osm, ign, vehicles, P, m.mainDirDeg, null, { stations: TEST_WACHE(g) });
  const ctx = s.ctx;
  return { g, res, ign, osm, s, ctx, m };
}
function lineCells(g, l) { const out = []; Grid.rasterLine(g, l.latlngs.map(([a, b]) => g.proj.toXY(a, b)), (k) => out.push(k)); return out; }

test("Riegel: Linie schneidet nie die „möglich“-Zone zum Bereitschaftszeitpunkt (Anfahrt + Aufbau)", async () => {
  const S = P.suggestions;
  const scen = [await windScenario(windOsm, 8), await windScenario(windOsm, 20, "nadelwald")];
  if (fs.existsSync(path.join(process.cwd(), "data/dgm25.bin"))) {
    const fsFetch = async (u) => { const b = fs.readFileSync(path.join(process.cwd(), "data", path.basename(u))); return { ok: true, json: async () => JSON.parse(b.toString("utf8")), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
    const { dem } = await Dem.load("data/dgm25.json", fsFetch);
    const g = Grid.makeGrid(50.8045, 7.3405, 5000, 25, CL, dem);
    const osm = Osm.applyOsm(g, hillOsm(50.8045, 7.3405), P);
    const poly = Array.from({ length: 12 }, (_, k) => g.proj.toLatLng(Math.sin((k / 12) * 2 * Math.PI) * 60, Math.cos((k / 12) * 2 * Math.PI) * 60));
    const ign = Grid.polygonCells(g, poly);
    const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh: 12, windDirDeg: 225, tempC: 27, rh: 30 }), P });
    const m = F.metrics(res, g, ign, P);
    const s = Suggest.compute(g, res, osm, ign, VEH, P, m.mainDirDeg, null, { stations: TEST_WACHE(g) });
    scen.push({ g, res, ign, s, ctx: s.ctx });
  }
  let n = 0;
  for (const { g, res, s, ctx } of scen) {
    const ready = s.lineInfo.readyMin;
    assert.equal(s.lineInfo.anfahrtSource, "geschätzt");
    assert.ok(s.lineInfo.readyMin === s.lineInfo.anfahrtMin + S.setupMin && s.lineInfo.anfahrtMin !== S.anfahrtMin, `Bereitschaft ${s.lineInfo.readyMin}`);
    assert.ok(s.lines.length >= 1, "mindestens eine gültige Linie in den Testlagen");
    for (const l of s.lines) {
      for (const k of lineCells(g, l)) {
        assert.ok(res.tPossible[k] > ready, `${l.id}: Zelle ${k} ist zum Bereitschaftszeitpunkt „möglich“ (t=${res.tPossible[k]})`);
        assert.ok(!ctx.readyMask[k] && ctx.distReady[k] >= S.lineClearanceM - g.cell, `${l.id}: Abstand ${ctx.distReady[k]} m`);
        n++;
      }
      assert.ok(l.minArrivalMin > ready && l.leadMin > 0 && /Vorlaufzeit/.test(l.reason) && l.reason.includes(`${ready} min`), l.reason);
    }
  }
  assert.ok(n > 50, `${n} Linienzellen geprüft`);
});

test("Riegel: bei Westwind liegt die Linie östlich vor der Front und quer zur Ausbreitung", async () => {
  const { g, s, ctx, m } = await windScenario(windOsm, 8);
  assert.ok(Math.abs(m.mainDirDeg - 90) < 20, `Hauptrichtung ${m.mainDirDeg}`);
  let maxX = -Infinity;
  for (let k = 0; k < ctx.readyMask.length; k++) if (ctx.readyMask[k]) maxX = Math.max(maxX, Grid.cellCenter(g, k)[0]);
  assert.ok(s.lines.length >= 1);
  for (const l of s.lines) {
    const xy = l.latlngs.map(([a, b]) => g.proj.toXY(a, b));
    const minX = Math.min(...xy.map((p) => p[0]));
    assert.ok(minX > maxX, `${l.id}: Linie (x ≥ ${minX.toFixed(0)}) muss östlich der Bereitschafts-Front (x ≤ ${maxX.toFixed(0)}) liegen`);
    assert.ok(l.crossDeg >= P.suggestions.lineMinCrossDeg, `quer: ${l.crossDeg}`);
    assert.ok(!/West|Längsweg/.test(l.reason), `rückwärtige/parallele Linie vorgeschlagen: ${l.reason}`);
  }
  assert.ok(s.lineInfo.rejected.quer + s.lineInfo.rejected.sektor + s.lineInfo.rejected.bereitschaft >= 1, JSON.stringify(s.lineInfo.rejected));
});

test("Riegel: keine gültige Linie -> keine erfundene Linie, Meldung mit Grund", async () => {
  const { s } = await windScenario((a, b) => windOsm(a, b, { onlyNear: true }), 8);
  assert.equal(s.lines.length, 0);
  assert.match(s.lineInfo.reason, /Keine geeignete Riegelstellung gefunden/);
  assert.match(s.lineInfo.reason, /schneiden die „möglich“-Zone/);
  assert.ok(!s.vehicles.some((v) => v.taskKind === "Riegel"), "keine Fahrzeuge an Riegeln ohne gültige Linie");
});

test("Fahrzeuge: Wasserführende verteilt (Riegel nach Länge, Objektschutz, Wasserversorgung), ohne Wasser nie im Löscheinsatz", async () => {
  const S = P.suggestions;
  const { s, g } = await windScenario(windOsm, 8);
  const water = VEH.filter((v) => Suggest.hasWater(v, P));
  assert.deepEqual(water.map((v) => v.typ).sort(), ["HLF 20", "HLF 20", "LF 20", "LF 20", "LF KatS"]);
  for (const v of s.vehicles) {
    if (["Riegel", "Objektschutz", "Wasserversorgung"].includes(v.taskKind)) assert.ok(Suggest.hasWater(v.vehicle, P), `${v.vehicle.typ} ohne Wasser als ${v.task}`);
    if (/^(ELW|MTF|DLK|GW)/.test(v.vehicle.typ)) assert.ok(v.stage || !v.taskKind || v.taskKind === "Bereitstellung", `${v.vehicle.typ}: ${v.task}`);
    assert.ok(v.reason.length > 30);
  }
  // Riegel-Fahrzeuge nur an gültigen Linien, Anzahl nach Linienlänge
  const ids = new Set(s.lines.map((l) => l.id));
  const r1 = s.lines[0];
  const onR1 = s.vehicles.filter((v) => v.lineId === r1.id && v.taskKind === "Riegel");
  for (const v of s.vehicles.filter((x) => x.taskKind === "Riegel")) assert.ok(ids.has(v.lineId));
  assert.equal(onR1.length, Math.min(water.length, Math.min(S.maxVehiclesPerLine, Math.ceil(r1.lengthM / S.sectionPerVehicleM))), `R1 ${Math.round(r1.lengthM)} m`);
  assert.ok(onR1.length >= 2, "mehr als zwei Fahrzeuge an langer Linie möglich");
  // alle wasserführenden eingesetzt, wenn der Bedarf größer ist; Reserve nur bei Überschuss
  if (s.demand.tasks >= water.length) assert.ok(!s.vehicles.some((v) => v.role === "Reserve"), "keine Reserve, solange Aufgaben offen sind");
  // Bereitstellungsraum: ein gemeinsamer Ort, jeder mit Begründung
  const st = s.vehicles.filter((v) => v.stage);
  assert.ok(st.length >= 1 && s.stageInfo);
  for (const v of st) assert.ok(v.lat === s.stageInfo.lat && v.lon === s.stageInfo.lon && v.reason.includes("Bereitstellungsraum"));
  // Standorte nicht gestapelt
  const pos = s.vehicles.filter((v) => !v.stage).map((v) => g.proj.toXY(v.lat, v.lon));
  for (let a = 0; a < pos.length; a++) for (let b = a + 1; b < pos.length; b++) assert.ok(Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]) >= 50, "Standorte nicht übereinander");
});

test("Fahrzeuge: Objektschutz für bedrohte Bebauung; Überschuss als begründete Reserve", async () => {
  // Grünland, 8 km/h Westwind: Dorf Ost (x = 2000 m) liegt im 6-h-Bereich
  const many = [...VEH, ...VEH.map((v) => ({ ...v, id: v.id + "-b" })), ...VEH.map((v) => ({ ...v, id: v.id + "-c" })), ...VEH.map((v) => ({ ...v, id: v.id + "-d" }))];
  const { s } = await windScenario(windOsm, 8, "gruenland", many);
  assert.ok(s.objects.length >= 1, "Dorf Ost bedroht");
  const os = s.vehicles.filter((v) => v.taskKind === "Objektschutz");
  assert.ok(os.length >= 1, "Objektschutz-Vorschlag");
  assert.match(os[0].reason, /Objektschutz: Bebauung/);
  const reserve = s.vehicles.filter((v) => v.role === "Reserve");
  assert.ok(reserve.length >= 1, "Überschuss bleibt Reserve");
  for (const v of reserve) assert.match(v.reason, /besetzt|Reserve/);
  assert.equal(s.demand.unmet, 0);
});

test("Ohne OSM: geometrische Linie nur, wenn außerhalb der Bereitschafts-Zone; Hinweis auf fehlende Bebauungsdaten", async () => {
  const g = Grid.makeGrid(50.85, 7.33, 4000, 25, CL);
  g.fuel.fill(CL.indexOf("gruenland"));
  const ign = center(g);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7), P, runs: 12 });
  const m = F.metrics(res, g, ign, P);
  const s = Suggest.compute(g, res, null, ign, VEH, P, m.mainDirDeg, null, { stations: TEST_WACHE(g) });
  const ready = s.lineInfo.readyMin;
  assert.ok(s.notes.some((n) => /kein Objektschutz-Vorschlag/.test(n)));
  for (const l of s.lines) for (const k of lineCells(g, l)) assert.ok(res.tPossible[k] > ready);
  if (s.lines.length) {
    // je Abschnitt ein Fahrzeug oder ein begründeter Hinweis „zu spät“ (Anfahrt geschätzt)
    const onLine = s.vehicles.filter((v) => v.taskKind === "Riegel");
    const lateNotes = s.notes.filter((n) => /kein Fahrzeug rechtzeitig/.test(n)).length;
    assert.ok(onLine.length + lateNotes >= Math.min(5, Math.ceil(s.lines[0].lengthM / P.suggestions.sectionPerVehicleM), P.suggestions.maxVehiclesPerLine) - 1, `${onLine.length} Fahrzeuge + ${lateNotes} Hinweise an ${Math.round(s.lines[0].lengthM)} m`);
    for (const v of onLine) assert.ok(v.readyMin + P.suggestions.lineMinLeadMin <= s.lines.find((l) => l.id === v.lineId).minArrivalMin + 1e-9, "Riegelfahrzeug rechtzeitig");
  }
});

// ================================================================== v0.4: Geländewind, Feuchte, Anfahrt, Fahrzeuge, Veröffentlichung
const crypto = require("node:crypto");
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const T_NOON = Date.UTC(2026, 6, 15, 11, 0); // 15.07.2026, 11 UTC (13 Uhr MESZ), Sonne hoch im Süden
const T_NIGHT = Date.UTC(2026, 6, 15, 0, 0); // 02 Uhr MESZ, Nacht
const wxT = (n, t0, o) => Array.from({ length: n }, (_, h) => ({ t: t0 + h * 3600000, windKmh: 15, windDirDeg: 270, tempC: 25, rh: 35, rain24: 0, rain72: 0, ...o }));
function terrainGrid(fn, cls = "gruenland", half = 2000) {
  const g = Grid.makeGrid(50.85, 7.33, half, 25, CL);
  g.fuel.fill(CL.indexOf(cls));
  g.elev = new Float32Array(g.nx * g.ny);
  for (let k = 0; k < g.elev.length; k++) { const [x, y] = Grid.cellCenter(g, k); g.elev[k] = fn(x, y); }
  Grid.terrain(g);
  return g;
}
const cellAt = (g, x, y) => Grid.cellOf(g, x, y);
const bearing = (ux, uy) => ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360;
function hashResult(r) {
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(new Float64Array(r.reference).buffer));
  for (const c of r.counts) h.update(Buffer.from(c.buffer));
  h.update(Buffer.from(r.tPossible.buffer)); h.update(Buffer.from(r.tLikely.buffer));
  return h.digest("hex");
}

test("Geländewind: Kuppe stärker als Mulde, Leeseite schwächer als Luvhang (Faktor begrenzt 0,5–1,4)", () => {
  // Kuppe bei x=-800, Mulde bei x=+800 (je 60 m), Wind aus West
  const g = terrainGrid((x, y) => 200 + 60 * Math.exp(-((x + 800) ** 2 + y ** 2) / (2 * 250 ** 2)) - 60 * Math.exp(-((x - 800) ** 2 + y ** 2) / (2 * 250 ** 2)));
  const cells = { kuppe: cellAt(g, -800, 0), mulde: cellAt(g, 800, 0), luv: cellAt(g, -1050, 0), lee: cellAt(g, -550, 0), eben: cellAt(g, 0, 1700) };
  const f = TW.sampleField(g, wxT(1, T_NOON, { windKmh: 20 }), P, 0, Object.values(cells), { moisture: false });
  const by = Object.fromEntries(Object.keys(cells).map((k, q) => [k, f.points[q]]));
  assert.ok(by.kuppe.fac > 1.05, `Kuppe ${by.kuppe.fac}`);
  assert.ok(by.mulde.fac < 0.95, `Mulde ${by.mulde.fac}`);
  assert.ok(by.luv.fac > by.lee.fac, `Luv ${by.luv.fac} vs Lee ${by.lee.fac}`);
  assert.ok(Math.abs(by.eben.fac - 1) < 0.03, `eben ${by.eben.fac}`);
  for (const p of f.points) assert.ok(p.fac >= P.terrain.wind.factorMin - 1e-9 && p.fac <= P.terrain.wind.factorMax + 1e-9);
});

test("Geländewind: Tal dreht den Wind zur Talachse", () => {
  // Nord-Süd-Tal (80 m tief, Breite ca. 500 m), Wind aus Südwest (weht nach Nordost, 45°)
  const g = terrainGrid((x) => 200 + 80 * (1 - Math.exp(-(x * x) / (2 * 250 ** 2))));
  const k = cellAt(g, 0, 0), kFlat = cellAt(g, 1800, 0);
  const f = TW.sampleField(g, wxT(1, T_NOON, { windKmh: 20, windDirDeg: 225 }), P, 0, [k, kFlat], { moisture: false });
  const bTal = bearing(f.points[0].ux, f.points[0].uy), bFlat = bearing(f.points[1].ux, f.points[1].uy);
  assert.ok(Math.abs(bFlat - 45) < 3, `Hochfläche ${bFlat.toFixed(1)}°`);
  assert.ok(bTal < 40 && bTal >= 0, `Tal ${bTal.toFixed(1)}° (Achse 0°, synoptisch 45°)`);
  assert.ok(f.points[0].ratio < 1, "im Tal schwächer");
});

test("Geländewind aus: Ergebnis bitgenau wie Version 0.3.0 (Prüfsumme)", async () => {
  // Prüfsumme mit dem unveränderten Code von 0.3.0 (git HEAD 5259541) für diese Lage erzeugt
  const g = Grid.makeGrid(50.85, 7.33, 1500, 25, CL);
  g.fuel.fill(CL.indexOf("gruenland"));
  g.elev = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) { const [x, y] = Grid.cellCenter(g, j * g.nx + i); g.elev[j * g.nx + i] = 200 + 40 * Math.sin(x / 400) * Math.cos(y / 300) + 0.05 * y; }
  Grid.terrain(g);
  const ign = Int32Array.from([Math.floor(g.ny / 2) * g.nx + Math.floor(g.nx / 2)]);
  const wxx = Array.from({ length: 7 }, (_, h) => ({ t: Date.UTC(2026, 6, 15, 10 + h), windKmh: 6, windDirDeg: 250, tempC: 27, rh: 30, rain24: 0, rain72: 0 }));
  const GOLD = "9371feb7af170ea25b41eb54d75d0181b2bd933576d75ccb747886c9a96c572f";
  const off = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wxx, P, runs: 8, terrain: false });
  assert.equal(hashResult(off), GOLD);
  assert.equal(off.terrainWind.active, false);
  const Poff = { ...P, terrain: { wind: { ...P.terrain.wind, enabled: false }, moisture: { ...P.terrain.moisture, enabled: false } } };
  assert.equal(hashResult(await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wxx, P: Poff, runs: 8 })), GOLD, "Schalter in params.js");
  const on = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wxx, P, runs: 8 });
  assert.notEqual(hashResult(on), GOLD);
  assert.equal(on.terrainWind.active, true);
});

test("Geländewind auf flachem DGM: Referenzlauf praktisch identisch (keine Korrektur ohne Relief)", async () => {
  const flat = synthGrid();
  flat.elev = new Float32Array(flat.nx * flat.ny).fill(250);
  const base = { classList: CL, ignition: center(flat), weatherHours: wxT(3, T_NOON), P, runs: 2, horizonsH: [1, 2], grid: flat };
  const a = await F.runEnsemble({ ...base, terrain: false });
  const b = await F.runEnsemble({ ...base });
  let maxRel = 0, diffReach = 0;
  for (let k = 0; k < a.reference.length; k++) {
    const x = a.reference[k], y = b.reference[k];
    if (Number.isFinite(x) !== Number.isFinite(y)) diffReach++;
    else if (Number.isFinite(x) && x > 0) maxRel = Math.max(maxRel, Math.abs(x - y) / x);
  }
  assert.ok(maxRel < 1e-5 && diffReach <= 2, `max. rel. Abweichung ${maxRel}, Erreichbarkeit ${diffReach}`);
});

test("Hangwind nur bei schwachem synoptischem Wind: tags hangaufwärts, nachts hangabwärts", () => {
  const g = terrainGrid((x, y) => 200 + 0.3 * y); // Anstieg nach Norden
  const k = cellAt(g, 0, 0);
  const weakDay = TW.sampleField(g, wxT(1, T_NOON, { windKmh: 3, windDirDeg: 90 }), P, 0, [k], { moisture: false });
  const strong = TW.sampleField(g, wxT(1, T_NOON, { windKmh: 25, windDirDeg: 90 }), P, 0, [k], { moisture: false });
  const weakNight = TW.sampleField(g, wxT(1, T_NIGHT, { windKmh: 3, windDirDeg: 90 }), P, 0, [k], { moisture: false });
  assert.ok(weakDay.points[0].thermal > 0 && weakDay.points[0].uy > 0.5, `tags hangaufwärts: uy ${weakDay.points[0].uy}`);
  assert.equal(weakDay.hour.thermal, "hangaufwärts");
  assert.equal(strong.points[0].thermal, 0);
  assert.equal(strong.hour.thermal, null);
  assert.ok(weakNight.points[0].thermal < 0 && weakNight.points[0].uy < -0.3, `nachts hangabwärts: uy ${weakNight.points[0].uy}`);
  // ohne Zeitstempel (Tageszeit unbekannt): kein Hangwind
  const noT = TW.sampleField(g, [{ windKmh: 3, windDirDeg: 90, tempC: 20, rh: 50 }], P, 0, [k], { moisture: false });
  assert.equal(noT.points[0].thermal, 0);
});

test("Sonnenstand: Auf-/Untergang Neunkirchen-Seelscheid plausibel (NOAA-Näherung)", () => {
  const s = TW.sunTimes(Date.UTC(2026, 5, 21), 50.85, 7.33);
  const w = TW.sunTimes(Date.UTC(2026, 11, 21), 50.85, 7.33);
  const hm = (t) => new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();
  assert.ok(hm(s.sunrise) >= 3 * 60 + 5 && hm(s.sunrise) <= 3 * 60 + 30, `21.06. Aufgang ${hm(s.sunrise)} min UTC`);
  assert.ok(hm(s.sunset) >= 19 * 60 + 35 && hm(s.sunset) <= 20 * 60, `21.06. Untergang ${hm(s.sunset)} min UTC`);
  assert.ok(hm(w.sunrise) >= 7 * 60 + 20 && hm(w.sunrise) <= 7 * 60 + 45, `21.12. Aufgang ${hm(w.sunrise)}`);
  assert.ok(hm(w.sunset) >= 15 * 60 + 15 && hm(w.sunset) <= 15 * 60 + 40, `21.12. Untergang ${hm(w.sunset)}`);
  const noon = TW.solar(Date.UTC(2026, 5, 21, 11, 30), 50.85, 7.33);
  assert.ok(Math.abs(noon.elevDeg - (90 - 50.85 + 23.44)) < 1.5 && Math.abs(noon.azDeg - 180) < 10, `Mittag ${noon.elevDeg} / ${noon.azDeg}`);
});

test("Feuchte nach Exposition: Südhang trockener als Nordhang, Feuer am Südhang schneller", async () => {
  const tan = 0.25;
  const south = terrainGrid((x, y) => 200 + tan * y, "laubwald", 1500); // steigt nach Norden = Hang nach Süden geneigt
  const north = terrainGrid((x, y) => 200 - tan * y, "laubwald", 1500);
  const ws = wxT(3, T_NOON, { windKmh: 0 });
  const fs1 = TW.sampleField(south, ws, P, 0, [center(south)[0]]), fn1 = TW.sampleField(north, ws, P, 0, [center(north)[0]]);
  assert.ok(fs1.points[0].dM < -0.2 && fn1.points[0].dM > 0.2, `dM Süd ${fs1.points[0].dM} Nord ${fn1.points[0].dM}`);
  const inp = (g, terrain) => ({ grid: g, classList: CL, ignition: center(g), weatherHours: ws, P, runs: 1, horizonsH: [1, 2], terrain });
  const opt = { wind: false, moisture: true };
  const aS = F.metrics(await F.runEnsemble(inp(south, opt)), south, center(south), P).perH[1].refHa;
  const aN = F.metrics(await F.runEnsemble(inp(north, opt)), north, center(north), P).perH[1].refHa;
  assert.ok(aS > aN * 1.03, `Fläche 2 h Südhang ${aS} ha vs. Nordhang ${aN} ha`);
  // ohne Feuchtekorrektur symmetrisch
  const bS = F.metrics(await F.runEnsemble(inp(south, false)), south, center(south), P).perH[1].refHa;
  const bN = F.metrics(await F.runEnsemble(inp(north, false)), north, center(north), P).perH[1].refHa;
  assert.ok(Math.abs(bS - bN) < 1e-9, `ohne Korrektur ${bS} vs ${bN}`);
});

test("Geländewind deterministisch (gleicher Seed -> gleiches Ergebnis), Glättung ohne Rasterartefakte", async () => {
  const g = terrainGrid((x, y) => 200 + 40 * Math.sin(x / 300) * Math.cos(y / 260));
  const inp = { grid: g, classList: CL, ignition: center(g), weatherHours: wxT(4, T_NOON, { windKmh: 8 }), P, runs: 6, horizonsH: [1, 2] };
  assert.equal(hashResult(await F.runEnsemble(inp)), hashResult(await F.runEnsemble(inp)));
  // benachbarte Zellen: Faktor ändert sich stetig
  const cells = []; for (let i = 20; i < g.nx - 20; i++) cells.push(Math.floor(g.ny / 2) * g.nx + i);
  const f = TW.sampleField(g, inp.weatherHours, P, 0, cells, { moisture: false });
  let maxJump = 0; for (let q = 1; q < f.points.length; q++) maxJump = Math.max(maxJump, Math.abs(f.points[q].fac - f.points[q - 1].fac));
  assert.ok(maxJump < 0.06, `max. Sprung ${maxJump}`);
});

test("Performance + Wirkung: Ensemble im hügeligen Gelände (DGM) mit/ohne Geländewind", { skip: !fs.existsSync(path.join(ROOT, "data/dgm25.bin")) && "kein DGM" }, async (t) => {
  const fsFetch = async (u) => { const b = fs.readFileSync(path.join(ROOT, "data", path.basename(u))); return { ok: true, json: async () => JSON.parse(b.toString("utf8")), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  const { dem } = await Dem.load("data/dgm25.json", fsFetch);
  const rows = [];
  for (const [lat0, lon0, name] of [[50.8045, 7.3405, "Hang südl. Gemeindegebiet"], [50.8267, 7.3815, "Tal bei Eischeid"]]) {
    const g = Grid.makeGrid(lat0, lon0, 5000, 25, CL, dem);
    g.fuel.fill(CL.indexOf("gruenland"));
    const poly = Array.from({ length: 12 }, (_, k) => g.proj.toLatLng(Math.sin((k / 12) * 2 * Math.PI) * 60, Math.cos((k / 12) * 2 * Math.PI) * 60));
    const ign = Grid.polygonCells(g, poly);
    for (const wind of [6, 12]) {
      const ws = wxT(7, T_NOON, { windKmh: wind, windDirDeg: 225, tempC: 27, rh: 30 });
      let t0 = Date.now();
      const off = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: ws, P, terrain: false });
      const tOff = Date.now() - t0;
      t0 = Date.now();
      const on = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: ws, P });
      const tOn = Date.now() - t0;
      const mOff = F.metrics(off, g, ign, P).perH[3], mOn = F.metrics(on, g, ign, P).perH[3];
      rows.push(`${name}, Wind ${wind} km/h aus SW: Rechenzeit aus ${tOff} ms / an ${tOn} ms; 6 h möglich ${mOff.possibleHa.toFixed(1)} -> ${mOn.possibleHa.toFixed(1)} ha (${(100 * (mOn.possibleHa / mOff.possibleHa - 1)).toFixed(1)} %), Referenz ${mOff.refHa.toFixed(1)} -> ${mOn.refHa.toFixed(1)} ha (${(100 * (mOn.refHa / mOff.refHa - 1)).toFixed(1)} %)`);
      assert.ok(tOn < 3000, `Rechenzeit ${tOn} ms`);
    }
  }
  t.diagnostic(rows.join("\n"));
});

// ------------------------------------------------------------------ Anfahrt, Fahrzeuge, Pflicht, Grundschutz, Gemeindeteil
test("Anfahrt: Luftlinie × Umwegfaktor ÷ Geschwindigkeit + Ausrückzeit; ohne Koordinate keine Schätzung", () => {
  const st = Dispatch.stationMap([{ id: "w", name: "W", lat: 50.85, lon: 7.33 }, { id: "x", name: "X", lat: null, lon: null }]);
  const dLon = 10 / (111.195 * Math.cos((50.85 * Math.PI) / 180)); // 10 km östlich
  const e = Dispatch.estimate({ id: "a", typ: "HLF 20", wache: "w" }, st, 50.85, 7.33 + dLon, P);
  const exp = P.anfahrt.ausrueckMin.FF + (10 * P.anfahrt.umwegfaktor / P.anfahrt.kmh.HLF) * 60;
  assert.ok(e.ok && Math.abs(e.min - exp) < 0.05, `${e.min} vs ${exp}`);
  assert.match(e.text, /geschätzt, kein Routing/);
  assert.equal(Dispatch.speedFor("ELW 1", P), P.anfahrt.kmh.ELW);
  assert.equal(Dispatch.speedFor("TLF 3000", P), P.anfahrt.kmh.TLF);
  const n = Dispatch.estimate({ id: "b", typ: "LF 20", wache: "x" }, st, 50.85, 7.34, P);
  assert.equal(n.ok, false);
  assert.match(n.reason, /ohne Koordinate/);
  assert.equal(Dispatch.estimate({ id: "c", typ: "LF 20", wache: "x", lat: 50.85, lon: 7.33 }, st, 50.85, 7.33 + dLon, P).ok, true, "Fahrzeugkoordinate überschreibt");
});

test("Import: bisheriges JSON (schema 1) kompatibel, Synonyme, Kommune aus Wache; Filter/Sortierung; Gruppierung", () => {
  const old = { schema_version: 1, wachen: [{ id: "lz-nk", name: "LZ NK", lat: null, lon: null }], fahrzeuge: [{ id: "nk-hlf20", typ: "HLF 20", wache: "lz-nk", tank_l: 1600 }] };
  const a = Dispatch.normalize(old);
  assert.equal(a.fahrzeuge[0].id, "nk-hlf20"); assert.equal(a.fahrzeuge[0].tank_l, 1600); assert.equal(a.wachen[0].lat, null); assert.equal(a.warnings.length, 0);
  const neu = { stations: [{ station_id: "w1", bezeichnung: "Wache 1", gemeinde: "Testdorf", latitude: "50.8", longitude: "7.2" }], vehicles: [{ fahrzeugtyp: "LF 10", station: "w1", quelle_typ: "offiziell", annahmen: "tank_l" }, { id: "v2", typ: "TLF 3000", wache: "fehlt" }] };
  const b = Dispatch.normalize(neu);
  assert.equal(b.wachen[0].lat, 50.8); assert.equal(b.fahrzeuge[0].kommune, "Testdorf"); assert.equal(b.fahrzeuge[0].typ, "LF 10");
  assert.equal(b.fahrzeuge[0].quellentyp, "offiziell"); assert.deepEqual(b.fahrzeuge[0].annahmen, ["tank_l"]);
  assert.ok(b.warnings.some((w) => /ohne id/.test(w)) && b.warnings.some((w) => /nicht in der Wachenliste/.test(w)));
  const full = Dispatch.normalize(FZ_DATA);
  assert.ok(full.fahrzeuge.length >= 100 && full.wachen.length >= 50, `${full.fahrzeuge.length} Fahrzeuge`);
  const est = new Map([["x1", { ok: true, min: 30 }], ["x2", { ok: true, min: 10 }], ["x3", { ok: false }]]);
  const vs = [{ id: "x1", kommune: "A", typ: "LF", verfuegbar: true }, { id: "x2", kommune: "B", typ: "LF", verfuegbar: false }, { id: "x3", kommune: "A", typ: "TLF" }];
  assert.deepEqual(Dispatch.filterSort(vs, { sort: "anfahrt" }, est).map((v) => v.id), ["x2", "x1", "x3"]);
  assert.deepEqual(Dispatch.filterSort(vs, { kommune: "A", onlyAvail: true }, est).map((v) => v.id), ["x1", "x3"]);
  const grp = Dispatch.groupByScreen([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 200, y: 0 }], (p) => p, 40);
  assert.equal(grp.length, 2);
});

// Lage mit synthetischen Wachen in unterschiedlicher Entfernung (KEINE echten Daten)
async function dispatchScenario(vehicles, stations, opts = {}, windKmh = 8) {
  const g = Grid.makeGrid(50.85, 7.33, 4000, 25, CL);
  const [lat0, lon0] = g.proj.toLatLng(0, 0);
  const osm = Osm.applyOsm(g, windOsm(lat0, lon0), P);
  const poly = Array.from({ length: 16 }, (_, k) => g.proj.toLatLng(Math.sin((k / 16) * 2 * Math.PI) * 50, Math.cos((k / 16) * 2 * Math.PI) * 50));
  const ign = Grid.polygonCells(g, poly);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh, windDirDeg: 270, tempC: 26, rh: 30 }), P, runs: 12 });
  const m = F.metrics(res, g, ign, P);
  const st = typeof stations === "function" ? stations(g) : stations;
  return { g, res, s: Suggest.compute(g, res, osm, ign, vehicles, P, m.mainDirDeg, null, { stations: st, ...opts }) };
}
const synthSt = (g, list) => list.map(([id, kommune, x, y]) => { const [la, lo] = g.proj.toLatLng(x, y); return { id, name: `Teststandort ${id} (synthetisch)`, kommune, lat: la, lon: lo, typ: "FF" }; });
const HL = (id, wache, extra = {}) => ({ id, typ: "HLF 20", bezeichnung: `HLF ${id}`, wache, loeschfahrzeug: true, tank_l: 1600, verfuegbar: true, ...extra });

test("Anfahrt: nächste Fahrzeuge zuerst, zu späte als „zu spät für Riegel“, ohne Koordinate und über Grenze nicht eingeplant", async () => {
  const vehicles = [HL("nah", "w-nah"), HL("mittel", "w-mittel"), HL("fern", "w-fern"), HL("ohne", "w-ohne"), HL("sehrfern", "w-sehrfern")];
  const st = (g) => [...synthSt(g, [["w-nah", "Testkommune", -2000, 0], ["w-mittel", "Testkommune", -9000, 0], ["w-fern", "Testkommune", -20000, 0], ["w-sehrfern", "Testkommune", -45000, 0]]), { id: "w-ohne", name: "ohne Koordinate", lat: null, lon: null }];
  const { s } = await dispatchScenario(vehicles, st, { maxAnfahrtMin: 60 }, 12);
  assert.ok(s.notes.some((n) => /keine Wachenkoordinate/.test(n) && n.includes("HLF ohne")), "Hinweis ohne Koordinate");
  assert.ok(s.notes.some((n) => /über 60 min/.test(n) && n.includes("HLF sehrfern")), "Hinweis Anfahrtsgrenze");
  assert.ok(!s.vehicles.some((v) => v.vehicleId === "ohne" || v.vehicleId === "sehrfern"));
  assert.equal(s.lineInfo.anfahrtVehicle, "nah", "Prüfgrenze nach frühester Bereitschaft");
  const riegel = s.vehicles.filter((v) => v.taskKind === "Riegel");
  assert.ok(riegel.length >= 1 && riegel[0].vehicleId === "nah", `zuerst das nächste: ${riegel.map((v) => v.vehicleId)}`);
  for (const v of riegel) assert.ok(v.readyMin + P.suggestions.lineMinLeadMin <= s.lines.find((l) => l.id === v.lineId).minArrivalMin + 1e-9);
  const lateIds = Object.keys(s.dispatch.late);
  assert.ok(lateIds.includes("fern"), `zu spät: ${JSON.stringify(s.dispatch.late)}`);
  assert.ok(s.notes.some((n) => /Zu spät für Riegel/.test(n)));
  const fern = s.vehicles.find((v) => v.vehicleId === "fern");
  if (fern) assert.ok(fern.lateFor && fern.lateFor.length, "Kennzeichnung am Fahrzeug");
  for (const v of s.vehicles.filter((x) => x.anfahrt && x.anfahrt.kind === "geschaetzt")) assert.match(v.anfahrt.text, /geschätzt, kein Routing/);
});

test("Pflichtfahrzeuge: immer eingeplant (vor näheren), Fallback bereitgestellt, nicht verfügbar -> Hinweis", async () => {
  const B = (id) => ({ ...HL(id, "lz-se"), kommune: "Neunkirchen-Seelscheid" });
  const pfl = [B("se-hlf20"), { ...B("se-lf20"), typ: "LF 20" }, { ...B("se-lfkats"), typ: "LF KatS", tank_l: 1000 }];
  const others = [HL("nah1", "w-nah"), HL("nah2", "w-nah"), HL("nah3", "w-nah")];
  const st = (g) => synthSt(g, [["lz-se", "Neunkirchen-Seelscheid", -14000, 0], ["w-nah", "Nachbarort", -1500, 0], ["lz-nk", "Neunkirchen-Seelscheid", -3000, 3000]]);
  const { s } = await dispatchScenario([...others, ...pfl], st, { maxAnfahrtMin: 20, teil: { teil: "Seelscheid", innerhalb: true, quelle: "Test" } }, 8);
  for (const id of ["se-hlf20", "se-lf20", "se-lfkats"]) {
    const v = s.vehicles.find((x) => x.vehicleId === id);
    assert.ok(v, `${id} eingeplant (trotz Anfahrtsgrenze 20 min)`);
    assert.ok(v.pflicht);
    assert.ok(["Riegel", "Objektschutz", "Wasserversorgung"].includes(v.taskKind) || v.role === "Pflichtfahrzeug – bereitgestellt", `${id}: ${v.task}`);
    if (v.stage) assert.match(v.reason, /keine sichere Aufgabe/);
  }
  assert.ok(s.vehicles.filter((v) => v.pflicht && !v.stage).length >= 1, "mindestens ein Pflichtfahrzeug mit Aufgabe");
  // Vorrang: erste Riegelaufgabe an ein Pflichtfahrzeug, obwohl andere näher sind
  const firstR = s.vehicles.find((v) => v.taskKind === "Riegel");
  if (firstR) assert.ok(firstR.pflicht, `erste Riegelaufgabe: ${firstR.vehicleId}`);
  // Fallback: Lage ohne Aufgabe (OSM ohne gültige Linie und ohne Bebauung) -> bereitgestellt nahe der Einsatzstelle
  const g = Grid.makeGrid(50.85, 7.33, 4000, 25, CL);
  const [la0, lo0] = g.proj.toLatLng(0, 0);
  const osmN = Osm.applyOsm(g, windOsm(la0, lo0, { onlyNear: true }), P);
  const pg = Array.from({ length: 16 }, (_, k) => g.proj.toLatLng(Math.sin((k / 16) * 2 * Math.PI) * 50, Math.cos((k / 16) * 2 * Math.PI) * 50));
  const ign = Grid.polygonCells(g, pg);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh: 8, windDirDeg: 270, tempC: 26, rh: 30 }), P, runs: 12 });
  const s2 = Suggest.compute(g, res, osmN, ign, pfl, P, 90, null, { stations: st(g), teil: { teil: "Seelscheid", innerhalb: true, quelle: "Test" } });
  assert.equal(s2.lines.length, 0);
  const pv = s2.vehicles.filter((v) => v.pflicht);
  assert.equal(pv.length, 3);
  for (const v of pv) { assert.equal(v.role, "Pflichtfahrzeug – bereitgestellt"); assert.match(v.reason, /keine sichere Aufgabe/); }
  // nicht verfügbar
  const s3 = Suggest.compute(g, res, null, ign, [{ ...pfl[0], verfuegbar: false }, pfl[1]], P, null, null, { stations: st(g) });
  assert.ok(s3.alerts.some((a) => /Pflichtfahrzeug .*nicht verfügbar/.test(a)));
  assert.ok(!s3.vehicles.some((v) => v.vehicleId === "se-hlf20"));
  // Häkchen im UI überschreibt die Liste in params.js
  assert.deepEqual([...Suggest.pflichtSet([{ id: "se-hlf20", pflicht: false }, { id: "x", pflicht: true }], P)], ["x"]);
});

test("Grundschutz: nächstes Nachbarfahrzeug je Gerätehaus, keine Doppelung, nie eigene Kommune; ohne Nachbarn Hinweis", () => {
  const g = Grid.makeGrid(50.85, 7.33, 4000, 25, CL);
  const st = synthSt(g, [["lz-nk", "Neunkirchen-Seelscheid", 0, -2000], ["lz-se", "Neunkirchen-Seelscheid", 0, 2500], ["n1", "Nachbar A", 0, -5000], ["n2", "Nachbar B", 0, 6000], ["n3", "Nachbar C", 0, 30000]]);
  const own = { ...HL("nk-hlf20", "lz-nk"), kommune: "Neunkirchen-Seelscheid" };
  const veh = [own, HL("a-hlf", "n1"), { ...HL("a-tlf", "n1"), typ: "TLF 3000" }, HL("b-lf", "n2", { typ: "LF 10" }), HL("c-hlf", "n3"), HL("a-tw", "n1", { typ: "TW 17000 (Tankwagen)", tank_l: 17000 })];
  const gs = Suggest.grundschutz(veh, st, P, new Set(), {});
  const nk = gs.assignments.find((a) => a.wacheId === "lz-nk"), se = gs.assignments.find((a) => a.wacheId === "lz-se");
  assert.equal(nk.vehicle.id, "a-hlf", "NK: nächstes (3 km) HLF aus Nachbar A");
  assert.equal(se.vehicle.id, "b-lf", "SE: LF aus Nachbar B (3,5 km) statt a-hlf (doppelt) ");
  assert.ok(nk.anfahrt.ok && se.anfahrt.ok);
  assert.notEqual(nk.vehicle.id, se.vehicle.id);
  for (const a of gs.assignments) assert.notEqual(a.vehicle.kommune, "Neunkirchen-Seelscheid");
  // eingeplant -> nicht für Grundschutz
  const gs2 = Suggest.grundschutz(veh, st, P, new Set(["a-hlf"]), {});
  assert.ok(!gs2.assignments.some((a) => a.vehicle.id === "a-hlf"), "eingeplantes Fahrzeug nicht im Grundschutz");
  assert.equal(gs2.assignments.find((a) => a.wacheId === "lz-se").vehicle.id, "b-lf");
  assert.equal(gs2.assignments.find((a) => a.wacheId === "lz-nk").vehicle.id, "c-hlf", "Typstufe HLF/LF vor TLF (Annahme)");
  assert.ok(!gs.assignments.some((a) => a.vehicle.id === "a-tw"), "Großtanker nicht im Grundschutz");
  // manuelle Wahl
  const gs3 = Suggest.grundschutz(veh, st, P, new Set(), { "lz-se": "c-hlf" });
  assert.equal(gs3.assignments.find((a) => a.wacheId === "lz-se").vehicle.id, "c-hlf");
  assert.equal(gs3.assignments.find((a) => a.wacheId === "lz-se").manual, true);
  // ohne Nachbarfahrzeuge
  const gs4 = Suggest.grundschutz([own], st, P, new Set(), {});
  assert.ok(gs4.alerts.filter((a) => /Kein Fahrzeug aus Nachbarkommune verfügbar – Grundschutz nicht sichergestellt/.test(a)).length === 2);
  // Gerätehaus ohne Koordinate: Zuordnung trotzdem, Anfahrt unbekannt
  const st5 = st.map((s) => (s.id === "lz-nk" ? { ...s, lat: null, lon: null } : s));
  const gs5 = Suggest.grundschutz(veh, st5, P, new Set(), {});
  const a5 = gs5.assignments.find((a) => a.wacheId === "lz-nk");
  assert.ok(a5.vehicle && !a5.anfahrt.ok);
  assert.ok(gs5.notes.some((n) => /Anfahrtszeit unbekannt/.test(n)));
});

test("Bereitschaft eigene Wehr (Vorgabe 25/40 min) nach Gemeindeteil; manuelle Wahl überschreibt; Gemarkungen", () => {
  const grenzen = JSON.parse(fs.readFileSync(path.join(ROOT, "data/gemeindeteile.json"), "utf8"));
  const stMap = Dispatch.stationMap(FZ_DATA.wachen);
  const se = FZ_DATA.fahrzeuge.find((v) => v.id === "se-hlf20"), nk = FZ_DATA.fahrzeuge.find((v) => v.id === "nk-hlf20");
  const B = P.bereitschaftEigeneWehr;
  // Punkte: Gerätehäuser selbst (liegen in Seelscheid bzw. Wolperath -> Neunkirchen)
  const wSE = stMap.get("lz-se"), wNK = stMap.get("lz-nk");
  const tSE = Dispatch.gemeindeteil(wSE.lat, wSE.lon, grenzen, "auto"), tNK = Dispatch.gemeindeteil(wNK.lat, wNK.lon, grenzen, "auto");
  assert.equal(tSE.teil, "Seelscheid"); assert.equal(tNK.teil, "Neunkirchen");
  const r = (v, t) => Dispatch.readiness(v, stMap, 50.85, 7.33, P.suggestions.setupMin, P, t).ready;
  assert.equal(r(se, tSE), B.gleicherTeil); assert.equal(r(nk, tSE), B.andererTeil);
  assert.equal(r(nk, tNK), B.gleicherTeil); assert.equal(r(se, tNK), B.andererTeil);
  const man = Dispatch.gemeindeteil(wSE.lat, wSE.lon, grenzen, "Neunkirchen");
  assert.equal(man.teil, "Neunkirchen"); assert.equal(man.manuell, true);
  assert.equal(r(se, man), B.andererTeil);
  // außerhalb des Gemeindegebiets (z. B. Siegburg) -> geschätzt, mind. 25 min
  const out = Dispatch.gemeindeteil(50.7926, 7.2066, grenzen, "auto");
  assert.equal(out.innerhalb, false);
  const ro = Dispatch.readiness(se, stMap, 50.7926, 7.2066, P.suggestions.setupMin, P, out);
  assert.equal(ro.kind, "geschaetzt"); assert.ok(ro.ready >= B.ausserhalbMinMin);
  // Fremdes Fahrzeug: weiter geschätzt + Aufbau
  const fremd = FZ_DATA.fahrzeuge.find((v) => v.kommune && v.kommune !== "Neunkirchen-Seelscheid" && stMap.get(v.wache) && stMap.get(v.wache).lat);
  const rf = Dispatch.readiness(fremd, stMap, wSE.lat, wSE.lon, P.suggestions.setupMin, P, tSE);
  assert.equal(rf.kind, "geschaetzt"); assert.ok(Math.abs(rf.ready - (rf.e.min + P.suggestions.setupMin)) < 1e-9);
  // Datei: 5 Gemarkungen, Zuordnung je Gemarkung dokumentiert
  assert.equal(grenzen.gemarkungen.length, 5);
  for (const gm of grenzen.gemarkungen) assert.ok(["Neunkirchen", "Seelscheid"].includes(gm.teil) && gm.zuordnung.length > 10);
});

test("Riegel mit 25-min-Bereitschaft näher an der Brandfläche als mit 40 min; Pflichtfahrzeuge SE bei Brand in Neunkirchen mit 40 min", async () => {
  const g = Grid.makeGrid(50.85, 7.33, 4000, 25, CL);
  const [lat0, lon0] = g.proj.toLatLng(0, 0);
  const osm = Osm.applyOsm(g, windOsm(lat0, lon0), P);
  const poly = Array.from({ length: 16 }, (_, k) => g.proj.toLatLng(Math.sin((k / 16) * 2 * Math.PI) * 50, Math.cos((k / 16) * 2 * Math.PI) * 50));
  const ign = Grid.polygonCells(g, poly);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh: 14, windDirDeg: 270, tempC: 27, rh: 28 }), P, runs: 12 });
  const m = F.metrics(res, g, ign, P);
  const nks = VEH; // eigene Fahrzeuge, Wachen ohne Koordinate genügen (Vorgabe)
  const st = FZ_DATA.wachen.filter((w) => w.kommune === "Neunkirchen-Seelscheid").map((w) => ({ ...w, lat: null, lon: null }));
  const run = (teil) => Suggest.compute(g, res, osm, ign, nks, P, m.mainDirDeg, null, { stations: st, teil });
  const inSE = run({ teil: "Seelscheid", innerhalb: true, quelle: "Test" }), inNK = run({ teil: "Neunkirchen", innerhalb: true, quelle: "Test" });
  assert.equal(inSE.lineInfo.readyMin, 25); assert.equal(inNK.lineInfo.readyMin, 25);
  assert.equal(inSE.lineInfo.anfahrtSource, "Vorgabe");
  assert.ok(inNK.lineInfo.second && inNK.lineInfo.second.readyMin === 40, "zweite Prüfgrenze 40 min");
  // Pflichtfahrzeuge (SE) bei Brand in Neunkirchen: Bereitschaft 40 min
  for (const id of ["se-hlf20", "se-lf20", "se-lfkats"]) {
    const v = inNK.vehicles.find((x) => x.vehicleId === id);
    assert.ok(v, `${id} eingeplant`);
    assert.equal(v.anfahrt.ready, 40, `${id}: ${v.anfahrt.text}`);
  }
  // Vergleich: nur 40-min-Fahrzeuge -> erste gültige Linie weiter vom Brand entfernt
  const only40 = Suggest.compute(g, res, osm, ign, nks.filter((v) => v.wache === "lz-se"), P, m.mainDirDeg, null, { stations: st, teil: { teil: "Neunkirchen", innerhalb: true, quelle: "Test" } });
  const near = (s) => Math.min(...s.lines.map((l) => Math.min(...l.latlngs.map(([a, b]) => Math.hypot(...g.proj.toXY(a, b))))));
  assert.ok(inNK.lines.length && only40.lines.length, "Linien in beiden Fällen");
  assert.ok(near(inNK) < near(only40), `25 min: ${near(inNK).toFixed(0)} m, 40 min: ${near(only40).toFixed(0)} m`);
  assert.equal(only40.lineInfo.readyMin, 40);
  // Sicherheit bleibt: keine Linienzelle in der möglich-Zone zum Prüfzeitpunkt
  for (const s of [inNK, only40]) for (const l of s.lines) for (const k of lineCells(g, l)) assert.ok(res.tPossible[k] > s.lineInfo.checkMin - 1e-9 || !s.ctx.readyMask[k]);
});

test("Mitgelieferte Fahrzeugdaten: Kreisdaten integriert, Nicht-Löschfahrzeuge NKS erhalten, Pflicht-IDs stabil, TLF Königswinter nicht verfügbar", () => {
  const ids = new Set(FZ_DATA.fahrzeuge.map((v) => v.id));
  for (const id of ["se-hlf20", "se-lf20", "se-lfkats", "nk-elw1", "nk-mtf", "nk-gwg", "se-dlk", "se-kef", "se-mtf", "nk-hlf20", "nk-lf20"]) assert.ok(ids.has(id), id);
  for (const id of P.pflichtFahrzeuge) assert.ok(ids.has(id), `Pflicht-ID ${id}`);
  assert.ok(new Set(FZ_DATA.fahrzeuge.map((v) => v.kommune)).size >= 15);
  const tlf = FZ_DATA.fahrzeuge.find((v) => v.id === "kw-land-tlfw");
  assert.ok(tlf && tlf.verfuegbar === false);
  for (const id of ["lz-nk", "lz-se"]) { const w = FZ_DATA.wachen.find((x) => x.id === id); assert.ok(w.lat > 50.7 && w.lat < 51 && w.lon > 7.2 && w.lon < 7.5, id); }
  assert.equal(FZ_DATA.fahrzeuge.length, new Set(FZ_DATA.fahrzeuge.map((v) => v.id)).size, "ids eindeutig");
});

test("Grundschutz mit den echten Kreisdaten (Brand bei 50,8045 N / 7,3405 O)", (t) => {
  const nd = Dispatch.normalize(FZ_DATA);
  const gs = Suggest.grundschutz(nd.fahrzeuge, nd.wachen, P, new Set(), {});
  const rows = gs.assignments.map((a) => `${a.wache ? a.wache.name : a.wacheId}: ${a.vehicle ? `${a.vehicle.bezeichnung || a.vehicle.id} (${a.kommune}), ${a.anfahrt.ok ? a.anfahrt.text : a.anfahrt.reason}` : "keins"}`);
  t.diagnostic(rows.join("\n"));
  assert.equal(gs.assignments.length, 2);
  for (const a of gs.assignments) { assert.ok(a.vehicle); assert.notEqual(a.kommune, "Neunkirchen-Seelscheid"); assert.notEqual(a.vehicle.verfuegbar, false); }
  assert.notEqual(gs.assignments[0].vehicle.id, gs.assignments[1].vehicle.id);
});

// ------------------------------------------------------------------ 0.4.2: Einsatz statt Reserve, Grundschutz, Begründungen
test("0.4.2: Grundschutz nie im Bereitstellungsraum, wasserführende Fahrzeuge nicht pauschal Reserve, Begründung je Bereitstellung", async () => {
  const nd = Dispatch.normalize(FZ_DATA);
  const g = Grid.makeGrid(50.8705, 7.3120, P.grid.halfSizeM, P.grid.cellM, CL);
  const r = 60;
  const poly = Array.from({ length: 16 }, (_, k) => g.proj.toLatLng(Math.sin((k / 16) * 2 * Math.PI) * r, Math.cos((k / 16) * 2 * Math.PI) * r));
  const ign = Grid.polygonCells(g, poly);
  const res = await F.runEnsemble({ grid: g, classList: CL, ignition: ign, weatherHours: wx(7, { windKmh: 12, windDirDeg: 225, tempC: 27, rh: 30 }), P, runs: 12, fuelClass: "mischwald" });
  const m = F.metrics(res, g, ign, P);
  const s = Suggest.compute(g, res, null, ign, nd.fahrzeuge, P, m.mainDirDeg, null, { stations: nd.wachen, teil: { teil: "Seelscheid", innerhalb: true, quelle: "Test" } });

  // 1. Grundschutz steht AM GERÄTEHAUS und nie im Bereitstellungsraum / als Pflichtfahrzeug
  const gsIds = new Set(s.grundschutz.filter((a) => a.vehicle).map((a) => a.vehicle.id));
  assert.equal(gsIds.size, 2, "zwei Gerätehäuser mit Grundschutz");
  for (const v of s.vehicles) assert.ok(!gsIds.has(v.vehicleId), `Grundschutzfahrzeug ${v.vehicleId} darf nicht im Einsatz-/Bereitstellungsvorschlag stehen (${v.task})`);
  for (const a of s.grundschutz) assert.notEqual(a.kommune, P.grundschutz.kommune);

  // 2. Zweite Bereitschaftsstufe bekommt eine eigene Riegelstellung; die später bereiten Fahrzeuge
  //    (hier LZ Neunkirchen, 40 statt 25 min) stehen dort und nicht als Reserve im Bereitstellungsraum.
  assert.ok(s.lineInfo.second, "zweite Prüfgrenze vorhanden");
  assert.ok(s.lines.length >= 2, `zweite Riegelstellung für die spätere Bereitschaftsstufe: ${s.lines.length}`);
  const r2 = s.lines[s.lines.length - 1];
  assert.equal(r2.secondStage, true);
  assert.ok(r2.minArrivalMin > s.lines[0].minArrivalMin, "Auffanglinie liegt weiter vor der Front");
  for (const id of ["nk-hlf20", "nk-lf20"]) {
    const v = s.vehicles.find((x) => x.vehicleId === id);
    assert.ok(v && !v.stage, `${id}: Einsatzaufgabe statt Reserve (${v ? v.task : "fehlt"})`);
  }
  // Sicherheitsprüfung unverändert: jedes eingesetzte Fahrzeug erfüllt Puffer und Mindestabstand
  for (const v of s.vehicles.filter((x) => !x.stage)) {
    const k = Grid.cellOf(g, ...g.proj.toXY(v.lat, v.lon));
    assert.ok(res.tPossible[k] >= v.readyMin + P.suggestions.vehicleSafetyMin - 1e-9, `${v.vehicleId}: Puffer`);
    assert.ok(res.earliest[k] > v.readyMin, `${v.vehicleId}: kein Lauf vor der Bereitschaft`);
    assert.ok(v.distTo1hM >= P.suggestions.vehicleMinDistM, `${v.vehicleId}: Mindestabstand 1-h-Bereich`);
  }
  // Keine Riegel-/Verstärkungsstellung für ein zu spätes Fahrzeug
  for (const v of s.vehicles.filter((x) => x.taskKind === "Riegel")) {
    const l = s.lines.find((x) => x.id === v.lineId);
    assert.ok(v.readyMin + P.suggestions.lineMinLeadMin <= l.minArrivalMin + 1e-9, `${v.vehicleId} zu spät für ${l.id}`);
  }

  // 3. Jedes Fahrzeug im Bereitstellungsraum hat eine nachvollziehbare Begründung
  const staged = s.vehicles.filter((v) => v.stage);
  assert.ok(staged.length, "Bereitstellungsraum besetzt");
  for (const v of staged) {
    assert.ok(v.role, `${v.vehicleId}: Rolle`);
    assert.ok(v.reason && v.reason.length > 60, `${v.vehicleId}: Begründung`);
    if (v.role === "Reserve") assert.match(v.reason, /Keine sichere Aufgabe für dieses Fahrzeug: .+/);
    if (v.role === "Pflichtfahrzeug – bereitgestellt") assert.match(v.reason, /keine sichere Aufgabe/);
    if (v.role === "Führung" || v.role === "Personalreserve") assert.match(v.reason, /ohne Löschwasser/);
    assert.match(v.reason, /Bereitschaft:/);
  }
});

test("0.4.2: Flankensicherung nur für übrige Fahrzeuge und nur an sicheren Standorten; eindeutige Linien-Ids", async () => {
  const vehicles = [HL("nah1", "w-nah"), HL("nah2", "w-nah"), HL("nah3", "w-nah"), HL("nah4", "w-nah"), HL("nah5", "w-nah"), HL("nah6", "w-nah"), HL("nah7", "w-nah")];
  const st = (g) => synthSt(g, [["w-nah", "Testkommune", -2000, 0]]);
  const { s } = await dispatchScenario(vehicles, st, { maxAnfahrtMin: 60 }, 12);
  const fl = s.vehicles.filter((v) => v.taskKind === "Flanke");
  assert.ok(fl.length <= P.suggestions.maxFlankVehicles, `höchstens ${P.suggestions.maxFlankVehicles} Flankenfahrzeuge`);
  for (const v of fl) {
    assert.match(v.reason, /ANNAHME/);
    assert.ok(v.distTo1hM >= P.suggestions.vehicleMinDistM);
  }
  // Riegel wird zuerst besetzt
  assert.ok(!fl.length || s.vehicles.some((v) => v.taskKind === "Riegel"), "Flanke erst nach Riegel");
  // Linien-Ids bleiben eindeutig (sonst falsche Zuordnung Fahrzeug -> Linie)
  assert.equal(s.lines.length, new Set(s.lines.map((l) => l.id)).size, "Linien-Ids eindeutig");
});

// ------------------------------------------------------------------ Veröffentlichung: Version, Cache-Busting, relative Pfade
test("Version einheitlich (params.js, index.html-Loader, package.json) und alle eigenen Pfade relativ", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const v = html.match(/window\.WB_VERSION = "([^"]+)"/)[1];
  assert.equal(P.version, "0.5.0-prototyp");
  assert.equal(v, P.version); assert.equal(pkg.version, P.version);
  assert.match(html, /TESTVERSION – nicht für den Einsatz/);
  const js = JSON.parse(html.match(/window\.WB_JS = (\[[^\]]+\])/)[1]), css = JSON.parse(html.match(/window\.WB_CSS = (\[[^\]]+\])/)[1]);
  for (const f of [...js, ...css]) { assert.ok(!/^(\/|https?:)/.test(f), `relativ: ${f}`); assert.ok(fs.existsSync(path.join(ROOT, f)), `vorhanden: ${f}`); }
  for (const f of fs.readdirSync(path.join(ROOT, "js")).filter((x) => x.endsWith(".js"))) assert.ok(js.includes(`js/${f}`), `${f} im Loader`);
  // keine absoluten src/href/fetch-Pfade auf eigene Dateien
  assert.ok(!/(src|href)="\//.test(html), "index.html ohne absolute Pfade");
  for (const f of ["js/app.js", "js/dem.js", "js/params.js", "css/app.css"]) {
    const t = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/fetch\(\s*["'`]\//.test(t) && !/url\(\s*["']?\//.test(t) && !/url:\s*"\//.test(t), `${f}: absolute Pfade`);
  }
  assert.ok(!/(src|href)="\//.test(fs.readFileSync(path.join(ROOT, "vendor/leaflet/leaflet.css"), "utf8")));
});
