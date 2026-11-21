// Unit- und Szenariotests für den Berechnungskern. Start: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = require("../js/params.js");
const Grid = require("../js/grid.js");
globalThis.Grid = Grid;
const F = require("../js/model.js");
const Protocol = (() => { globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; return require("../js/protocol.js"); })();
const Suggest = require("../js/suggest.js");
const Dem = require("../js/dem.js");
const fs = require("node:fs");
const path = require("node:path");

const CL = Object.keys(P.fuelClasses);

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
  const veh = [{ id: "a", typ: "HLF 20", loeschfahrzeug: true, tank_l: 1600 }, { id: "b", typ: "LF 20", loeschfahrzeug: true, tank_l: 2000 }, { id: "c", typ: "ELW 1", loeschfahrzeug: false }];
  const s = Suggest.compute(g, res, null, ign, veh, P, m.mainDirDeg, null);
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

test("Flaches DGM ergibt exakt das bisherige Ergebnis (Ensemble)", async () => {
  const flat = synthGrid();
  flat.elev = new Float32Array(flat.nx * flat.ny).fill(250);
  const plain = synthGrid();
  const base = { classList: CL, ignition: center(plain), weatherHours: wx(7), P, runs: 4, horizonsH: [1, 2] };
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
const VEH = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../data/fahrzeuge.json"), "utf8")).fahrzeuge;

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
  const s = Suggest.compute(g, res, osm, ign, vehicles, P, m.mainDirDeg, null);
  const ctx = Suggest.context(g, res, ign, P);
  return { g, res, ign, osm, s, ctx, m };
}
function lineCells(g, l) { const out = []; Grid.rasterLine(g, l.latlngs.map(([a, b]) => g.proj.toXY(a, b)), (k) => out.push(k)); return out; }

test("Riegel: Linie schneidet nie die „möglich“-Zone zum Bereitschaftszeitpunkt (Anfahrt + Aufbau)", async () => {
  const S = P.suggestions;
  const ready = S.anfahrtMin + S.setupMin;
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
    scen.push({ g, res, ign, s: Suggest.compute(g, res, osm, ign, VEH, P, m.mainDirDeg, null), ctx: Suggest.context(g, res, ign, P) });
  }
  let n = 0;
  for (const { g, res, s, ctx } of scen) {
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
  const s = Suggest.compute(g, res, null, ign, VEH, P, m.mainDirDeg, null);
  const ready = P.suggestions.anfahrtMin + P.suggestions.setupMin;
  assert.ok(s.notes.some((n) => /kein Objektschutz-Vorschlag/.test(n)));
  for (const l of s.lines) for (const k of lineCells(g, l)) assert.ok(res.tPossible[k] > ready);
  if (s.lines.length) {
    const onLine = s.vehicles.filter((v) => v.taskKind === "Riegel");
    assert.ok(onLine.length >= Math.min(5, Math.ceil(s.lines[0].lengthM / P.suggestions.sectionPerVehicleM), P.suggestions.maxVehiclesPerLine) - 1, `${onLine.length} Fahrzeuge an ${Math.round(s.lines[0].lengthM)} m`);
  }
});
