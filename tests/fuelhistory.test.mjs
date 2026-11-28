// Tests Modul Trockenheit / Vorgeschichte des Wetters (0.9.0). Start: node --test tests/fuelhistory.test.mjs
//
// Synthetische Szenarien (KEIN echtes Wetter). Alle Zahlen sind Annahmen aus js/fuelhistory-params.js.
// Die FWI-Referenz tests/fixtures/fwi_xclim.json wurde mit tools/make_fwi_fixture.py aus
// xclim 1.0.0 (xclim.compute.fire._cffwis, Gleichungen nach Van Wagner 1987 / cffdrs) erzeugt.
//
// Die Szenariodatei tests/fuelhistory-scenarios.cjs liegt bewusst NICHT unter js/: tests/model.test.mjs
// verlangt für jede Datei in js/ einen Eintrag in der Loaderliste von index.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FP0 = require("../js/fuelhistory-params.js");
const FH = require("../js/fuelhistory.js");
const SZ = require("./fuelhistory-scenarios.cjs");
const P0 = require("../js/params.js");
const Grid = require("../js/grid.js");
globalThis.Grid = Grid;
globalThis.TerrainWind = require("../js/terrain.js");
const FireModel = require("../js/model.js");
const CL = Object.keys(P0.fuelClasses);

const params = (over = {}) => {
  const F = JSON.parse(JSON.stringify(FP0));
  for (const [k, v] of Object.entries(over)) F[k] = (v && typeof v === "object" && !Array.isArray(v)) ? Object.assign(F[k], v) : v;
  return F;
};
const HOUR = 3600000;
const legacyOf = (w) => {
  const d = FireModel.deadMoisture({ ...w, rain24: w.rain24 || 0, rain72: w.rain72 || 0 }, P0.moisture);
  return { d1: d.d1, d10: d.d10, d100: d.d100, lh: P0.moisture.liveHerb, lw: P0.moisture.liveWoody };
};

// ================================================================== 1. FWI gegen xclim
test("FWI-System: 150 Tage gegen xclim-Referenz (Van Wagner 1987)", () => {
  const FP = params();
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/fwi_xclim.json"), "utf8"));
  assert.ok(fx.days.length >= 150, "Referenz zu kurz");
  assert.ok(Math.abs(fx.lat - FP.fwi.lat) < 1.5, "Referenzbreite passt zur Tabellenzeile 30–90° N");
  let ffmc = fx.start.ffmc, dmc = fx.start.dmc, dc = fx.start.dc;
  const max = { ffmc: 0, dmc: 0, dc: 0, isi: 0, bui: 0, fwi: 0 };
  for (const x of fx.days) {
    ffmc = FH.ffmcStep(x.t, x.r, x.w, x.h, ffmc);
    dmc = FH.dmcStep(x.t, x.r, x.h, x.month, FP, dmc);
    dc = FH.dcStep(x.t, x.r, x.month, FP, dc);
    const got = { ffmc, dmc, dc, isi: FH.isiOf(x.w, ffmc), bui: FH.buiOf(dmc, dc), fwi: 0 };
    got.fwi = FH.fwiOf(got.isi, got.bui);
    for (const k of Object.keys(max)) max[k] = Math.max(max[k], Math.abs(got[k] - x[k]));
  }
  // Erwartung: identische Gleichungen -> nur Gleitkomma-Rundung (< 1e-9 absolut).
  for (const [k, v] of Object.entries(max)) assert.ok(v < 1e-9, `${k}: Abweichung ${v.toExponential(3)} zu groß`);
  console.log("   FWI gegen xclim, max. abs. Abweichung über 150 Tage:",
    Object.entries(max).map(([k, v]) => `${k} ${v.toExponential(2)}`).join(", "));
});

test("FWI-Teilgleichungen: Grenzfälle (Regen unter Schwelle, Frost, Windstille)", () => {
  const FP = params();
  // Regen <= 0,5 mm ändert den FFMC-Regenteil nicht (Van Wagner Gl. 2)
  assert.equal(FH.ffmcStep(20, 0.5, 10, 50, 85), FH.ffmcStep(20, 0, 10, 50, 85));
  // Regen <= 1,5 mm ohne Wirkung auf DMC (Gl. 11), <= 2,8 mm ohne Wirkung auf DC (Gl. 18)
  assert.equal(FH.dmcStep(20, 1.5, 50, 7, FP, 30), FH.dmcStep(20, 0, 50, 7, FP, 30));
  assert.equal(FH.dcStep(20, 2.8, 7, FP, 200), FH.dcStep(20, 0, 7, FP, 200));
  // Frost: DMC-Trocknung 0 unter -1,1 °C, DC-Temperatur auf -2,8 °C begrenzt
  assert.equal(FH.dmcStep(-5, 0, 50, 7, FP, 30), 30);
  assert.equal(FH.dcStep(-10, 0, 7, FP, 100), FH.dcStep(-2.8, 0, 7, FP, 100));
  // Windstille: ISI nur aus dem FFMC
  assert.ok(FH.isiOf(0, 90) > 0 && FH.isiOf(20, 90) > FH.isiOf(0, 90));
  // BUI/FWI = 0, wenn kein Brennstoffspeicher
  assert.equal(FH.buiOf(0, 0), 0);
  assert.equal(FH.fwiOf(0, 0), 0);
});

test("FWI-Startwerte: Einfluss bei 60 Tagen Vorlauf (beziffert)", () => {
  const FP = params();
  const hist = SZ.make("trocken");
  const a = FH.compute({ hist, now: SZ.NOW, FP });
  const b = FH.compute({ hist, now: SZ.NOW, FP, start: { ffmc: 60, dmc: 60, dc: 150 } });
  const dFFMC = Math.abs(a.fwi.last.ffmc - b.fwi.last.ffmc);
  const dDMC = Math.abs(a.fwi.last.dmc - b.fwi.last.dmc);
  const dDC = Math.abs(a.fwi.last.dc - b.fwi.last.dc);
  console.log(`   Startwerte (85/6/15) gegen (60/60/150) nach 60 Tagen: ΔFFMC ${dFFMC.toExponential(2)}, ΔDMC ${dDMC.toFixed(2)}, ΔDC ${dDC.toFixed(1)}`);
  assert.ok(dFFMC < 0.01, "FFMC muss nach 60 Tagen unabhängig vom Startwert sein");
  assert.ok(dDMC < 15, `DMC-Rest ${dDMC}`);
  // DC ist ein Summenspeicher: der Startwert bleibt in trockenen Perioden nahezu erhalten.
  assert.ok(dDC > 50, "DC behält die Erinnerung an den Startwert (dokumentierte Annahme)");
});

// ================================================================== 2. Gleichgewichts- und Brennstofffeuchte
test("Gleichgewichtsfeuchte (Simard 1968): identisch zu js/model.js, monoton in rF", () => {
  for (const [t, h] of [[5, 95], [15, 60], [20, 45], [25, 30], [30, 8], [0, 100]]) {
    assert.ok(Math.abs(FH.equilibriumMoisture(t, h) - FireModel.equilibriumMoisture(t, h)) < 1e-12, `${t}/${h}`);
  }
  let prev = -1;
  for (let h = 5; h <= 100; h += 5) {
    const v = FH.equilibriumMoisture(20, h);
    assert.ok(v > prev, `nicht monoton bei rF ${h}`);
    prev = v;
  }
  assert.ok(FH.equilibriumMoisture(30, 20) < FH.equilibriumMoisture(15, 80));
});

test("Fortschreibung: Zeitkonstanten 1/10/100 h (63 % nach tau, 95 % nach 3 tau)", () => {
  const FP = params();
  // konstante Bedingungen -> EMC konstant; Start deutlich darüber
  const t0 = Date.UTC(2026, 6, 1, 0);
  const rows = Array.from({ length: 401 }, (_, k) => ({ t: t0 + k * HOUR, tempC: 25, rh: 30, precipMm: 0 }));
  const emc = FH.equilibriumMoisture(25, 30);
  const start = { d1: 30, d10: 30, d100: 30 };
  const r = FH.deadMoistureSeries(rows, FP, start);
  const frac = (k, key) => 1 - (r.series[k][key] - emc) / (30 - emc);
  for (const [key, tau] of [["d1", 1], ["d10", 10], ["d100", 100]]) {
    assert.ok(Math.abs(frac(tau, key) - (1 - Math.exp(-1))) < 0.01, `${key}: nach tau ${frac(tau, key)}`);
    assert.ok(Math.abs(frac(3 * tau, key) - (1 - Math.exp(-3))) < 0.01, `${key}: nach 3 tau`);
  }
  // Endzustand = EMC (untere Schranke beachten)
  assert.ok(Math.abs(r.last.d1 - Math.max(FP.tote.min, emc)) < 0.01);
  // Trägheit: 100 h reagiert am langsamsten
  assert.ok(r.series[24].d100 > r.series[24].d10 && r.series[24].d10 > r.series[24].d1);
});

test("Regenbenetzung: Anstieg, Sättigungsgrenze, Abtrocknung danach", () => {
  const FP = params();
  const t0 = Date.UTC(2026, 6, 1, 0);
  const rows = [];
  for (let k = 0; k < 240; k++) {
    const rain = k >= 24 && k < 30 ? 4 : 0; // 6 Stunden à 4 mm = 24 mm
    rows.push({ t: t0 + k * HOUR, tempC: rain ? 14 : 26, rh: rain ? 95 : 35, precipMm: rain });
  }
  const r = FH.deadMoistureSeries(rows, FP, { d1: 8, d10: 9, d100: 10 });
  const vor = r.series[23], nass = r.series[29], spaeter = r.series[239];
  assert.ok(nass.d1 > vor.d1 + 10, `1 h nach Regen ${nass.d1}`);
  assert.ok(nass.d1 <= FP.tote.klassen.d1.sat + 1e-9, "Sättigung 1 h eingehalten");
  assert.ok(nass.d10 <= FP.tote.klassen.d10.sat + 1e-9 && nass.d100 <= FP.tote.klassen.d100.sat + 1e-9);
  assert.ok(nass.d100 > vor.d100, "auch die 100-h-Klasse wird benetzt");
  assert.ok(spaeter.d1 < vor.d1 + 0.5, "1 h trocknet nach 9 Tagen wieder ab");
  assert.ok(spaeter.d100 > spaeter.d1, "100 h bleibt länger feucht");
  // Regen unter der Schwelle bleibt wirkungslos (gleiche Temperatur/Feuchte in beiden Reihen,
  // damit allein die Benetzung verglichen wird)
  const konst = (p) => Array.from({ length: 48 }, (_, k) => ({ t: t0 + k * HOUR, tempC: 26, rh: 35, precipMm: k >= 24 && k < 30 ? p : 0 }));
  const ohne = FH.deadMoistureSeries(konst(0), FP, { d1: 8, d10: 9, d100: 10 }).series[29].d1;
  const spur = FH.deadMoistureSeries(konst(FP.tote.regenSchwelleMm * 0.5), FP, { d1: 8, d10: 9, d100: 10 }).series[29].d1;
  const echt = FH.deadMoistureSeries(konst(2), FP, { d1: 8, d10: 9, d100: 10 }).series[29].d1;
  assert.equal(spur, ohne, "Spurenregen (< Schwelle) benetzt nicht");
  assert.ok(echt > ohne + 5, "2 mm/h benetzen deutlich");
});

test("FFMC-Feuchte als unabhängige Gegenprobe zur 1-h-Klasse", () => {
  // Van Wagner (1987) Gl. 1 umgestellt; nur Plausibilität, keine Gleichheit erwartet.
  assert.ok(Math.abs(FH.ffmcMoisture(85) - 16.3) < 0.5, FH.ffmcMoisture(85));
  assert.ok(FH.ffmcMoisture(95) < FH.ffmcMoisture(85));
  const st = FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP: params() });
  assert.ok(Math.abs(st.ffmcFeuchte - st.dead.current.d1) < 6,
    `FFMC-Feuchte ${st.ffmcFeuchte.toFixed(1)} % gegen 1-h-Klasse ${st.dead.current.d1.toFixed(1)} %`);
});

// ================================================================== 3. Lebende Feuchte (Annahme)
test("Lebendfeuchte: Jahreszeit und Dürre-Abschlag, Untergrenzen", () => {
  const FP = params();
  const jan = FH.liveMoisture(Date.UTC(2026, 0, 15, 12), 50, FP);
  const jun = FH.liveMoisture(Date.UTC(2026, 5, 15, 12), 50, FP);
  const aug = FH.liveMoisture(Date.UTC(2026, 7, 15, 12), 50, FP);
  assert.ok(jun.lh > aug.lh && aug.lh > jan.lh, "Jahresgang Kraut");
  const trocken = FH.liveMoisture(Date.UTC(2026, 5, 15, 12), 800, FP);
  assert.ok(trocken.lh < jun.lh, "Dürre senkt die Krautfeuchte");
  assert.ok(trocken.lh >= FP.lebend.krautMin && trocken.lw >= FP.lebend.gehoelzMin, "Untergrenzen eingehalten");
  assert.equal(FH.liveMoisture(Date.UTC(2026, 5, 15, 12), FP.lebend.dcStart - 1, FP).duerreAnteil, 0);
  assert.equal(FH.liveMoisture(Date.UTC(2026, 5, 15, 12), FP.lebend.dcVoll + 100, FP).duerreAnteil, 1);
});

// ================================================================== 4. Mittagswerte, Lokalzeit
test("Mittagswerte: 12 Uhr Lokalzeit, Sommer- und Winterzeit, 24-h-Regensumme", () => {
  const FP = params();
  // Sommerzeit (MESZ = UTC+2): 12 Uhr lokal = 10 Uhr UTC
  assert.equal(FH.tzOffsetMin(Date.UTC(2026, 6, 1, 12), "Europe/Berlin"), 120);
  // Winterzeit (MEZ = UTC+1)
  assert.equal(FH.tzOffsetMin(Date.UTC(2026, 11, 1, 12), "Europe/Berlin"), 60);
  const t0 = Date.UTC(2026, 6, 1, 0);
  const rows = Array.from({ length: 72 }, (_, k) => ({ t: t0 + k * HOUR, tempC: 20, rh: 50, precipMm: 1, windKmh: 10 }));
  const d = FH.dailyNoon(rows, FP);
  assert.ok(d.length >= 2, `${d.length} Mittagswerte`);
  for (const x of d) {
    const p = FH.localParts(x.tMid, FP.abruf.zeitzone);
    assert.equal(p.hour, 12, "Mittagswert liegt auf 12 Uhr Lokalzeit");
  }
  const voll = d.find((x) => x.stundenRegen === 24);
  assert.ok(voll && Math.abs(voll.r24 - 24) < 1e-9, "24-h-Summe = 24 Stunden à 1 mm");
});

// ================================================================== 5. Kennzahlen und Ampel
test("Kennzahlen: Tage seit Regen, Summen 7/30/60, Trockenstrecke", () => {
  const FP = params();
  const st = FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP });
  const S = st.stats;
  assert.equal(S.tageSeitRegen[1].tage, 46);
  assert.equal(S.tageSeitRegen[5].tage, 50);
  assert.ok(S.summen[7].mm === 0 && S.summen[30].mm === 0 && S.summen[60].mm > 20);
  assert.ok(S.maxTrockenstrecke >= 45);
  const nass = FH.compute({ hist: SZ.make("nass"), now: SZ.NOW, FP });
  assert.ok(nass.stats.tageSeitRegen[1].tage <= 3 && nass.stats.summen[30].mm > 50);
});

test("Trockenheitsampel: FWI-Klassen (EFFIS-Grenzen, zu prüfen) und Dreistufung", () => {
  const FP = params();
  const lvl = (fwi) => FH.droughtLevel({ fwi, bui: 50, dc: 300 }, null, FP);
  assert.equal(lvl(2).klasse, 0);
  assert.equal(lvl(8).klasse, 1);
  assert.equal(lvl(15).klasse, 2);
  assert.equal(lvl(30).klasse, 3);
  assert.equal(lvl(45).klasse, 4);
  assert.equal(lvl(60).klasse, 5);
  assert.equal(lvl(2).ampel, "gruen");
  assert.equal(lvl(15).ampel, "gelb");
  assert.equal(lvl(30).ampel, "rot");
  assert.match(lvl(30).quelle, /zu prüfen/);
  assert.equal(FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP }).level.ampel, "rot");
  assert.equal(FH.compute({ hist: SZ.make("nass"), now: SZ.NOW, FP }).level.ampel, "gruen");
});

// ================================================================== 6. Abruf: Mock, Cache, Fallback
test("Abruf-URL: past_days aus der Doku belegt (max. 92), Archiv-Host und Verzögerung", () => {
  const FP = params();
  const u = FH.buildForecastUrl(50.853, 7.334, FP, {});
  assert.match(u.url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(u.url, /past_days=60/);
  assert.match(u.url, /latitude=50\.85&longitude=7\.33/, "Koordinaten auf ca. 1 km gerundet");
  assert.match(u.url, /hourly=temperature_2m%2Crelative_humidity_2m%2Cprecipitation%2Cwind_speed_10m/);
  assert.match(u.url, /timezone=GMT/);
  assert.equal(FH.buildForecastUrl(50.85, 7.33, FP, { pastDays: 200 }).pastDays, 92, "auf den belegten Höchstwert begrenzt");
  assert.equal(FH.buildForecastUrl(50.85, 7.33, FP, { pastDays: 5 }).pastDays, 30, "Mindestzeitraum 30 Tage");
  const a = FH.buildArchiveUrl(50.85, 7.33, FP, { now: Date.UTC(2026, 7, 15), pastDays: 60 });
  assert.match(a.url, /^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/);
  assert.equal(a.end, "2026-08-10", "ERA5-Verzögerung von 5 Tagen berücksichtigt");
  assert.equal(a.start, "2026-06-12");
});

test("Abruf mit Mock (Open-Meteo in der Entwicklungsumgebung gesperrt)", async () => {
  const FP = params();
  const hist = SZ.make("trocken", { days: 2 });
  let calledUrl = null;
  const mock = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      json: async () => ({
        latitude: 50.85, longitude: 7.33, utc_offset_seconds: 0,
        hourly: {
          time: hist.rows.map((r) => new Date(r.t).toISOString().slice(0, 16)),
          temperature_2m: hist.rows.map((r) => r.tempC),
          relative_humidity_2m: hist.rows.map((r) => r.rh),
          precipitation: hist.rows.map((r) => r.precipMm),
          wind_speed_10m: hist.rows.map((r) => r.windKmh),
        },
      }),
    };
  };
  const out = await FH.fetchHistory({ lat: 50.85, lon: 7.33, FP, fetchImpl: mock, pastDays: 60, now: SZ.NOW });
  assert.match(calledUrl, /past_days=60/);
  assert.equal(out.rows.length, hist.rows.length);
  assert.equal(out.kind, "forecast");
  assert.match(out.attribution, /CC BY 4\.0/);
  assert.ok(Math.abs(out.rows[0].tempC - hist.rows[0].tempC) < 1e-9);
  // HTTP-Fehler und kaputtes Format werden als Fehler gemeldet
  await assert.rejects(() => FH.fetchHistory({ lat: 50.85, lon: 7.33, FP, fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(() => FH.fetchHistory({ lat: 50.85, lon: 7.33, FP, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /Antwortformat/);
});

test("Cache: speichern/lesen, Alter, gesperrter localStorage wird abgefangen", () => {
  const FP = params();
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const hist = { ...SZ.make("nass", { days: 3 }), kind: "forecast", source: "Mock" };
  const r = FH.saveCache(store, FP, hist, 50.85, 7.33, 60);
  assert.ok(r.ok && !r.reduced);
  const back = FH.loadCache(store, FP, 50.85, 7.33, 60, hist.fetchedAt + 2 * HOUR);
  assert.ok(back && back.rows.length === hist.rows.length);
  assert.ok(Math.abs(back.ageH - 2) < 1e-6 && !back.stale);
  assert.ok(FH.loadCache(store, FP, 50.85, 7.33, 60, hist.fetchedAt + 20 * HOUR).stale);
  assert.ok(FH.loadCache(store, FP, 50.85, 7.33, 60, hist.fetchedAt + 60 * HOUR).tooOld);
  // anderer Ort -> kein Treffer
  assert.equal(FH.loadCache(store, FP, 51.5, 7.33, 60, hist.fetchedAt), null);
  // gesperrter Speicher (z. B. privater Modus): kein Absturz
  const broken = { getItem: () => { throw new Error("blockiert"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.equal(FH.loadCache(broken, FP, 50.85, 7.33, 60, Date.now()), null);
  assert.equal(FH.saveCache(broken, FP, hist, 50.85, 7.33, 60).ok, false);
  // defekter Inhalt
  mem.set(FH.cacheKey(FP, 50.85, 7.33, 60), "{kein json");
  assert.equal(FH.loadCache(store, FP, 50.85, 7.33, 60, Date.now()), null);
  // Platzgrenze -> reduzierte Speicherung
  const small = params({ abruf: { cacheMaxBytes: 500 } });
  assert.equal(FH.saveCache(store, small, hist, 50.85, 7.33, 60).reduced, true);
});

test("Fallback ohne Vorgeschichte: Warnung, keine Dürrewerte, breiteres Ensemble", () => {
  const FP = params();
  const w = { t: SZ.NOW, tempC: 29, rh: 32, rain24: 0, rain72: 0 };
  const st = FH.compute({ hist: null, now: SZ.NOW, FP, legacy: legacyOf(w) });
  assert.equal(st.active, false);
  assert.equal(st.kind, "fallback");
  assert.match(st.warnings.join(" "), /Keine Wettervorgeschichte/);
  assert.equal(st.coupling.active, false);
  assert.equal(st.coupling.moisture, null);
  assert.equal(FH.baseMoistureForHours(st, [w], FP), null, "keine Basisfeuchte -> Modell rechnet wie bisher");
});

test("Manuelle Ersatzeingabe: Kennzahlen treffen die Eingabe", () => {
  const FP = params();
  const manual = { tageSeitRegen1mm: 18, tageSeitRegen5mm: 25, regen7Tage: 0, regen30Tage: 12, tempC: 27, rh: 38 };
  const hist = FH.manualHistory(manual, { FP, now: SZ.NOW, pastDays: 60 });
  assert.equal(hist.kind, "manuell");
  assert.match(hist.source, /MANUELLE ERSATZEINGABE/);
  const st = FH.compute({ hist, now: SZ.NOW, FP, legacy: legacyOf({ tempC: 27, rh: 38 }) });
  assert.ok(st.active);
  assert.ok(Math.abs(st.stats.tageSeitRegen[1].tage - manual.tageSeitRegen1mm) <= 1, `Tage seit 1 mm: ${st.stats.tageSeitRegen[1].tage}`);
  assert.ok(Math.abs(st.stats.tageSeitRegen[5].tage - manual.tageSeitRegen5mm) <= 1, `Tage seit 5 mm: ${st.stats.tageSeitRegen[5].tage}`);
  assert.equal(st.stats.summen[7].mm, 0);
  assert.ok(Math.abs(st.stats.summen[30].mm - manual.regen30Tage) < 1.5, `Summe 30 Tage ${st.stats.summen[30].mm}`);
  assert.ok(st.coupling.ensembleFaktor >= FP.kopplung.ensemble.manuellFaktor, "breiteres Ensemble bei Ersatzeingabe");
});

test("load(): Cache-Treffer, Abrufausfall mit Cache, Abrufausfall ohne Cache mit Ersatzeingabe", async () => {
  const FP = params();
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const hist = SZ.make("trocken");
  const ok = async () => ({ ok: true, json: async () => ({ latitude: 50.85, longitude: 7.33, hourly: {
    time: hist.rows.map((r) => new Date(r.t).toISOString().slice(0, 16)),
    temperature_2m: hist.rows.map((r) => r.tempC), relative_humidity_2m: hist.rows.map((r) => r.rh),
    precipitation: hist.rows.map((r) => r.precipMm), wind_speed_10m: hist.rows.map((r) => r.windKmh) } }) });
  const fail = async () => { throw new Error("Netzwerk gesperrt"); };
  const a = await FH.load({ lat: 50.85, lon: 7.33, FP, store, fetchImpl: ok, now: SZ.NOW });
  assert.ok(a.active && a.kind === "forecast");
  const b = await FH.load({ lat: 50.85, lon: 7.33, FP, store, fetchImpl: fail, now: SZ.NOW + HOUR });
  assert.ok(b.active, "Cache-Treffer trotz Abrufausfall");
  const c = await FH.load({ lat: 51.9, lon: 7.33, FP, store, fetchImpl: fail, now: SZ.NOW, manual: { tageSeitRegen1mm: 10, regen7Tage: 0, regen30Tage: 5 } });
  assert.equal(c.kind, "manuell");
  assert.match(c.notes.join(" "), /Abruf gescheitert/);
  const d = await FH.load({ lat: 52.9, lon: 7.33, FP, store, fetchImpl: fail, now: SZ.NOW });
  assert.equal(d.active, false);
});

// ================================================================== 7. Kopplung
test("Kopplung: Begrenzung gegenüber der bisherigen Herleitung greift", () => {
  const FP = params();
  const legacy = { d1: 6.11, d10: 7.11, d100: 8.11, lh: 90, lw: 120 };
  const st = FH.compute({ hist: SZ.make("nass"), now: SZ.NOW, FP, legacy });
  const cf = st.coupling;
  for (const k of ["d1", "d10", "d100"]) {
    assert.ok(Math.abs(cf.moisture[k] - legacy[k]) <= FP.kopplung.maxAbweichungPct[k] + 1e-9,
      `${k} ${cf.moisture[k]} gegen ${legacy[k]}`);
  }
  assert.ok(cf.begrenzt.length > 0, "Begrenzung wird gemeldet");
  // Dürre-Faktoren sind gedeckelt
  const trocken = FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP, legacy }).coupling;
  assert.ok(trocken.duerreAnteil === 1);
  assert.ok(trocken.irFaktor <= FP.kopplung.duerre.maxIrFaktor + 1e-9);
  assert.ok(trocken.ensembleFaktor <= FP.kopplung.ensemble.maxFaktor + 1e-9);
  assert.ok(trocken.curingAnteil <= FP.lebend.curingMax + 1e-9);
  assert.ok(trocken.irFaktor > 1 && trocken.ensembleFaktor > 1);
});

test("Kopplung: Modus \"brennstoffmenge\" skaliert Beladungen statt der Rate", () => {
  const FPa = params({ kopplung: { modus: "brennstoffmenge" } });
  const cf = FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP: FPa }).coupling;
  assert.equal(cf.irFaktor, 1);
  assert.ok(cf.last.w10 > 1 && cf.last.w10 <= FPa.kopplung.duerre.maxLastFaktor + 1e-9);
  const P = FH.adaptParams(P0, cf, cf.moisture);
  assert.ok(P.fuelModels[10].w[1] > P0.fuelModels[10].w[1]);
  assert.equal(P.fuelModels[10].depth, P0.fuelModels[10].depth, "Tiefe bleibt unverändert");
});

test("Adapter: erzeugt genau die Basisfeuchten der Vorgeschichte (Prüfung gegen FireModel.deadMoisture)", () => {
  const FP = params();
  const w = { t: SZ.NOW, tempC: 29, rh: 32, precipMm: 0, rain24: 0, rain72: 0 };
  const legacy = legacyOf(w);
  const st = FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP, legacy });
  const m = FH.baseMoistureForHours(st, [w], FP, legacy)[0];
  const P = FH.adaptParams(P0, st.coupling, m);
  const back = FireModel.deadMoisture(w, P.moisture);
  for (const k of ["d1", "d10", "d100"]) assert.ok(Math.abs(back[k] - m[k]) < 1e-9, `${k}: ${back[k]} statt ${m[k]}`);
  assert.equal(P.moisture.liveHerb, st.coupling.moisture.lh);
  // Reaktionsintensität: Beladungen UND Tiefe skaliert -> Packungsdichte unverändert
  const b0 = FireModel.rothermel(P0.fuelModels[8], { d1: 0.08, d10: 0.08, d100: 0.08, lh: 1, lw: 1 }, 0, 0, P0.tonPerAcreToLbFt2);
  const b1 = FireModel.rothermel(P.fuelModels[8], { d1: 0.08, d10: 0.08, d100: 0.08, lh: 1, lw: 1 }, 0, 0, P0.tonPerAcreToLbFt2);
  assert.ok(Math.abs(b1.beta - b0.beta) < 1e-9, "Packungsdichte unverändert");
  assert.ok(Math.abs(b1.R0 / b0.R0 - st.coupling.irFaktor) < 1e-6, `Rate skaliert mit ${st.coupling.irFaktor}`);
});

// ================================================================== 8. Wirkung auf die Ausbreitung
function synthRun(P, moist, hours, opts = {}) {
  const g = Grid.makeGrid(50.85, 7.33, opts.halfM || 1200, 25, CL);
  g.fuel.fill(CL.indexOf(opts.cls || "mischwald"));
  const ign = Int32Array.from([Math.floor(g.ny / 2) * g.nx + Math.floor(g.nx / 2)]);
  return { g, ign, hours, P, moist };
}
async function ensemble(r, horizons = [2, 6]) {
  const res = await FireModel.runEnsemble({ grid: r.g, classList: CL, ignition: r.ign, weatherHours: r.hours, P: r.P, horizonsH: horizons, terrain: false, runs: 12 });
  return { res, m: FireModel.metrics(res, r.g, r.ign, r.P) };
}
const headRos = (P, cls, moist, windKmh) => {
  const c = P0.fuelClasses[cls];
  return FireModel.rothermel(P.fuelModels[c.model],
    { d1: moist.d1 / 100, d10: moist.d10 / 100, d100: moist.d100 / 100, lh: P.moisture.liveHerb / 100, lw: P.moisture.liveWoody / 100 },
    windKmh * P0.waf[c.waf] * 54.6807, 0, P0.tonPerAcreToLbFt2).R * 0.3048;
};

test("60 Tage trocken gegen nass: bezifferter Unterschied in der Ausbreitung", async () => {
  const FP = params();
  const hours = SZ.forecastHours(7);
  const legacy = legacyOf(hours[0]);
  const out = {};
  for (const kind of ["trocken", "nass"]) {
    const st = FH.compute({ hist: SZ.make(kind), now: SZ.NOW, FP, legacy });
    const m = FH.baseMoistureForHours(st, hours, FP, legacy)[0];
    const P = FH.adaptParams(P0, st.coupling, m);
    const r = await ensemble(synthRun(P, m, hours));
    out[kind] = {
      st, m, P,
      ha2: r.m.perH[0].refHa, ha6: r.m.perH[1].refHa, moegl6: r.m.perH[1].possibleHa,
      rosWald: headRos(P, "mischwald", m, hours[0].windKmh),
      rosGras: headRos(P, "gruenland", m, hours[0].windKmh),
    };
  }
  const t = out.trocken, n = out.nass;
  console.log(`   trocken: 1h ${t.m.d1.toFixed(1)} / 10h ${t.m.d10.toFixed(1)} / 100h ${t.m.d100.toFixed(1)} %, FWI ${t.st.fwi.last.fwi.toFixed(1)}, BUI ${t.st.fwi.last.bui.toFixed(0)}`);
  console.log(`   nass:    1h ${n.m.d1.toFixed(1)} / 10h ${n.m.d10.toFixed(1)} / 100h ${n.m.d100.toFixed(1)} %, FWI ${n.st.fwi.last.fwi.toFixed(1)}, BUI ${n.st.fwi.last.bui.toFixed(0)}`);
  console.log(`   Kopffeuerrate Mischwald ${t.rosWald.toFixed(3)} gegen ${n.rosWald.toFixed(3)} m/min (× ${(t.rosWald / n.rosWald).toFixed(2)}), `
    + `Grünland ${t.rosGras.toFixed(2)} gegen ${n.rosGras.toFixed(2)} m/min (× ${(t.rosGras / n.rosGras).toFixed(2)})`);
  console.log(`   Fläche Referenz 2 h ${t.ha2.toFixed(2)} gegen ${n.ha2.toFixed(2)} ha, 6 h ${t.ha6.toFixed(2)} gegen ${n.ha6.toFixed(2)} ha (× ${(t.ha6 / n.ha6).toFixed(2)}), `
    + `"möglich" 6 h ${t.moegl6.toFixed(2)} gegen ${n.moegl6.toFixed(2)} ha`);
  assert.ok(t.rosWald > n.rosWald * 1.2, "trocken deutlich schneller (Wald)");
  assert.ok(t.ha6 > n.ha6 * 1.3, "trocken deutlich größere Fläche nach 6 h");
  assert.ok(t.moegl6 > n.moegl6, "breiteres Band bei Dürre");
  // Begrenzung: kein unplausibler Sprung
  const f = t.rosWald / n.rosWald;
  const [lo, hi] = FP.kopplung.plausibelRateFaktor;
  assert.ok(f > lo && f < hi, `Ratenverhältnis ${f} außerhalb ${lo}…${hi}`);
  // Vergleich gegen die bisherige Herleitung: beide Richtungen begrenzt
  const rosAlt = headRos(P0, "mischwald", legacy, hours[0].windKmh);
  for (const [k, v] of [["trocken", t.rosWald], ["nass", n.rosWald]]) {
    const q = v / rosAlt;
    assert.ok(q > lo && q < hi, `${k}: Verhältnis zur bisherigen Rechnung ${q}`);
    console.log(`   Verhältnis zur bisherigen Herleitung (${k}): × ${q.toFixed(2)}`);
  }
});

test("Schalter aus: Ergebnis entspricht exakt dem bisherigen Verhalten", async () => {
  const FP = params();
  const hours = SZ.forecastHours(7);
  const legacy = legacyOf(hours[0]);
  const st = FH.compute({ hist: SZ.make("trocken"), now: SZ.NOW, FP, enabled: false, legacy });
  assert.equal(st.active, false);
  assert.equal(st.coupling.active, false);
  assert.equal(FH.baseMoistureForHours(st, hours, FP, legacy), null);
  // adaptParams verändert die Parameter nicht, wenn die Kopplung aus ist
  assert.equal(JSON.stringify(FH.adaptParams(P0, st.coupling, null)), JSON.stringify(P0));
  // und die Rechnung ist bitgenau gleich
  const a = await ensemble(synthRun(P0, legacy, hours));
  const b = await ensemble(synthRun(FH.adaptParams(P0, st.coupling, null), legacy, hours));
  assert.deepEqual(Array.from(a.res.reference), Array.from(b.res.reference));
  assert.deepEqual(a.m.perH, b.m.perH);
  assert.equal(a.res.earliest.length, b.res.earliest.length);
  for (let i = 0; i < a.res.earliest.length; i++) assert.equal(a.res.earliest[i], b.res.earliest[i]);
});

// ================================================================== 9. Determinismus und Robustheit
test("Determinismus: gleiche Eingabe -> bitgleiche Ausgabe", () => {
  const FP = params();
  const hist = SZ.make("trocken");
  const a = FH.compute({ hist, now: SZ.NOW, FP });
  const b = FH.compute({ hist: JSON.parse(JSON.stringify(hist)), now: SZ.NOW, FP });
  const strip = (s) => JSON.stringify({ dead: s.dead.current, fwi: s.fwi.last, stats: s.stats, live: s.live, level: s.level, coupling: s.coupling });
  assert.equal(strip(a), strip(b));
  // auch die Stundenreihe
  assert.deepEqual(a.dead.series.map((x) => x.d1), b.dead.series.map((x) => x.d1));
  // Szenariogenerator selbst ist deterministisch
  assert.deepEqual(SZ.make("nass").rows.slice(0, 50), SZ.make("nass").rows.slice(0, 50));
});

test("Robustheit: Lücken in der Reihe, kurze Reihe, unsinnige Werte", () => {
  const FP = params();
  const hist = SZ.make("trocken");
  // jede 50. Stunde ohne Messwerte
  const luecken = { ...hist, rows: hist.rows.map((r, k) => (k % 50 === 0 ? { ...r, tempC: null, rh: null } : r)) };
  const st = FH.compute({ hist: luecken, now: SZ.NOW, FP });
  assert.ok(st.active);
  assert.ok(st.dead.gaps > 0 && st.warnings.some((w) => /ohne Temperatur/.test(w)));
  assert.ok(Number.isFinite(st.fwi.last.fwi));
  // zu kurze Reihe -> kein aktiver Zustand
  const kurz = { ...hist, rows: hist.rows.slice(-10) };
  assert.equal(FH.compute({ hist: kurz, now: SZ.NOW, FP }).active, false);
  // extreme, aber endliche Werte bleiben in den Schranken
  const extrem = { ...hist, rows: hist.rows.map((r) => ({ ...r, tempC: 45, rh: 1, precipMm: 0 })) };
  const se = FH.compute({ hist: extrem, now: SZ.NOW, FP });
  for (const k of ["d1", "d10", "d100"]) {
    assert.ok(se.dead.current[k] >= FP.tote.min - 1e-9 && se.dead.current[k] <= FP.tote.max + 1e-9, `${k} ${se.dead.current[k]}`);
  }
  assert.ok(se.fwi.last.ffmc <= 101 && se.fwi.last.fwi >= 0);
});

test("Parameterdatei: Version, Vorgaben des Auftraggebers, keine Fremdabhängigkeit", () => {
  assert.match(FP0.version, /^\d+\.\d+\.\d+/);
  assert.equal(FP0.abruf.pastDaysDefault, 60);
  assert.equal(FP0.abruf.pastDaysMin, 30);
  assert.equal(FP0.abruf.hervorhebenTage, 7);
  assert.deepEqual(FP0.ampel.regenSchwellenMm, [1, 5]);
  assert.deepEqual(FP0.ampel.summenTage, [7, 30, 60]);
  // keine absoluten eigenen Pfade, keine CDN-Verweise in den Moduldateien
  for (const f of ["js/fuelhistory.js", "js/fuelhistory-ui.js", "js/fuelhistory-params.js", "css/fuelhistory.css"]) {
    const t = fs.readFileSync(path.join(HERE, "..", f), "utf8");
    assert.ok(!/cdn\.|unpkg\.com|jsdelivr/.test(t), `${f}: CDN-Verweis`);
    assert.ok(!/\bimport\s+.*\bfrom\b/.test(t), `${f}: ES-Import (klassische Skripte erwartet)`);
    assert.ok(!/fetch\(\s*["'`]\//.test(t) && !/url\(\s*["']?\//.test(t), `${f}: absoluter Pfad`);
  }
  // Open-Meteo-Hosts stehen nur in der Parameterdatei (eine Stelle zum Ändern)
  const core = fs.readFileSync(path.join(HERE, "../js/fuelhistory.js"), "utf8");
  assert.ok(!/https:\/\/(api|archive-api)\.open-meteo\.com/.test(core), "Hosts gehören in die Parameterdatei");
});

// ================================================================== 10. Schnittstelle zu js/model.js (Integration 0.9.0)
// Seit 0.9.0 nimmt FireModel.runEnsemble die Basisfeuchte je Stunde (input.moistureSeries, in %) und
// die Dürre-Faktoren (input.drought) direkt entgegen; der Adapter adaptParams() wird dafür nicht mehr
// gebraucht. Ohne diese Felder muss die Rechnung bitgenau die bisherige sein.
const terrainGridFH = () => {
  const g = Grid.makeGrid(50.85, 7.33, 900, 25, CL);
  g.fuel.fill(CL.indexOf("mischwald"));
  g.elev = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const [x, y] = Grid.cellCenter(g, j * g.nx + i);
      g.elev[j * g.nx + i] = 200 + 0.12 * y + 20 * Math.sin(x / 300);
    }
  }
  Grid.terrain(g);
  return g;
};
const hoursFH = () => SZ.forecastHours(7);
const stateFH = (kind, FP, legacy) => FH.compute({ hist: SZ.make(kind), now: SZ.NOW, FP, legacy });

test("Modellschnittstelle: ohne moistureSeries/drought bitgenau wie bisher", async () => {
  const hours = hoursFH();
  const r = synthRun(P0, null, hours);
  const a = await FireModel.runEnsemble({ grid: r.g, classList: CL, ignition: r.ign, weatherHours: hours, P: P0, horizonsH: [2, 6], terrain: false, runs: 8 });
  const b = await FireModel.runEnsemble({ grid: r.g, classList: CL, ignition: r.ign, weatherHours: hours, P: P0, horizonsH: [2, 6], terrain: false, runs: 8, moistureSeries: null, drought: null });
  assert.deepEqual(Array.from(a.reference), Array.from(b.reference));
  assert.deepEqual(a.perturbations, b.perturbations, "Zufallsfolge unverändert");
  assert.equal(a.drought.active, false);
  assert.equal(a.drought.irFaktor, 1);
  assert.equal(a.drought.ensembleFaktor, 1);
});

test("Modellschnittstelle: irFaktor skaliert die Rate exakt (Rothermel: R ~ I_R)", () => {
  const hours = hoursFH();
  const pert = { dDir: 0, windFactor: 1, dMoist: 0 };
  const a = FireModel.precomputeRates(hours, CL, P0, pert);
  const b = FireModel.precomputeRates(hours, CL, P0, pert, { irFaktor: 1.2, moistureSeries: null });
  const c = CL.indexOf("mischwald");
  assert.ok(a.info[0].heads[c] > 0);
  assert.ok(Math.abs(b.info[0].heads[c] / a.info[0].heads[c] - 1.2) < 1e-9, `${b.info[0].heads[c] / a.info[0].heads[c]}`);
  // r0 ist eine Float32Array (ca. 7 gültige Stellen)
  assert.ok(Math.abs(b.r0[0][c] / a.r0[0][c] - 1.2) < 1e-6, `${b.r0[0][c] / a.r0[0][c]}`);
});

test("Modellschnittstelle: 60 Tage trocken gegen nass über runEnsemble (ohne Adapter)", async () => {
  const FP = params();
  const hours = hoursFH();
  const legacy = legacyOf(hours[0]);
  const out = {};
  for (const kind of ["trocken", "nass"]) {
    const st = stateFH(kind, FP, legacy);
    const ms = FH.baseMoistureForHours(st, hours, FP, legacy);
    assert.equal(ms.length, hours.length, "Basisfeuchte je Prognosestunde");
    const r = synthRun(P0, ms[0], hours);
    const res = await FireModel.runEnsemble({
      grid: r.g, classList: CL, ignition: r.ign, weatherHours: hours, P: P0, horizonsH: [2, 6],
      terrain: false, runs: 12, moistureSeries: ms, drought: st.coupling,
    });
    out[kind] = { st, res, m: FireModel.metrics(res, r.g, r.ign, P0) };
  }
  const t = out.trocken, n = out.nass;
  console.log(`   runEnsemble trocken/nass: Referenzfläche 6 h ${t.m.perH[1].refHa.toFixed(2)} gegen ${n.m.perH[1].refHa.toFixed(2)} ha`
    + ` (× ${(t.m.perH[1].refHa / n.m.perH[1].refHa).toFixed(2)}), Faktor I_R ${t.res.drought.irFaktor.toFixed(2)} gegen ${n.res.drought.irFaktor.toFixed(2)}`);
  assert.equal(t.res.drought.active, true);
  assert.ok(t.res.drought.irFaktor > n.res.drought.irFaktor, "Dürre erhöht die Reaktionsintensität");
  assert.ok(t.res.drought.irFaktor <= FP.kopplung.duerre.maxIrFaktor + 1e-9);
  assert.ok(t.m.perH[1].refHa > n.m.perH[1].refHa * 1.3, "trocken deutlich größere Fläche nach 6 h");
  assert.ok(t.m.perH[1].possibleHa > n.m.perH[1].possibleHa);
});

test("Modellschnittstelle: Ensemble-Spannweite wirkt nur auf die Streuung, nicht auf den Referenzlauf", async () => {
  const FP = params();
  const hours = hoursFH();
  const r = synthRun(P0, null, hours);
  const base = { grid: r.g, classList: CL, ignition: r.ign, weatherHours: hours, P: P0, horizonsH: [6], terrain: false, runs: 12 };
  const a = await FireModel.runEnsemble(base);
  const b = await FireModel.runEnsemble({ ...base, drought: { irFaktor: 1, ensembleFaktor: FP.kopplung.ensemble.fallbackFaktor } });
  assert.deepEqual(Array.from(a.reference), Array.from(b.reference), "Referenzlauf unverändert (dMoist = 0)");
  const fa = a.perturbations.map((p) => p.dMoist), fb = b.perturbations.map((p) => p.dMoist);
  for (let i = 0; i < fa.length; i++) assert.ok(Math.abs(fb[i] / fa[i] - FP.kopplung.ensemble.fallbackFaktor) < 1e-9, "Amplitude skaliert, Zufallsfolge gleich");
  const ma = FireModel.metrics(a, r.g, r.ign, P0), mb = FireModel.metrics(b, r.g, r.ign, P0);
  assert.ok(mb.perH[0].possibleHa >= ma.perH[0].possibleHa, `Band nicht schmaler (${mb.perH[0].possibleHa} gegen ${ma.perH[0].possibleHa})`);
});

test("Modellschnittstelle: Geländepfad (Feuchte nach Exposition) nutzt dieselbe Basisfeuchte", async () => {
  const FP = params();
  const hours = hoursFH();
  const legacy = legacyOf(hours[0]);
  const g = terrainGridFH();
  const ign = Int32Array.from([Math.floor(g.ny / 2) * g.nx + Math.floor(g.nx / 2)]);
  const res = {};
  for (const kind of ["trocken", "nass"]) {
    const st = stateFH(kind, FP, legacy);
    const ms = FH.baseMoistureForHours(st, hours, FP, legacy);
    const out = await FireModel.runEnsemble({
      grid: g, classList: CL, ignition: ign, weatherHours: hours, P: P0, horizonsH: [2, 6],
      terrain: { wind: true, moisture: true }, runs: 6, moistureSeries: ms, drought: st.coupling,
    });
    assert.equal(out.terrainWind.active, true, "Geländewind aktiv");
    res[kind] = FireModel.metrics(out, g, ign, P0).perH[1].refHa;
  }
  console.log(`   Geländepfad trocken/nass: Referenzfläche 6 h ${res.trocken.toFixed(2)} gegen ${res.nass.toFixed(2)} ha`);
  assert.ok(res.trocken > res.nass * 1.2, `trocken ${res.trocken} gegen nass ${res.nass}`);
});
