/*
 * Wetterdaten: Open-Meteo (Primärquelle), Cache, manuelle Überschreibung, Beispieldaten.
 * DWD Open Data / DWD-Waldbrandgefahrenindex: nicht angebunden ("Zu prüfen").
 */
(function (root) {
  const HOURLY = ["temperature_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"];

  async function fetchOpenMeteo(lat, lon, url, signal) {
    // Nur die nötigsten Koordinaten (gerundet auf ca. 1 km) an den Dienst senden (Datenschutz).
    const q = new URLSearchParams({
      latitude: lat.toFixed(2), longitude: lon.toFixed(2),
      hourly: HOURLY.join(","), past_days: "3", forecast_days: "2",
      timezone: "GMT", wind_speed_unit: "kmh", precipitation_unit: "mm",
    });
    const res = await fetch(`${url}?${q}`, { signal });
    if (!res.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${res.status}`);
    const j = await res.json();
    if (!j.hourly || !j.hourly.time) throw new Error("Open-Meteo: unerwartetes Antwortformat");
    const h = j.hourly;
    const rows = h.time.map((t, k) => ({
      t: Date.parse(t + "Z"),
      tempC: h.temperature_2m[k], rh: h.relative_humidity_2m[k], precipMm: h.precipitation[k],
      windKmh: h.wind_speed_10m[k], windDirDeg: h.wind_direction_10m[k], gustKmh: h.wind_gusts_10m[k],
    }));
    return {
      source: "Open-Meteo (Modellwerte, best_match)", kind: "live",
      fetchedAt: Date.now(), lat: +lat.toFixed(2), lon: +lon.toFixed(2), rows,
    };
  }

  /** Beispieldaten (fiktiv, für Tests/Vorschau). Im UI deutlich als "Beispieldaten" markiert. */
  function sampleWeather(now) {
    const start = Math.floor(now / 3600000) * 3600000 - 72 * 3600000;
    const rows = [];
    for (let k = 0; k < 72 + 48; k++) {
      const t = start + k * 3600000;
      const hourOfDay = new Date(t).getUTCHours();
      const diurnal = Math.sin(((hourOfDay - 8) / 24) * 2 * Math.PI);
      rows.push({
        t, tempC: 24 + 6 * diurnal, rh: 38 - 12 * diurnal, precipMm: 0,
        windKmh: 18 + 4 * diurnal, windDirDeg: 240 + (k > 72 + 3 ? 15 : 0), gustKmh: 32 + 6 * diurnal,
      });
    }
    return { source: "BEISPIELDATEN (fiktiv, kein echtes Wetter)", kind: "sample", fetchedAt: now, rows };
  }

  /**
   * Bereitet Stundenwerte ab der aktuellen Stunde für die Rechnung auf (Horizont + 1 Stunde)
   * und wendet manuelle Überschreibungen an.
   * overrides: {windKmh, windDirDeg, gustKmh, tempC, rh, rain24, rain72} (null = nicht überschrieben)
   */
  function prepareHours(wx, now, hoursNeeded, overrides) {
    const rows = wx ? wx.rows : [];
    const cur = Math.floor(now / 3600000) * 3600000;
    const out = [];
    const missing = [];
    for (let h = 0; h <= hoursNeeded; h++) {
      const t = cur + h * 3600000;
      let r = rows.find((x) => x.t === t);
      if (!r && rows.length) {
        // nächster verfügbarer Wert (Fallback, sichtbar gemeldet)
        r = rows.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
        missing.push(new Date(t).toISOString());
      }
      const sumRain = (hrs) => rows.filter((x) => x.t <= t && x.t > t - hrs * 3600000).reduce((s, x) => s + (x.precipMm || 0), 0);
      const base = r ? { ...r, rain24: sumRain(24), rain72: sumRain(72) } : { t, tempC: null, rh: null, windKmh: null, windDirDeg: null, gustKmh: null, rain24: null, rain72: null };
      const row = { ...base, t, overridden: [] };
      for (const k of ["windKmh", "windDirDeg", "gustKmh", "tempC", "rh", "rain24", "rain72"]) {
        if (overrides && overrides[k] !== null && overrides[k] !== undefined && overrides[k] !== "") {
          row[k] = Number(overrides[k]);
          row.overridden.push(k);
        }
      }
      out.push(row);
    }
    const incomplete = out.some((r) => ["windKmh", "windDirDeg", "tempC", "rh"].some((k) => r[k] === null || Number.isNaN(r[k])));
    return { hours: out, missing, incomplete };
  }

  function ageHours(wx, now) {
    return wx ? (now - wx.fetchedAt) / 3600000 : Infinity;
  }

  const Weather = { fetchOpenMeteo, sampleWeather, prepareHours, ageHours };
  root.Weather = Weather;
  if (typeof module !== "undefined" && module.exports) module.exports = Weather;
})(typeof globalThis !== "undefined" ? globalThis : this);
