/*
 * Tests des Moduls "Karten-Interaktion" (Windpfeil + Fahrzeuge per Drag & Drop).
 * Node, ohne Browser:  node --test tests/interaktion.test.mjs
 *
 * Geprüft werden nur die DOM-freien Rechenteile (js/windrose.js, js/vehicle-drag.js).
 * Die Bedienung (Ziehen mit Maus und Touch) prüft tests/demo.e2e.mjs mit Playwright.
 *
 * Der Kern (params, grid, model, suggest, dispatch) wird aus `demo-lib/` geladen – das sind
 * UNVERÄNDERTE Kopien der Repo-Dateien, damit dieser Ordner eigenständig läuft. Nach der
 * Integration zeigen die Pfade auf ../js/ (siehe INTEGRATION.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const P = require("../js/params.js");
const Grid = require("../js/grid.js"); globalThis.Grid = Grid;
const TerrainWind = require("../js/terrain.js"); globalThis.TerrainWind = TerrainWind;
const Dispatch = require("../js/dispatch.js"); globalThis.Dispatch = Dispatch;
const FireModel = require("../js/model.js"); globalThis.FireModel = FireModel;
const Suggest = require("../js/suggest.js"); globalThis.Suggest = Suggest;
const W = require("../js/windrose.js");
const VD = require("../js/vehicle-drag.js");

const CL = Object.keys(P.fuelClasses);
// SYNTHETISCHE Lage (keine echte Einsatzstelle, keine echten Wachen): flaches Raster 4 x 4 km,
// einheitlich Laubwald, gleichbleibender Wind aus Südwest.
const LAT = 50.8, LON = 7.3;
const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);

function synthHours(n = 6, o = {}) {
  const rows = [];
  for (let h = 0; h <= n; h++) {
    rows.push({
      t: T0 + h * 3600000, tempC: 26, rh: 45, precipMm: 0, rain24: 0, rain72: 0,
      windKmh: o.windKmh ?? 12, windDirDeg: o.windDirDeg ?? 225, gustKmh: o.gustKmh ?? 25, overridden: [],
    });
  }
  return rows;
}

let FIX = null;
async function fixture() {
  if (FIX) return FIX;
  const g = Grid.makeGrid(LAT, LON, 2000, 25, CL);
  g.fuel.fill(CL.indexOf("laubwald"));
  const hours = synthHours();
  const poly = [[LAT - 0.0004, LON - 0.0006], [LAT + 0.0004, LON - 0.0006], [LAT + 0.0004, LON + 0.0006], [LAT - 0.0004, LON + 0.0006]];
  const ignition = Grid.polygonCells(g, poly);
  const result = await FireModel.runEnsemble({ grid: g, classList: CL, ignition, weatherHours: hours, P, terrain: false });
  const metrics = FireModel.metrics(result, g, ignition, P);
  const ctx = Suggest.context(g, result, ignition, P, {});
  const dir = ((metrics.mainDirDeg ?? 45) * Math.PI) / 180;
  const ux = Math.sin(dir), uy = Math.cos(dir);
  // synthetische Riegellinie quer zur Hauptausbreitungsrichtung, Abstand d vom Brandschwerpunkt
  const lineAt = (d, half = 300, id = "linie:test") => {
    const cx = ux * d, cy = uy * d;
    const a = [cx + uy * half, cy - ux * half], b = [cx - uy * half, cy + ux * half];
    return { id, xy: [a, b], latlngs: [g.proj.toLatLng(a[0], a[1]), g.proj.toLatLng(b[0], b[1])], cells: VD.lineCells(g, [a, b]) };
  };
  const stations = [{ id: "w1", name: "Teststandort (synthetisch)", kommune: "Testkommune", typ: "FF", ...llOf(g, -3000, -3000) }];
  const vehicle = { id: "fz1", typ: "HLF 20", bezeichnung: "HLF 20 (synthetisch)", wache: "w1", tank_l: 2000, verfuegbar: true };
  FIX = { g, hours, ignition, result, metrics, ctx, ux, uy, lineAt, stations, vehicle };
  return FIX;
}
function llOf(g, x, y) { const [lat, lon] = g.proj.toLatLng(x, y); return { lat, lon }; }

// ====================================================================== Windpfeil: Winkel
test("Winkel-Interpolation läuft über 0° (kürzerer Weg)", () => {
  assert.equal(W.lerpDeg(350, 10, 0.5), 0);
  assert.equal(W.lerpDeg(350, 10, 0.25), 355);
  assert.equal(W.lerpDeg(10, 350, 0.5), 0);
  assert.equal(W.lerpDeg(10, 350, 0.25), 5);
  // nicht über 180 hinweg "falsch herum"
  assert.equal(W.lerpDeg(20, 200, 0.5), 110); // genau 180° -> im Uhrzeigersinn (dokumentiert)
  assert.equal(W.signedDiff(350, 10), 20);
  assert.equal(W.signedDiff(10, 350), -20);
  assert.equal(W.angDiff(350, 10), 20);
  assert.equal(W.norm(-10), 350);
});

test("Rastung: 5°, Feinmodus 1°, Stärke 1 bzw. 0,5 km/h", () => {
  assert.equal(W.snapDeg(47), 45);
  assert.equal(W.snapDeg(48), 50);
  assert.equal(W.snapDeg(358), 0);        // 360 -> 0
  assert.equal(W.snapDeg(-3), 355);      // -3° = 357° -> nächster 5°-Schritt
  assert.equal(W.snapDeg(47.4, { fine: true }), 47);
  assert.equal(W.snapDeg(47.6, { fine: true }), 48);
  assert.equal(W.snapKmh(12.4), 12);
  assert.equal(W.snapKmh(12.4, { fine: true }), 12.5);
  assert.equal(W.snapKmh(-5), 0);
  assert.equal(W.snapKmh(999), W.DEFAULTS.maxKmh);
});

test("Beschriftung und ARIA-Text", () => {
  assert.equal(W.label({ dirDeg: 225, kmh: 12, gustKmh: 25 }), "SW 12 km/h, Böen 25");
  assert.equal(W.compass(0), "N");
  assert.equal(W.compass(225), "SW");
  assert.match(W.ariaLabel({ dirDeg: 225, kmh: 12, gustKmh: 25 }), /Wind aus Südwest, 225 Grad, 12 Kilometer pro Stunde, Böen 25/);
});

test("Zeigerposition -> Richtung; Radius -> Stärke ist Umkehrung der Pfeilgeometrie", () => {
  // Zeiger genau nördlich über dem Drehpunkt: Pfeil zeigt nach Norden, Wind kommt also aus Süden
  const d = W.dirFromPointer({ cx: 100, cy: 100, x: 100, y: 40 });
  assert.equal(Math.round(d.toDeg), 0);
  assert.equal(Math.round(d.fromDeg), 180);
  assert.equal(Math.round(d.radiusPx), 60);
  assert.equal(W.dirFromPointer({ cx: 1, cy: 1, x: 1, y: 1 }), null);
  const opt = { radiusPx: 78, minLenPx: 35, maxKmh: 120 };
  for (const kmh of [0, 7, 25, 60, 119]) {
    const geo = W.arrowGeometry({ dirDeg: 90, kmh, ...opt });
    const back = W.kmhFromRadius(geo.lenPx, opt);
    assert.ok(Math.abs(back - kmh) < 0.001, `${kmh} -> ${geo.lenPx} -> ${back}`);
  }
  assert.equal(W.kmhFromRadius(1000, opt), 120);
});

test("Tastaturbedienung: Richtung, Stärke, Feinmodus, zurück auf echtes Wetter", () => {
  const st = { dirDeg: 180, kmh: 10 };
  assert.equal(W.keyAdjust(st, "ArrowRight").dirDeg, 185);
  assert.equal(W.keyAdjust(st, "ArrowLeft").dirDeg, 175);
  assert.equal(W.keyAdjust(st, "ArrowLeft", { shift: true }).dirDeg, 179);
  assert.equal(W.keyAdjust(st, "ArrowUp").kmh, 11);
  assert.equal(W.keyAdjust(st, "ArrowDown", { shift: true }).kmh, 9.5);
  assert.equal(W.keyAdjust(st, "PageUp").dirDeg, 225);
  assert.equal(W.keyAdjust(st, "Home").kmh, 0);
  assert.equal(W.keyAdjust(st, "End").kmh, W.DEFAULTS.maxKmh);
  assert.equal(W.keyAdjust(st, "0").reset, true);
  assert.equal(W.keyAdjust(st, "x").handled, false);
  // Richtung bleibt beim Ändern der Stärke unverändert (und umgekehrt)
  assert.equal(W.keyAdjust(st, "ArrowUp").dirDeg, 180);
  assert.equal(W.keyAdjust(st, "ArrowRight").kmh, 10);
});

// ====================================================================== Windpfeil: Zeitplan
test("Zeitplan überschreibt NUR ab dem jeweiligen Zeitpunkt", () => {
  const hours = synthHours(6); // 12:00 UTC bis 18:00 UTC
  const sch = [{ t: hours[3].t, dirDeg: 90, kmh: 30 }]; // ab +3 h
  const { hours: out, info } = W.applySchedule(hours, sch);
  assert.equal(info.entries, 1);
  assert.equal(info.keptHours, 3);
  assert.equal(info.overriddenHours, 4);
  for (let k = 0; k < 3; k++) {
    assert.equal(out[k].windDirDeg, 225, `Stunde ${k} bleibt echtes Wetter`);
    assert.equal(out[k].windKmh, 12);
    assert.deepEqual(out[k].overridden, []);
    assert.equal(out[k].windSource, "echt");
  }
  for (let k = 3; k <= 6; k++) {
    assert.equal(out[k].windDirDeg, 90, `Stunde ${k} überschrieben`);
    assert.equal(out[k].windKmh, 30);
    assert.ok(out[k].overridden.includes("windDirDeg") && out[k].overridden.includes("windKmh"));
    assert.equal(out[k].windSource, "zeitplan");
  }
  // Eingangsdaten bleiben unverändert (keine Seiteneffekte)
  assert.equal(hours[5].windDirDeg, 225);
});

test("Zeitplan mit mehreren Stützstellen: Interpolation über 0° hinweg", () => {
  const hours = synthHours(6);
  const sch = [
    { t: hours[2].t, dirDeg: 350, kmh: 10 },
    { t: hours[4].t, dirDeg: 10, kmh: 20 },
  ];
  const { hours: out, info } = W.applySchedule(hours, sch);
  assert.equal(info.entries, 2);
  assert.equal(out[1].windDirDeg, 225);               // vor der ersten Stützstelle: echt
  assert.equal(out[2].windDirDeg, 350);
  assert.equal(out[3].windDirDeg, 0);                 // Mitte: über 0°, nicht über 180°
  assert.equal(out[3].windKmh, 15);
  assert.equal(out[4].windDirDeg, 10);
  assert.equal(out[5].windDirDeg, 10);                // danach gehalten (holdAfterLast)
  assert.equal(out[6].windKmh, 20);
  // ohne Halten bleibt nach der letzten Stützstelle das echte Wetter stehen
  const o2 = W.applySchedule(hours, sch, { holdAfterLast: false });
  assert.equal(o2.hours[5].windDirDeg, 225);
  assert.equal(o2.hours[5].windSource, "echt");
});

test("Zeitplan: Stützstelle ohne Böen leitet Böen ab (nie unter dem Mittelwind), Uhrzeit-Eingabe", () => {
  const hours = synthHours(6);
  const sch = [{ t: hours[2].t, dirDeg: 90, kmh: 40 }];
  const { hours: out, info } = W.applySchedule(hours, sch);
  assert.equal(out[2].gustKmh, 40);          // echtes Wetter hatte 25 -> Mittelwind 40 gewinnt
  assert.equal(info.gustDerived, true);
  const t = W.parseClock("15:30", T0);
  assert.equal(W.formatClock(t), "15:30");
  assert.equal(W.parseClock("1530", T0), t);
  assert.equal(W.parseClock("25:00", T0), null);
  assert.equal(W.parseClock("", T0), null);
});

test("Überschreibung: konstant für alle Stunden, Zeitplan zusätzlich ab Zeitpunkt, alles gekennzeichnet", () => {
  const hours = synthHours(6);
  let ov = W.emptyOverride();
  assert.equal(W.isManual(ov), false);
  ov = W.setDirection(ov, 272, { now: T0 });      // Rastung auf 5°
  ov = W.setSpeed(ov, 27.4, { now: T0 });
  assert.equal(ov.dirDeg, 270);
  assert.equal(ov.kmh, 27);
  assert.equal(W.isManual(ov), true);
  assert.deepEqual(W.overrideFields(ov), ["windDirDeg", "windKmh"]);
  ov = W.setSchedule(ov, [{ t: hours[4].t, dirDeg: 180, kmh: 8 }]);
  const { hours: out, info } = W.applyOverride(hours, ov);
  assert.equal(info.manual, true);
  assert.equal(out[0].windDirDeg, 270);
  assert.equal(out[0].windSource, "pfeil");
  assert.ok(out[0].overridden.includes("windDirDeg"));
  assert.equal(out[4].windDirDeg, 180);
  assert.equal(out[4].windSource, "zeitplan");
  assert.ok(out[4].overridden.includes("windKmh"));
  // Knopf "Zurück auf echtes Wetter"
  const back = W.clearOverride();
  assert.equal(W.isManual(back), false);
  const r2 = W.applyOverride(hours, back);
  assert.equal(r2.hours[4].windDirDeg, 225);
  assert.equal(r2.hours[4].windSource, "echt");
  assert.deepEqual(r2.hours[4].overridden, []);
});

test("Kennzeichnung in Text, Protokoll und Export", () => {
  let ov = W.setSpeed(W.setDirection(W.emptyOverride(), 225), 12);
  ov = W.setSchedule(ov, [{ t: T0 + 2 * 3600000, dirDeg: 90, kmh: 30 }]);
  assert.match(W.overrideText(ov), /^MANUELL ÜBERSCHRIEBEN/);
  const pe = W.protocolEntry(ov);
  assert.equal(pe.manuell, true);
  assert.equal(pe.richtung_aus_grad, 225);
  assert.equal(pe.zeitplan.length, 1);
  assert.match(pe.hinweis, /Manuelle Überschreibung/);
  const ep = W.exportProps(ov);
  assert.equal(ep.wind_manuell, true);
  assert.equal(ep.wind_kmh, 12);
  assert.match(ep.wind_zeitplan, /^ab \d\d:\d\d aus 90°/);
  assert.equal(W.exportProps(W.emptyOverride()).wind_manuell, false);
  assert.equal(W.overrideText(null), "keine manuelle Überschreibung (echtes Wetter)");
});

test("Entprellung und Abbruch einer laufenden Rechnung", () => {
  const calls = [];
  let timer = null, pending = null;
  const deb = W.createDebouncer({
    delayMs: 300, run: (a) => calls.push(a),
    setTimer: (fn) => { pending = fn; timer = 1; return timer; },
    clearTimer: () => { pending = null; timer = null; },
  });
  deb.trigger("a"); deb.trigger("b"); deb.trigger("c");
  assert.equal(calls.length, 0);
  assert.equal(deb.pending, true);
  pending();                                   // Zeit abgelaufen
  assert.deepEqual(calls, ["c"]);              // nur der letzte Stand wird gerechnet
  assert.equal(deb.delayMs, 300);

  const guard = W.createRunGuard();
  const g1 = guard.start();
  assert.equal(guard.isCurrent(g1), true);
  const g2 = guard.start();                    // neue Eingabe
  assert.throws(() => guard.throwIfStale(g1), (e) => W.isAbort(e));
  guard.throwIfStale(g2);                      // aktuelle Generation läuft weiter
  guard.cancel();                              // Knopf "Abbrechen"
  assert.throws(() => guard.throwIfStale(g2), (e) => W.isAbort(e) && /abgebrochen/.test(e.message));
});

test("Szenario-Vergleich A/B: Kennzahlen und Anzeigezeilen", () => {
  const A = { metrics: { perH: [{ H: 1, likelyHa: 2, possibleHa: 4 }, { H: 6, likelyHa: 10, possibleHa: 20 }], mainDirDeg: 45 }, reach: { wohnbebauung: { earliest: 120 }, strasse: { earliest: Infinity } }, windSetting: { dirDeg: 225, kmh: 12 } };
  const B = { metrics: { perH: [{ H: 1, likelyHa: 3, possibleHa: 5 }, { H: 6, likelyHa: 14, possibleHa: 30 }], mainDirDeg: 350 }, reach: { wohnbebauung: { earliest: 90 }, strasse: { earliest: 300 } }, windSetting: { dirDeg: 170, kmh: 24 } };
  const c = W.compare(A, B);
  assert.equal(c.areas.length, 2);
  assert.equal(c.areas[1].dPossibleHa, 10);
  assert.equal(c.areas[1].dPossiblePct, 50);
  assert.equal(c.mainDir.deltaDeg, 55);
  const wohn = c.objects.find((o) => o.key === "wohnbebauung");
  assert.equal(wohn.deltaMin, -30);
  const str = c.objects.find((o) => o.key === "strasse");
  assert.equal(str.aReached, false);
  assert.equal(str.bReached, true);
  const rows = W.compareRows(c);
  assert.ok(rows.some((r) => r.name === "6 h „möglich“" && r.delta.startsWith("+10")));
  assert.ok(rows.some((r) => r.delta === "in B zusätzlich erreicht"));
  assert.notEqual(W.contourStyle("A").dashArray, W.contourStyle("B").dashArray);
  assert.match(c.wind.b, /aus 170°/);
});

// ====================================================================== Fahrzeuge: Zuordnung
test("Zuordnung Fahrzeug -> Riegel nach Radius (Annahme 150 m)", async () => {
  const F = await fixture();
  const p = VD.params(P);
  assert.equal(p.snapRadiusM, 150);
  const line = F.lineAt(400, 300);
  const mid = [(line.xy[0][0] + line.xy[1][0]) / 2, (line.xy[0][1] + line.xy[1][1]) / 2];
  const nah = VD.nearestLine(F.g, [line], mid[0] + F.ux * 100, mid[1] + F.uy * 100, P);
  assert.equal(nah.inRadius, true);
  assert.ok(Math.abs(nah.distM - 100) < 1);
  assert.equal(nah.line.id, "linie:test");
  const fern = VD.nearestLine(F.g, [line], mid[0] + F.ux * 200, mid[1] + F.uy * 200, P);
  assert.equal(fern.inRadius, false);
  assert.ok(Math.abs(fern.distM - 200) < 1);
  // von zwei Linien gewinnt die nähere
  const zwei = VD.nearestLine(F.g, [F.lineAt(400, 300, "a"), F.lineAt(600, 300, "b")], F.ux * 580, F.uy * 580, P);
  assert.equal(zwei.line.id, "b");
  // Lot hinter dem Ende wird erkannt (Grundlage für das Verlängern)
  const hinten = VD.nearestLine(F.g, [line], line.xy[1][0] + (line.xy[1][0] - line.xy[0][0]) / 600 * 100, line.xy[1][1] + (line.xy[1][1] - line.xy[0][1]) / 600 * 100, P);
  assert.equal(hinten.after, true);
  assert.equal(hinten.inRadius, true);
});

test("Linie verlängert sich zum Fahrzeug hin, solange die Prüfung aus suggest.js erfüllt bleibt", async () => {
  const F = await fixture();
  const line = F.lineAt(400, 300);
  const a = line.xy[0], b = line.xy[1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ex = (b[0] - a[0]) / len, ey = (b[1] - a[1]) / len;
  const vx = b[0] + ex * 120, vy = b[1] + ey * 120;   // 120 m hinter dem Ende, auf der Achse
  const before = VD.polyLength(line.xy);
  const r = VD.adjustLine(F.g, F.ctx, P, line, vx, vy);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "verlaengern");
  assert.equal(r.changed, true);
  assert.ok(r.amountM >= 110 && r.amountM <= 120, `verlängert um ${r.amountM} m`);
  assert.ok(r.lengthM > before + 100);
  assert.equal(r.latlngs.length, 2);
  // die geänderte Linie erfüllt das Zellkriterium aus evalCells weiterhin
  const safe = VD.lineSafe(F.g, F.ctx, P, r.cells);
  assert.equal(safe.ok, true);
  assert.ok(safe.minClearanceM >= P.suggestions.lineClearanceM);
  assert.match(r.reason, /Sicherheitsprüfung aus js\/suggest\.js weiterhin erfüllt/);
  // Verlängerung ist auf maxExtendM begrenzt (Annahme)
  const weit = VD.adjustLine(F.g, F.ctx, P, line, b[0] + ex * 900, b[1] + ey * 900);
  assert.ok(weit.amountM <= VD.params(P).maxExtendM);
});

test("Linie verschiebt sich quer zum Fahrzeug hin, wenn das sicher bleibt", async () => {
  const F = await fixture();
  const line = F.lineAt(500, 300);
  const mid = [(line.xy[0][0] + line.xy[1][0]) / 2, (line.xy[0][1] + line.xy[1][1]) / 2];
  const r = VD.adjustLine(F.g, F.ctx, P, line, mid[0] - F.ux * 40, mid[1] - F.uy * 40);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "verschieben");
  assert.ok(r.amountM >= 30 && r.amountM <= 40);
  assert.equal(VD.lineSafe(F.g, F.ctx, P, r.cells).ok, true);
  // gleich lang geblieben
  assert.ok(Math.abs(r.lengthM - VD.polyLength(line.xy)) < 1);
});

test("Verletzt die Anpassung die Prüfung, bleibt die Linie unverändert", async () => {
  const F = await fixture();
  const line = F.lineAt(170, 300);                       // Linie knapp außerhalb der „möglich“-Zone
  assert.equal(VD.lineSafe(F.g, F.ctx, P, VD.lineCells(F.g, line.xy)).ok, true);
  const mid = [(line.xy[0][0] + line.xy[1][0]) / 2, (line.xy[0][1] + line.xy[1][1]) / 2];
  const r = VD.adjustLine(F.g, F.ctx, P, line, mid[0] - F.ux * 80, mid[1] - F.uy * 80); // Fahrzeug Richtung Feuer
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(r.mode, "unveraendert");
  assert.deepEqual(r.xy, line.xy);                       // Geometrie unangetastet
  assert.match(r.reason, /Linie bleibt unverändert/);
  assert.match(r.reason, /„möglich“-Zone zum Prüfzeitpunkt/);
});

test("Warnung mit Zahlen bei unsicherem Standort; Platzieren bleibt erlaubt", async () => {
  const F = await fixture();
  const stMap = Dispatch.stationMap(F.stations);
  // Standort direkt in der Ausbreitungsrichtung, 150 m vor dem Brandherd
  const nah = llOf(F.g, F.ux * 150, F.uy * 150);
  const bad = VD.checkDrop(F.g, F.result, F.ctx, P, F.vehicle, nah.lat, nah.lon, { stationMap: stMap, stations: F.stations });
  assert.equal(bad.ok, false);
  assert.ok(Number.isFinite(bad.frontMin));
  assert.ok(bad.readyMin > 0);
  assert.match(bad.warnText, /Front .* erreicht die Position nach/);
  assert.match(bad.warnText, /Einsatzbereitschaft erst nach \d+ min/);
  assert.match(bad.kurz, /^Front nach /);
  // dieselbe Prüfung wie js/suggest.js
  const ref = Suggest.checkPosition(F.g, F.result, F.ctx, P, nah.lat, nah.lon, bad.readyMin);
  assert.equal(bad.ok, ref.ok);

  // weit hinter der Front: Prüfung erfüllt
  const weit = llOf(F.g, -F.ux * 1500, -F.uy * 1500);
  const good = VD.checkDrop(F.g, F.result, F.ctx, P, F.vehicle, weit.lat, weit.lon, { stationMap: stMap, stations: F.stations });
  assert.equal(good.ok, true);
  assert.equal(good.warnText, "");
  assert.match(good.checkText, /Sicherheitsannahmen erfüllt/);

  // Platzieren ist trotz Warnung möglich und landet mit Warnung im Protokoll
  const store = VD.createStore();
  const rec = store.place({ id: "fz1", label: "HLF 20", lat: nah.lat, lon: nah.lon, lineId: null, warn: bad.warnText });
  const pe = VD.protocolEntry("fahrzeug_gesetzt", rec, bad, null);
  assert.equal(pe.von_hand, true);
  assert.equal(pe.gesperrt, true);
  assert.equal(pe.pruefung.erfuellt, false);
  assert.match(pe.warnung, /Einsatzbereitschaft erst nach/);
  const ep = VD.exportProps(rec, bad);
  assert.equal(ep.von_hand_gesetzt, true);
  assert.equal(ep.pruefung_erfuellt, false);
});

test("Hilfslinien: Entfernung zur Front, nächste Riegellinie, Entnahmestelle", async () => {
  const F = await fixture();
  const line = F.lineAt(400, 300);
  const pos = llOf(F.g, F.ux * 500, F.uy * 500);
  const water = llOf(F.g, F.ux * 500 + 220, F.uy * 500);
  const gg = VD.guides(F.g, F.ctx, P, {
    lat: pos.lat, lon: pos.lon, lines: [line],
    waterPoints: [{ id: "w1", kind: "Saugstelle", verified: false, ...water }],
  });
  assert.ok(gg.front.distReadyM > 0);
  assert.match(gg.front.text, /Front: \d+ m bis zur „möglich“-Zone/);
  assert.equal(gg.line.inRadius, true);
  assert.ok(Math.abs(gg.line.distM - 100) < 2);
  assert.ok(Math.abs(gg.water.distM - 220) < 5);
  assert.match(gg.water.text, /Entnahmestelle/);
  // außerhalb des Rechengebiets
  const out = VD.guides(F.g, F.ctx, P, { lat: F.g.bounds.north + 1, lon: F.g.bounds.east + 1, lines: [line], waterPoints: [] });
  assert.equal(out.outside, true);
  assert.equal(out.front, null);
});

test("Von Hand gesetzte Fahrzeuge: Sperre, Entfernen, Rückgängig/Wiederherstellen, Unterschied", () => {
  const store = VD.createStore({ undoDepth: 5 });
  store.place({ id: "a", label: "HLF 20", lat: 50.8, lon: 7.3 });
  store.place({ id: "b", label: "TLF 3000", lat: 50.81, lon: 7.31 });
  assert.equal(store.all.length, 2);
  assert.deepEqual(store.lockedIds().sort(), ["a", "b"]);   // Ablage sperrt (Annahme lockOnDrop)
  store.setLocked("a", false);
  assert.deepEqual(store.lockedIds(), ["b"]);
  const before = store.all;
  store.move("b", { lat: 50.82, lon: 7.32 });
  const after = store.all;
  const d = VD.diffPlacements(before, after);
  assert.equal(d.moved.length, 1);
  assert.ok(d.moved[0].distM > 25);
  assert.equal(d.kept.length, 1);
  assert.match(d.text, /1 verschoben/);
  assert.equal(store.canUndo, true);
  store.undo();
  assert.ok(Math.abs(store.get("b").lat - 50.81) < 1e-9);
  store.redo();
  assert.ok(Math.abs(store.get("b").lat - 50.82) < 1e-9);
  store.remove("a");
  assert.equal(store.all.length, 1);
  assert.equal(store.has("a"), false);
  store.undo();
  assert.equal(store.has("a"), true);
  const d2 = VD.diffPlacements([{ id: "a", lat: 50.8, lon: 7.3, task: "Riegel R1" }], [{ id: "a", lat: 50.8, lon: 7.3, task: "Objektschutz" }, { id: "c", lat: 50.8, lon: 7.3 }]);
  assert.equal(d2.added.length, 1);
  assert.equal(d2.retasked.length, 1);
  assert.equal(d2.removed.length, 0);
});

// ====================================================================== Determinismus
test("Determinismus: gleiche Eingabe -> bitgleiches Ergebnis (Wind, Zeitplan, Anpassung, Prüfung)", async () => {
  const hours = synthHours(6);
  const ov = W.setSchedule(W.setSpeed(W.setDirection(W.emptyOverride(), 272, { now: T0 }), 27.4, { now: T0 }), [{ t: hours[3].t, dirDeg: 355, kmh: 18 }]);
  const a1 = JSON.stringify(W.applyOverride(hours, ov));
  const a2 = JSON.stringify(W.applyOverride(hours, ov));
  assert.equal(a1, a2);
  assert.equal(JSON.stringify(W.timeline(hours, ov.schedule)), JSON.stringify(W.timeline(hours, ov.schedule)));

  const F = await fixture();
  const line = F.lineAt(400, 300);
  const b = line.xy[1], a = line.xy[0];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const vx = b[0] + ((b[0] - a[0]) / len) * 120, vy = b[1] + ((b[1] - a[1]) / len) * 120;
  const r1 = VD.adjustLine(F.g, F.ctx, P, line, vx, vy);
  const r2 = VD.adjustLine(F.g, F.ctx, P, line, vx, vy);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));

  const pos = llOf(F.g, F.ux * 150, F.uy * 150);
  const stMap = Dispatch.stationMap(F.stations);
  const c1 = VD.checkDrop(F.g, F.result, F.ctx, P, F.vehicle, pos.lat, pos.lon, { stationMap: stMap });
  const c2 = VD.checkDrop(F.g, F.result, F.ctx, P, F.vehicle, pos.lat, pos.lon, { stationMap: stMap });
  assert.equal(JSON.stringify(c1), JSON.stringify(c2));

  // zweiter kompletter Ensemble-Lauf mit denselben Eingaben liefert dieselben Kennzahlen
  const g2 = Grid.makeGrid(LAT, LON, 2000, 25, CL);
  g2.fuel.fill(CL.indexOf("laubwald"));
  const ign2 = Grid.polygonCells(g2, [[LAT - 0.0004, LON - 0.0006], [LAT + 0.0004, LON - 0.0006], [LAT + 0.0004, LON + 0.0006], [LAT - 0.0004, LON + 0.0006]]);
  const res2 = await FireModel.runEnsemble({ grid: g2, classList: CL, ignition: ign2, weatherHours: synthHours(6), P, terrain: false });
  const m2 = FireModel.metrics(res2, g2, ign2, P);
  assert.equal(JSON.stringify(m2.perH), JSON.stringify(F.metrics.perH));
  assert.equal(m2.mainDirDeg, F.metrics.mainDirDeg);
});
