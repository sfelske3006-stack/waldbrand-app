/*
 * Synthetische Vorgeschichte-Szenarien für tests/fuelhistory.test.mjs und tests/e2e.mjs.
 * KEIN echtes Wetter: frei erfundene, deterministische Reihen (fester Seed), nur zum Prüfen
 * und Vorführen des Moduls. Die Datei liegt bewusst unter tests/ und NICHT unter js/
 * (tests/model.test.mjs verlangt für jede Datei in js/ einen Eintrag in der Loaderliste).
 *
 * Aufbau: Beide Szenarien haben denselben Tagesgang und dieselben letzten 24 Stunden
 * (warm, trocken, kein Regen). Sie unterscheiden sich NUR in der Vorgeschichte davor.
 * Damit zeigt der Vergleich ausschließlich die Wirkung der Vorgeschichte.
 */
(function (root) {
  "use strict";
  const HOUR = 3600000;
  // Fester Bezugszeitpunkt (Sommer, Monat 8) damit Jahreszeit-Annahmen und Tests reproduzierbar sind.
  const NOW = Date.UTC(2026, 7, 15, 12, 0, 0); // 15.08.2026, 12:00 UTC (= 14:00 Lokalzeit MESZ)

  // kleiner deterministischer Zufallsgenerator (mulberry32, wie js/model.js)
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * @param kind "trocken" | "nass"
   * @param opts {days, now}
   * @returns {rows, kind:"demo", source, fetchedAt, now}
   */
  function make(kind, opts = {}) {
    const days = opts.days || 60;
    const now = opts.now ?? NOW;
    const t0 = now - days * 24 * HOUR;
    const rand = rng(kind === "trocken" ? 4711 : 1234);
    const rows = [];
    // Regentage festlegen (Tagesindex 0 = ältester Tag)
    const rainDay = new Float64Array(days + 3);
    if (kind === "trocken") {
      // nasser Start, dann 45 Tage ohne nennenswerten Regen
      for (let d = 0; d < 12; d++) if (d % 3 === 0) rainDay[d] = 4 + 6 * rand();
      rainDay[13] = 1.2;
      rainDay[14] = 0.4; // Spur, unter 1 mm
    } else {
      // regelmäßiger Regen bis vor 2 Tagen
      for (let d = 0; d < days - 2; d++) if (d % 3 === 0) rainDay[d] = 5 + 8 * rand();
      rainDay[days - 3] = 9;
    }
    for (let k = 0; k <= days * 24 + 12; k++) {
      const t = t0 + k * HOUR;
      const d = Math.floor(k / 24);
      const h = new Date(t).getUTCHours();
      const diurnal = Math.sin(((h - 9) / 24) * 2 * Math.PI);
      const warm = kind === "trocken" ? 26 : 19;
      const rhBase = kind === "trocken" ? 48 : 72;
      // leichte Streuung, deterministisch
      const jitter = (rand() - 0.5) * 2;
      const tempC = warm + 7 * diurnal + jitter;
      let rh = rhBase - 22 * diurnal + jitter * 2;
      const rain = rainDay[d] > 0 && h >= 3 && h < 9 ? rainDay[d] / 6 : 0;
      if (rain > 0) rh = Math.min(99, rh + 20);
      rows.push({
        t, tempC: Math.round(tempC * 10) / 10,
        rh: Math.round(Math.max(12, Math.min(100, rh))),
        precipMm: Math.round(rain * 100) / 100,
        windKmh: 8 + 10 * Math.max(0, diurnal) + 4 * rand(),
      });
    }
    return {
      rows, kind: "demo", now,
      fetchedAt: now,
      source: `SYNTHETISCHES SZENARIO "${kind}" (fiktiv, kein echtes Wetter)`,
      szenario: kind,
    };
  }

  /** Prognosestunden für das Ausbreitungsmodell - für beide Szenarien IDENTISCH. */
  function forecastHours(n, opts = {}) {
    const now = opts.now ?? NOW;
    const out = [];
    for (let k = 0; k <= n; k++) {
      const t = now + k * HOUR;
      out.push({
        t, windKmh: opts.windKmh ?? 18, windDirDeg: opts.windDirDeg ?? 250,
        gustKmh: (opts.windKmh ?? 18) * 1.6, tempC: opts.tempC ?? 29, rh: opts.rh ?? 32,
        precipMm: 0, rain24: 0, rain72: 0,
      });
    }
    return out;
  }

  const API = { NOW, make, forecastHours, rng };
  root.WB_TROCKEN_SZENARIEN = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
