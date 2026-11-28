/*
 * Modul Vorgeschichte/Trockenheit - Rechenkern (ohne DOM, deterministisch, reine Funktionen).
 *
 * Aufgabe: Die Wettervorgeschichte der letzten 30-60 Tage (Vorgabe 60) in
 *   1. tote Brennstofffeuchte (Klassen 1 h / 10 h / 100 h, stündlich fortgeschrieben),
 *   2. lebende Brennstofffeuchte (Jahreszeit + Dürre, Annahme),
 *   3. das kanadische Fire-Weather-Index-System (FFMC, DMC, DC, ISI, BUI, FWI) als Dürre-Indikator,
 *   4. Kopplungsfaktoren für das Ausbreitungsmodell (Basisfeuchten, Dürre-Faktoren, Ensemble-Spannweite)
 * umzurechnen.
 *
 * QUELLEN
 *  - FWI-System: Van Wagner, C.E. (1987) "Development and structure of the Canadian Forest Fire Weather
 *    Index System", Forestry Technical Report 35, Canadian Forestry Service. Gleichungsnummern unten in
 *    der Fassung von cffdrs/xclim; der Quelltext von xclim 1.0.0
 *    (xclim/compute/fire/_cffwis.py) wurde eingesehen und dient als Referenz
 *    (tests/fuelhistory.test.mjs vergleicht 150 Tage gegen tests/fixtures/fwi_xclim.json).
 *    ABWEICHUNG zur Originalschrift: Der Faktor in der DMC-Trocknungsrate (Gl. 16) ist wie in
 *    cffdrs/xclim 1e-4 (nicht 1e-6); damit stimmen die Werte mit der Referenzimplementierung überein.
 *  - Gleichgewichtsfeuchte: Simard (1968) - dieselbe Funktion wie FireModel.equilibriumMoisture
 *    in js/model.js (dort schon als Annahme dokumentiert).
 *  - Exponentielle Annäherung an die Gleichgewichtsfeuchte mit Zeitverzögerung tau (1/10/100 h):
 *    Standardansatz der Brennstofffeuchtemodelle (Byram 1963, Fosberg 1971; zusammengefasst in
 *    Andrews 2018, RMRS-GTR-371). Primärquellen NICHT eingesehen -> "zu prüfen".
 *  - Regenbenetzung der toten Klassen: EIGENE, EINFACHE ANNAHME (js/fuelhistory-params.js, tote.klassen).
 *  - Lebendfeuchte: EIGENE ANNAHME (Monatswerte + DC-Abschlag).
 *  - Open-Meteo-Abruf: aus der heruntergeladenen Open-Meteo-Doku belegt (past_days bis 92,
 *    Archiv-Host archive-api.open-meteo.com, ERA5 mit 5 Tagen Verzögerung, CC BY 4.0).
 *
 * GRENZEN: Punktwetter (ein Modellgitterpunkt), keine Messung am Brandort; keine Schneedecke,
 * keine Überwinterung des DC, keine Hangexposition (die kommt danach aus js/terrain.js), kein
 * Bodenwassermodell. Alles unvalidiert.
 */
(function (root) {
  "use strict";

  const HOUR = 3600000;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const defP = () => root.FUELHISTORY_PARAMS || (typeof require === "function" ? require("./fuelhistory-params.js") : null);

  // ================================================================== Zeit / Lokalzeit
  /**
   * Zeitzonenversatz in Minuten (inkl. Sommerzeit) für einen Zeitpunkt.
   * Nutzt Intl; ohne Intl (oder unbekannte Zone) 60 min (MEZ) als dokumentierter Rückfall.
   */
  function tzOffsetMin(ms, tz) {
    try {
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const p = {};
      for (const x of dtf.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = x.value;
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
    } catch {
      return 60;
    }
  }
  /** Lokale Kalenderangaben zu einem Zeitpunkt: {ymd, hour, month (1-12), doy} */
  function localParts(ms, tz) {
    const off = tzOffsetMin(ms, tz);
    const d = new Date(ms + off * 60000);
    const y = d.getUTCFullYear();
    const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000) + 1;
    return {
      ymd: d.toISOString().slice(0, 10), hour: d.getUTCHours(), month: d.getUTCMonth() + 1,
      day: d.getUTCDate(), year: y, doy, offsetMin: off,
    };
  }

  // ================================================================== 1. Wetterabruf
  /**
   * Abfrage-URL für die Forecast-API mit Vergangenheit (past_days).
   * Belegt: past_days ist ein Integer ohne dokumentierte Obergrenze; die Optionsliste der Doku
   * reicht bis 92 Tage (3 Monate). Mehr als 92 Tage -> archiveUrl verwenden ("zu prüfen").
   */
  function buildForecastUrl(lat, lon, FP, opts = {}) {
    const A = FP.abruf;
    const days = clamp(Math.round(opts.pastDays ?? A.pastDaysDefault), A.pastDaysMin, A.pastDaysMax);
    const q = new URLSearchParams({
      latitude: Number(lat).toFixed(A.coordDecimals), longitude: Number(lon).toFixed(A.coordDecimals),
      hourly: A.hourly.join(","),
      past_days: String(days), forecast_days: String(opts.forecastDays ?? A.forecastDays),
      timezone: "GMT", wind_speed_unit: "kmh", precipitation_unit: "mm",
    });
    return { url: `${A.forecastUrl}?${q}`, pastDays: days, kind: "forecast" };
  }
  /**
   * Abfrage-URL für die Historical/Archive-API (Reanalyse, eigener Host).
   * ERA5 hat laut Doku 5 Tage Verzögerung; der Abruf endet daher archiveVerzoegerungTage vor heute.
   * Für die Vorgeschichte ist das nur nötig, wenn mehr als 92 Tage gebraucht werden oder die
   * Forecast-API die Vergangenheit nicht liefert.
   */
  function buildArchiveUrl(lat, lon, FP, opts = {}) {
    const A = FP.abruf;
    const now = opts.now ?? Date.now();
    const endMs = now - (opts.verzoegerungTage ?? A.archiveVerzoegerungTage) * 24 * HOUR;
    const days = Math.max(1, Math.round(opts.pastDays ?? A.pastDaysDefault));
    const startMs = endMs - (days - 1) * 24 * HOUR;
    const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
    const p = {
      latitude: Number(lat).toFixed(A.coordDecimals), longitude: Number(lon).toFixed(A.coordDecimals),
      start_date: ymd(startMs), end_date: ymd(endMs),
      hourly: A.hourly.join(","), timezone: "GMT", wind_speed_unit: "kmh", precipitation_unit: "mm",
    };
    if (A.archiveModell) p.models = A.archiveModell;
    return { url: `${A.archiveUrl}?${new URLSearchParams(p)}`, pastDays: days, kind: "archive", start: p.start_date, end: p.end_date };
  }

  /** Antwort von Open-Meteo (Forecast oder Archive) in Stundenzeilen umsetzen. Wirft bei unerwartetem Format. */
  function parseHourly(j, meta = {}) {
    if (!j || !j.hourly || !j.hourly.time) throw new Error("Open-Meteo: unerwartetes Antwortformat (hourly fehlt)");
    const h = j.hourly;
    const rows = [];
    for (let k = 0; k < h.time.length; k++) {
      const t = Date.parse(h.time[k] + (/Z|[+-]\d\d:?\d\d$/.test(h.time[k]) ? "" : "Z"));
      if (!Number.isFinite(t)) continue;
      rows.push({
        t,
        tempC: num(h.temperature_2m, k), rh: num(h.relative_humidity_2m, k),
        precipMm: num(h.precipitation, k), windKmh: num(h.wind_speed_10m, k),
      });
    }
    rows.sort((a, b) => a.t - b.t);
    return {
      rows, kind: meta.kind || "forecast",
      source: meta.source || `Open-Meteo ${meta.kind === "archive" ? "Archive (Reanalyse)" : "Forecast (past_days)"}`,
      fetchedAt: meta.now ?? Date.now(),
      lat: j.latitude, lon: j.longitude, elevation: j.elevation,
      utcOffsetSeconds: j.utc_offset_seconds ?? 0,
    };
  }
  const num = (arr, k) => (arr && isNum(arr[k]) ? arr[k] : null);

  /**
   * Vorgeschichte abrufen. fetchImpl ist einspritzbar (Tests/Mock); Open-Meteo ist in der
   * Entwicklungsumgebung gesperrt, der Abruf ist daher nur gegen einen Mock geprüft.
   * @returns {rows, source, kind, fetchedAt, pastDays, warnings[]}
   */
  async function fetchHistory(opts) {
    const FP = opts.FP || defP();
    const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw new Error("kein fetch verfügbar");
    const warnings = [];
    const want = opts.pastDays ?? FP.abruf.pastDaysDefault;
    const useArchive = opts.archive === true || want > FP.abruf.pastDaysMax;
    const req = useArchive ? buildArchiveUrl(opts.lat, opts.lon, FP, opts) : buildForecastUrl(opts.lat, opts.lon, FP, opts);
    if (useArchive) warnings.push(`Archiv-API (${FP.abruf.archiveUrl}): Reanalyse mit ${FP.abruf.archiveVerzoegerungTage} Tagen Verzögerung, die letzten Tage fehlen.`);
    if (want > FP.abruf.pastDaysMax) warnings.push(`${want} Tage angefragt, über den in der Doku belegten past_days-Wert (${FP.abruf.pastDaysMax}) hinaus.`);
    const res = await fetchImpl(req.url, { signal: opts.signal });
    if (!res.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${res.status}`);
    const out = parseHourly(await res.json(), { kind: req.kind, now: opts.now });
    out.pastDays = req.pastDays;
    out.requestUrl = req.url;
    out.warnings = warnings;
    out.attribution = "Wetterdaten: Open-Meteo.com, CC BY 4.0 (Quellen u. a. DWD, ECMWF/Copernicus ERA5)";
    return out;
  }

  // ------------------------------------------------------------------ Cache (localStorage)
  function cacheKey(FP, lat, lon, pastDays) {
    const d = FP.abruf.coordDecimals;
    return `${FP.abruf.cacheKey}_${Number(lat).toFixed(d)}_${Number(lon).toFixed(d)}_${pastDays}`;
  }
  /** Speichert die Stundenreihe; bei Platzmangel nur die Tagesreihe (verlustbehaftet, Hinweis im Ergebnis). */
  function saveCache(store, FP, hist, lat, lon, pastDays) {
    const key = cacheKey(FP, lat, lon, pastDays);
    const full = { v: FP.version, kind: hist.kind, source: hist.source, fetchedAt: hist.fetchedAt, rows: hist.rows };
    try {
      const s = JSON.stringify(full);
      if (s.length <= FP.abruf.cacheMaxBytes) { store.setItem(key, s); return { ok: true, bytes: s.length, reduced: false }; }
      const red = { ...full, reduced: true, rows: hist.rows.filter((r, i) => i % 3 === 0) };
      const s2 = JSON.stringify(red);
      store.setItem(key, s2);
      return { ok: true, bytes: s2.length, reduced: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  /** Liest den Cache; gibt null zurück, wenn nicht vorhanden, defekt oder localStorage gesperrt ist. */
  function loadCache(store, FP, lat, lon, pastDays, now) {
    try {
      const raw = store.getItem(cacheKey(FP, lat, lon, pastDays));
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.rows) || !o.rows.length) return null;
      const ageH = ((now ?? Date.now()) - (o.fetchedAt || 0)) / HOUR;
      return { ...o, ageH, stale: ageH > FP.abruf.cacheMaxAgeH, tooOld: ageH > FP.abruf.cacheWarnAgeH };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ Manuelle Ersatzeingabe (Fallback)
  /**
   * Ersatz-Vorgeschichte aus wenigen Angaben erzeugen, wenn kein Abruf möglich ist.
   * manual: {tageSeitRegen1mm, tageSeitRegen5mm, regen7Tage, regen30Tage, tempC, rh, windKmh}
   * ANNAHME: gleichmäßiger Tagesgang (Mittagswerte aus tempC/rh), Regen wird auf die Tage VOR
   * "tageSeitRegen" gleichmäßig verteilt; die Reihe ist synthetisch und wird im UI so gekennzeichnet.
   * @returns {rows, kind:"manuell", source, warnings[]}
   */
  function manualHistory(manual, opts) {
    const FP = opts.FP || defP();
    const now = opts.now ?? Date.now();
    const days = clamp(Math.round(opts.pastDays ?? FP.abruf.pastDaysDefault), FP.abruf.pastDaysMin, FP.abruf.pastDaysMax);
    const t0 = Math.floor(now / HOUR) * HOUR - days * 24 * HOUR;
    const dry1 = Math.max(0, Math.round(manual.tageSeitRegen1mm ?? 0));
    const dry5 = Math.max(dry1, Math.round(manual.tageSeitRegen5mm ?? dry1));
    const r7 = Math.max(0, Number(manual.regen7Tage ?? 0));
    const r30 = Math.max(r7, Number(manual.regen30Tage ?? r7));
    const tMean = isNum(manual.tempC) ? manual.tempC : 20;
    const rhMean = isNum(manual.rh) ? manual.rh : 55;
    const wind = isNum(manual.windKmh) ? manual.windKmh : 10;

    // Regen auf Tage verteilen. Reihenfolge: zuerst den Tag mit >= 5 mm festlegen (Kennzahl
    // "Tage seit letztem Regen >= 5 mm"), dann die Summen der Fenster 7 / 30 / älter auf die
    // übrigen Tage verteilen, die vor "Tage seit Regen >= 1 mm" liegen. Die 5 mm werden aus dem
    // Budget des jeweiligen Fensters gedeckt, damit die eingegebenen Summen eingehalten werden
    // (nur wenn das Budget kleiner als 5 mm ist, wird die Summe zwangsläufig größer).
    const perDay = new Float64Array(days + 1);
    let rest7 = r7, rest30 = Math.max(0, r30 - r7), rest60 = (r30 / 30) * Math.max(0, days - 30);
    const fix = [];
    const reserve = (tag, mm) => {
      if (!(tag >= 0 && tag < days) || fix.indexOf(tag) >= 0) return;
      fix.push(tag);
      perDay[days - 1 - tag] = mm;
      if (tag < 7) rest7 = Math.max(0, rest7 - mm);
      else if (tag < 30) rest30 = Math.max(0, rest30 - mm);
      else rest60 = Math.max(0, rest60 - mm);
    };
    // Der zuletzt genannte Regentag muss die genannte Schwelle auch erreichen.
    if (isNum(manual.tageSeitRegen5mm)) reserve(dry5, 5);
    if (isNum(manual.tageSeitRegen1mm)) reserve(dry1, 1);
    const slot = (von, bis) => {
      const out = [];
      for (let d = von; d < Math.min(bis, days); d++) if (fix.indexOf(d) < 0) out.push(d);
      return out;
    };
    const give = (sum, slots) => { if (!slots.length || sum <= 0) return; for (const d of slots) perDay[days - 1 - d] += sum / slots.length; };
    give(rest7, slot(dry1 + 1, 7));
    give(rest30, slot(Math.max(7, dry1 + 1), 30));
    // vor 30 Tagen: Annahme Klimamittel, aus regen30Tage fortgeschrieben
    give(rest60, slot(30, days));
    const rows = [];
    for (let k = 0; k <= days * 24 + 6; k++) {
      const t = t0 + k * HOUR;
      const p = localParts(t, FP.abruf.zeitzone);
      const dayIdx = Math.min(days, Math.floor(k / 24));
      const diurnal = Math.sin(((p.hour - 9) / 24) * 2 * Math.PI);
      const rainHours = 6; // [A] Regen über 6 Stunden (03-09 Uhr Lokalzeit) verteilt
      const isRainHour = p.hour >= 3 && p.hour < 3 + rainHours;
      rows.push({
        t, tempC: tMean + 5 * diurnal, rh: clamp(rhMean - 15 * diurnal, 5, 100),
        precipMm: isRainHour ? perDay[dayIdx] / rainHours : 0, windKmh: wind,
      });
    }
    return {
      rows, kind: "manuell", fetchedAt: now,
      source: "MANUELLE ERSATZEINGABE (synthetische Vorgeschichte, kein echtes Wetter)",
      warnings: ["Vorgeschichte aus manueller Ersatzeingabe: Tagesgang und Regenverteilung sind Annahmen."],
      pastDays: days,
    };
  }

  // ================================================================== 2. Tote Brennstofffeuchte
  /** Gleichgewichtsfeuchte nach Simard (1968) in % - identisch zu FireModel.equilibriumMoisture. */
  function equilibriumMoisture(tempC, rh) {
    const T = tempC * 9 / 5 + 32;
    const H = clamp(rh, 0, 100);
    if (H < 10) return 0.03229 + 0.281073 * H - 0.000578 * H * T;
    if (H < 50) return 2.22749 + 0.160107 * H - 0.01478 * T;
    return 21.0606 + 0.005565 * H * H - 0.00035 * H * T - 0.483199 * H;
  }

  /**
   * Stündliche Fortschreibung der toten Brennstofffeuchte über die Vorgeschichte.
   * Je Klasse: m <- EMC + (m - EMC) * exp(-dt/tau); danach Regenbenetzung (Annahme, s. Params).
   * @param rows Stundenzeilen {t, tempC, rh, precipMm}
   * @param FP   FUELHISTORY_PARAMS
   * @param init optionaler Startzustand {d1, d10, d100} in % (sonst EMC der ersten Stunde)
   * @returns {series: [{t, emc, d1, d10, d100}], last: {...}, hoursUsed, gaps}
   */
  function deadMoistureSeries(rows, FP, init) {
    const T = FP.tote;
    const keys = Object.keys(T.klassen);
    const m = {};
    let gaps = 0;
    const first = rows.find((r) => isNum(r.tempC) && isNum(r.rh));
    const emc0 = first ? equilibriumMoisture(first.tempC, first.rh) : 12;
    for (const k of keys) m[k] = init && isNum(init[k]) ? init[k] : clamp(emc0 + T.startVersatzPct, T.min, T.max);
    const series = [];
    let prevT = rows.length ? rows[0].t : 0;
    for (const r of rows) {
      const dtH = series.length === 0 ? 0 : clamp((r.t - prevT) / HOUR, 0, 24);
      prevT = r.t;
      const ok = isNum(r.tempC) && isNum(r.rh);
      if (!ok) gaps++;
      const emc = ok ? clamp(equilibriumMoisture(r.tempC, r.rh), 0.5, T.max) : null;
      const rain = isNum(r.precipMm) ? r.precipMm : 0;
      const row = { t: r.t, emc, rain };
      for (const k of keys) {
        const C = T.klassen[k];
        if (emc !== null && dtH > 0) m[k] = emc + (m[k] - emc) * Math.exp(-dtH / C.tauH);
        if (rain > T.regenSchwelleMm) {
          const add = Math.min(C.rainKPerMm * rain, C.rainMaxPerH * Math.max(1, dtH));
          m[k] = Math.min(C.sat, m[k] + add);
        }
        m[k] = clamp(m[k], T.min, T.max);
        row[k] = m[k];
      }
      series.push(row);
    }
    return { series, last: { ...m }, hoursUsed: series.length, gaps };
  }

  /** Feuchte der FFMC-Streuschicht aus dem FFMC (Van Wagner 1987, Gl. 1 umgestellt), in %. Gegenprobe zur 1-h-Klasse. */
  function ffmcMoisture(ffmc) {
    return (147.2 * (101 - ffmc)) / (59.5 + ffmc);
  }

  // ================================================================== 3. Lebende Brennstofffeuchte
  /**
   * Lebendfeuchte (ANNAHME) aus Jahreszeit (Monat/Tag) und Dürre (DC).
   * @returns {lh, lw, saison: {lh, lw}, duerreAnteil}
   */
  function liveMoisture(ms, dc, FP, tz) {
    const L = FP.lebend;
    const p = localParts(ms, tz || FP.abruf.zeitzone);
    const pick = (arr) => {
      if (!L.interpolieren) return arr[p.month - 1];
      // linear zwischen Monatsmitten (Tag 15)
      const frac = (p.day - 15) / 30;
      const i = p.month - 1;
      const j = frac >= 0 ? (i + 1) % 12 : (i + 11) % 12;
      return arr[i] + (arr[j] - arr[i]) * Math.abs(frac);
    };
    const sLh = pick(L.krautMonat), sLw = pick(L.gehoelzMonat);
    const d = isNum(dc) ? clamp((dc - L.dcStart) / Math.max(1e-6, L.dcVoll - L.dcStart), 0, 1) : 0;
    const lh = Math.max(L.krautMin, sLh * (1 - L.krautAbschlag * d));
    const lw = Math.max(L.gehoelzMin, sLw * (1 - L.gehoelzAbschlag * d));
    return { lh, lw, saison: { lh: sLh, lw: sLw }, duerreAnteil: d };
  }

  // ================================================================== 4. FWI-System (Van Wagner 1987)
  const dayLength = (FP, month) => FP.fwi.tageslaengeDMC[month - 1];
  const dayLengthFactor = (FP, month) => FP.fwi.tageslaengeDC[month - 1];

  /** FFMC (Gl. 1-10). t [°C], p [mm/24 h], w [km/h], h [%] am Mittag; ffmc0 = Vortag. */
  function ffmcStep(t, p, w, h, ffmc0) {
    let mo = (147.2 * (101 - ffmc0)) / (59.5 + ffmc0); // Gl. 1
    if (p > 0.5) {
      const rf = p - 0.5; // Gl. 2
      if (mo > 150) {
        mo = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf))
          + 0.0015 * (mo - 150) * (mo - 150) * Math.sqrt(rf); // Gl. 3b
      } else {
        mo = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf)); // Gl. 3a
      }
      if (mo > 250) mo = 250;
    }
    const ed = 0.942 * Math.pow(h, 0.679) + 11 * Math.exp((h - 100) / 10)
      + 0.18 * (21.1 - t) * (1 - Math.exp(-0.115 * h)); // Gl. 4
    let m;
    if (mo < ed) {
      const ew = 0.618 * Math.pow(h, 0.753) + 10 * Math.exp((h - 100) / 10)
        + 0.18 * (21.1 - t) * (1 - Math.exp(-0.115 * h)); // Gl. 5
      if (mo < ew) {
        const kl = 0.424 * (1 - Math.pow((100 - h) / 100, 1.7))
          + 0.0694 * Math.sqrt(w) * (1 - Math.pow((100 - h) / 100, 8)); // Gl. 7a
        const kw = kl * 0.581 * Math.exp(0.0365 * t); // Gl. 7b
        m = ew - (ew - mo) / Math.pow(10, kw); // Gl. 9
      } else {
        m = mo;
      }
    } else if (mo === ed) {
      m = mo;
    } else {
      const kl = 0.424 * (1 - Math.pow(h / 100, 1.7)) + 0.0694 * Math.sqrt(w) * (1 - Math.pow(h / 100, 8)); // Gl. 6a
      const kw = kl * 0.581 * Math.exp(0.0365 * t); // Gl. 6b
      m = ed + (mo - ed) / Math.pow(10, kw); // Gl. 8
    }
    let f = (59.5 * (250 - m)) / (147.2 + m); // Gl. 10
    if (f > 101) f = 101; else if (f <= 0) f = 0;
    return f;
  }

  /** DMC (Gl. 11-17). Tageslänge Le nach Breite/Monat. */
  function dmcStep(t, p, h, month, FP, dmc0) {
    const dl = dayLength(FP, month);
    const rk = t < -1.1 ? 0 : 1.894 * (t + 1.1) * (100 - h) * dl * 1e-4; // Gl. 16/17 (Faktor wie cffdrs/xclim)
    let pr = dmc0;
    if (p > 1.5) {
      const rw = 0.92 * p - 1.27; // Gl. 11
      const wmi = 20 + 280 / Math.exp(0.023 * dmc0); // Gl. 12
      let b;
      if (dmc0 <= 33) b = 100 / (0.5 + 0.3 * dmc0); // Gl. 13a
      else if (dmc0 <= 65) b = 14 - 1.3 * Math.log(dmc0); // Gl. 13b
      else b = 6.2 * Math.log(dmc0) - 17.2; // Gl. 13c
      const wmr = wmi + (1000 * rw) / (48.77 + b * rw); // Gl. 14
      pr = 43.43 * (5.6348 - Math.log(wmr - 20)); // Gl. 15
    }
    if (pr < 0) pr = 0;
    const dmc = pr + rk;
    return dmc < 0 ? 0 : dmc;
  }

  /** DC (Gl. 18-22). Tageslängenfaktor Lf nach Monat (Nordhalbkugel). */
  function dcStep(t, p, month, FP, dc0) {
    const fl = dayLengthFactor(FP, month);
    const tt = Math.max(t, -2.8);
    let pe = (0.36 * (tt + 2.8) + fl) / 2; // Gl. 22
    if (pe < 0) pe = 0;
    if (p > 2.8) {
      const rw = 0.83 * p - 1.27; // Gl. 18
      const smi = 800 * Math.exp(-dc0 / 400); // Gl. 19
      const dr = dc0 - 400 * Math.log(1 + (3.937 * rw) / smi); // Gl. 20/21
      return dr > 0 ? dr + pe : pe;
    }
    return dc0 + pe;
  }

  /** ISI (Gl. 24-26) aus Wind [km/h] und FFMC. */
  function isiOf(w, ffmc) {
    const mo = (147.2 * (101 - ffmc)) / (59.5 + ffmc);
    const ff = 19.1152 * Math.exp(-0.1386 * mo) * (1 + Math.pow(mo, 5.31) / 4.93e7); // Gl. 25 (= 0.208 * fF)
    return ff * Math.exp(0.05039 * w); // Gl. 26
  }
  /** BUI (Gl. 27a/27b) aus DMC und DC. */
  function buiOf(dmc, dc) {
    if (dmc === 0 && dc === 0) return 0;
    const denom = dmc + 0.4 * dc;
    const bui = dmc <= 0.4 * dc
      ? (0.8 * dc * dmc) / denom // Gl. 27a
      : dmc - (1 - (0.8 * dc) / denom) * (0.92 + Math.pow(0.0114 * dmc, 1.7)); // Gl. 27b
    return Math.max(0, bui);
  }
  /** FWI (Gl. 28a/28b, 29, 30b) aus ISI und BUI. */
  function fwiOf(isi, bui) {
    const fd = bui <= 80 ? 0.626 * Math.pow(bui, 0.809) + 2 : 1000 / (25 + 108.64 / Math.exp(0.023 * bui));
    const b = 0.1 * isi * fd; // Gl. 29
    return b > 1 ? Math.exp(2.72 * Math.pow(0.434 * Math.log(b), 0.647)) : b; // Gl. 30b
  }
  /** Daily Severity Rating (Van Wagner 1987, Gl. 31) - nur informativ. */
  const dsrOf = (fwi) => 0.0272 * Math.pow(fwi, 1.77);

  /**
   * Tägliche Mittagswerte (12 Uhr LOKALZEIT) aus Stundenzeilen aufbereiten.
   * Niederschlag: Summe der 24 Stundenwerte, die auf den Mittag enden. Open-Meteo liefert
   * Niederschlag als Summe der VORANGEGANGENEN Stunde (Doku: "calculated from the preceding hour"),
   * also Stunden [Mittag-23 h .. Mittag] = Zeitraum Mittag(Vortag) .. Mittag.
   * @returns [{ymd, month, tMid, t, h, w, r24, rSum24Vollstaendig}]
   */
  function dailyNoon(rows, FP) {
    const tz = FP.abruf.zeitzone, noonH = FP.fwi.mittagStunde;
    const idx = new Map();
    for (const r of rows) idx.set(r.t, r);
    const out = [];
    for (const r of rows) {
      const p = localParts(r.t, tz);
      if (p.hour !== noonH) continue;
      let r24 = 0, have = 0;
      for (let k = 23; k >= 0; k--) {
        const q = idx.get(r.t - k * HOUR);
        if (q && isNum(q.precipMm)) { r24 += q.precipMm; have++; }
      }
      const werte = isNum(r.tempC) && isNum(r.rh) && isNum(r.windKmh);
      out.push({
        ymd: p.ymd, month: p.month, doy: p.doy, tMid: r.t,
        t: r.tempC, h: r.rh, w: r.windKmh, r24,
        // vollstaendig: Mittagswerte vorhanden UND mindestens 12 der 24 Regenstunden bekannt.
        // Der erste Tag des Fensters hat naturgemäß weniger Regenstunden (teilweise = true).
        vollstaendig: werte && have >= 12,
        teilweise: werte && have >= 12 && have < 24,
        stundenRegen: have,
      });
    }
    return out;
  }

  /**
   * FWI-Reihe über die Tagesliste fortschreiben. Lücken (unvollständige Tage) werden mit den
   * letzten gültigen Werten überbrückt und gezählt (Hinweis im UI).
   * @param days  aus dailyNoon()
   * @param FP    FUELHISTORY_PARAMS
   * @param start optional {ffmc, dmc, dc} (sonst die Standard-Startwerte)
   */
  function fwiSeries(days, FP, start) {
    let ffmc = start && isNum(start.ffmc) ? start.ffmc : FP.fwi.startFFMC;
    let dmc = start && isNum(start.dmc) ? start.dmc : FP.fwi.startDMC;
    let dc = start && isNum(start.dc) ? start.dc : FP.fwi.startDC;
    const out = [];
    let skipped = 0, teilweise = 0;
    for (const d of days) {
      if (!d.vollstaendig) {
        skipped++;
        out.push({ ...d, ffmc, dmc, dc, isi: isiOf(isNum(d.w) ? d.w : 0, ffmc), bui: buiOf(dmc, dc), fwi: 0, uebersprungen: true });
        const last = out[out.length - 1];
        last.fwi = fwiOf(last.isi, last.bui);
        last.dsr = dsrOf(last.fwi);
        continue;
      }
      if (d.teilweise) teilweise++;
      ffmc = ffmcStep(d.t, d.r24, d.w, d.h, ffmc);
      dmc = dmcStep(d.t, d.r24, d.h, d.month, FP, dmc);
      dc = dcStep(d.t, d.r24, d.month, FP, dc);
      const isi = isiOf(d.w, ffmc);
      const bui = buiOf(dmc, dc);
      const fwi = fwiOf(isi, bui);
      out.push({ ...d, ffmc, dmc, dc, isi, bui, fwi, dsr: dsrOf(fwi), uebersprungen: false });
    }
    return { days: out, last: out.length ? out[out.length - 1] : null, skipped, teilweise, start: { ffmc: start && isNum(start.ffmc) ? start.ffmc : FP.fwi.startFFMC, dmc: start && isNum(start.dmc) ? start.dmc : FP.fwi.startDMC, dc: start && isNum(start.dc) ? start.dc : FP.fwi.startDC } };
  }

  // ================================================================== Kennzahlen Trockenheit
  /**
   * Niederschlagskennzahlen aus der Tagesreihe (Mittag-zu-Mittag-Tage).
   * @returns {tageSeitRegen: {1: n, 5: n}, summen: {7: mm, 30: mm, 60: mm}, tageMitRegen7, maxTrockenstrecke}
   */
  function rainStats(days, FP) {
    const schwellen = FP.ampel.regenSchwellenMm, fenster = FP.ampel.summenTage;
    const n = days.length;
    const tageSeitRegen = {};
    const EPS = 1e-9; // Summen aus Stundenwerten treffen eine Schwelle sonst knapp nicht (Gleitkomma)
    for (const s of schwellen) {
      let k = null;
      for (let i = n - 1; i >= 0; i--) {
        if (days[i].r24 >= s - EPS) { k = n - 1 - i; break; }
      }
      tageSeitRegen[s] = k === null ? { tage: n, mindestens: true } : { tage: k, mindestens: false };
    }
    const summen = {};
    for (const f of fenster) {
      let s = 0, have = 0;
      for (let i = n - 1; i >= Math.max(0, n - f); i--) { s += days[i].r24; have++; }
      summen[f] = { mm: s, tage: have, vollstaendig: have === f };
    }
    let maxDry = 0, cur = 0;
    for (const d of days) { if (d.r24 < schwellen[0] - EPS) { cur++; maxDry = Math.max(maxDry, cur); } else cur = 0; }
    return {
      tageSeitRegen, summen, maxTrockenstrecke: maxDry,
      tageMitRegen7: days.slice(-7).filter((d) => d.r24 >= schwellen[0] - EPS).length,
      tageGesamt: n,
    };
  }

  /** Trockenheitsampel: FWI-Klasse (EFFIS, zu prüfen) + eigene dreistufige Ampel. */
  function droughtLevel(fwiDay, stats, FP) {
    const A = FP.ampel;
    const fwi = fwiDay && isNum(fwiDay.fwi) ? fwiDay.fwi : null;
    let klasse = null;
    if (fwi !== null) {
      klasse = 0;
      for (let i = 0; i < A.fwiGrenzen.length; i++) if (fwi >= A.fwiGrenzen[i]) klasse = i + 1;
    }
    const ampel = klasse === null ? "unbekannt" : klasse >= A.ampelAbKlasse.rot ? "rot" : klasse >= A.ampelAbKlasse.gelb ? "gelb" : "gruen";
    const hinweise = [];
    if (fwiDay && isNum(fwiDay.dc)) {
      if (fwiDay.dc > A.dcHinweis[1]) hinweise.push(`DC ${Math.round(fwiDay.dc)}: ausgeprägte Dürre (Annahme der Schwelle)`);
      else if (fwiDay.dc > A.dcHinweis[0]) hinweise.push(`DC ${Math.round(fwiDay.dc)}: deutliches Niederschlagsdefizit (Annahme der Schwelle)`);
    }
    if (fwiDay && isNum(fwiDay.bui)) {
      if (fwiDay.bui > A.buiHinweis[1]) hinweise.push(`BUI ${Math.round(fwiDay.bui)}: auch grobes Totholz trocken (Annahme)`);
      else if (fwiDay.bui > A.buiHinweis[0]) hinweise.push(`BUI ${Math.round(fwiDay.bui)}: Brennstoff tiefer getrocknet (Annahme)`);
    }
    const dry = stats && stats.tageSeitRegen ? stats.tageSeitRegen[FP.ampel.regenSchwellenMm[0]] : null;
    if (dry && dry.tage >= A.trockentageHinweis[1]) hinweise.push(`${dry.tage} Tage ohne Regen ≥ ${A.regenSchwellenMm[0]} mm`);
    else if (dry && dry.tage >= A.trockentageHinweis[0]) hinweise.push(`${dry.tage} Tage ohne Regen ≥ ${A.regenSchwellenMm[0]} mm`);
    return {
      fwi, klasse, label: klasse === null ? "unbekannt" : A.fwiLabels[klasse], ampel, hinweise,
      quelle: "FWI-Klassengrenzen wie bei EFFIS gebräuchlich (Primärquelle nicht eingesehen, zu prüfen); Ampelzusammenfassung ist eine eigene Annahme.",
    };
  }

  // ================================================================== 5. Kopplung an das Ausbreitungsmodell
  /**
   * Dürre-Anteil 0..1 aus BUI oder DC.
   */
  function droughtFraction(fwiDay, FP) {
    const K = FP.kopplung.duerre;
    if (!fwiDay) return 0;
    const v = K.quelle === "dc" ? fwiDay.dc : fwiDay.bui;
    if (!isNum(v)) return 0;
    return clamp((v - K.start) / Math.max(1e-6, K.voll - K.start), 0, 1);
  }

  /**
   * Kopplungsfaktoren. Liefert BASIS-Feuchten je Brennstoffklasse (ohne Exposition!) und
   * Dürre-Faktoren. Die expositionsabhängige Korrektur aus js/terrain.js wird DANACH addiert
   * (siehe INTEGRATION.md) - hier darf sie nicht enthalten sein.
   *
   * @param state Ergebnis von compute()
   * @param FP    FUELHISTORY_PARAMS
   * @param base  optional die bisherige Herleitung {d1,d10,d100} (FireModel.deadMoisture) zur Begrenzung
   * @returns {active, moisture:{d1,d10,d100,lh,lw}, begrenzt:[], last:{w1,w10,w100,wLH,wLW}, irFaktor,
   *           curingAnteil, ensembleFaktor, duerreAnteil, quelle, notes[]}
   */
  function couplingFactors(state, FP, base) {
    const K = FP.kopplung;
    const notes = [];
    if (!state || !state.active) {
      return {
        active: false, moisture: null, last: null, irFaktor: 1, curingAnteil: 0,
        ensembleFaktor: 1, duerreAnteil: 0, begrenzt: [],
        notes: ["Vorgeschichte ausgeschaltet oder keine Daten: Rechnung wie bisher (js/model.js deadMoisture)."],
      };
    }
    const d = droughtFraction(state.fwi && state.fwi.last, FP);
    // --- Basisfeuchten (begrenzt gegenüber der bisherigen Herleitung)
    const begrenzt = [];
    const dead = { ...state.dead.current };
    if (base && K.maxAbweichungPct) {
      for (const k of ["d1", "d10", "d100"]) {
        const lim = K.maxAbweichungPct[k];
        if (!isNum(lim) || !isNum(base[k])) continue;
        const lo = base[k] - lim, hi = base[k] + lim;
        if (dead[k] < lo || dead[k] > hi) { begrenzt.push(`${k}: ${dead[k].toFixed(1)} % auf ${clamp(dead[k], lo, hi).toFixed(1)} % begrenzt (max. ±${lim} %-Pkt. gegenüber bisheriger Herleitung)`); dead[k] = clamp(dead[k], lo, hi); }
      }
    }
    const live = { ...state.live };
    if (base && isNum(base.lh) && isNum(K.maxAbweichungLebendPct)) {
      const lim = K.maxAbweichungLebendPct;
      for (const [k, b] of [["lh", base.lh], ["lw", base.lw]]) {
        if (!isNum(b)) continue;
        const v = clamp(live[k], b - lim, b + lim);
        if (v !== live[k]) { begrenzt.push(`${k}: ${live[k].toFixed(0)} % auf ${v.toFixed(0)} % begrenzt`); live[k] = v; }
      }
    }
    // --- Dürre auf Brennstoffmenge bzw. Reaktionsintensität
    const Kd = K.duerre;
    const gain = (Kd.maxLastFaktor - 1) * d;
    const last = {
      w1: 1 + gain * (Kd.anteil.w1 || 0), w10: 1 + gain * (Kd.anteil.w10 || 0),
      w100: 1 + gain * (Kd.anteil.w100 || 0), wLH: 1 + gain * (Kd.anteil.wLH || 0), wLW: 1 + gain * (Kd.anteil.wLW || 0),
    };
    const irFaktor = K.modus === "reaktionsintensitaet" ? 1 + (Kd.maxIrFaktor - 1) * d : 1;
    if (K.modus === "reaktionsintensitaet") { for (const k of Object.keys(last)) last[k] = 1; }
    // --- Vergilben (Teil der Krautbeladung als toter Feinbrennstoff)
    let curing = 0;
    if (K.curing && K.curing.enabled) {
      const bui = state.fwi && state.fwi.last ? state.fwi.last.bui : null;
      if (isNum(bui)) curing = FP.lebend.curingMax * clamp((bui - K.curing.start) / Math.max(1e-6, K.curing.voll - K.curing.start), 0, 1);
    }
    // --- Ensemble-Spannweite
    const E = K.ensemble;
    let ensembleFaktor = 1 + (E.maxFaktor - 1) * clamp((((state.fwi && state.fwi.last ? (Kd.quelle === "dc" ? state.fwi.last.dc : state.fwi.last.bui) : 0)) - E.start) / Math.max(1e-6, E.voll - E.start), 0, 1);
    if (state.kind === "manuell") { ensembleFaktor = Math.max(ensembleFaktor, E.manuellFaktor); notes.push("Manuelle Ersatzeingabe: Ensemble-Spannweite der Feuchte erhöht."); }
    if (state.kind === "fallback") { ensembleFaktor = Math.max(ensembleFaktor, E.fallbackFaktor); notes.push("Keine Vorgeschichte: Ensemble-Spannweite der Feuchte erhöht."); }
    notes.push(`Dürre-Anteil ${(d * 100).toFixed(0)} % aus ${Kd.quelle.toUpperCase()} (${Kd.start}…${Kd.voll}); Modus "${K.modus}".`);
    return {
      active: true, moisture: { ...dead, lh: live.lh, lw: live.lw }, last, irFaktor,
      curingAnteil: curing, ensembleFaktor, duerreAnteil: d, begrenzt, notes,
      quelle: Kd.quelle,
    };
  }

  /**
   * Basisfeuchte je PROGNOSESTUNDE: Die Fortschreibung läuft aus dem Zustand am Ende der
   * Vorgeschichte in die Prognosestunden weiter. Rückgabe in PROZENT (nicht Anteil),
   * damit die Begrenzung und die Expositionskorrektur in %-Punkten darauf rechnen können.
   * @param state      Ergebnis von compute()
   * @param forecastHours Stundenzeilen des Modells [{t, tempC, rh, precipMm?|rain24?}]
   * @returns [{d1,d10,d100,lh,lw}] je Stunde oder null, wenn die Vorgeschichte aus ist
   */
  function baseMoistureForHours(state, forecastHours, FP, base) {
    if (!state || !state.active) return null;
    const rows = forecastHours.map((w) => ({
      t: w.t, tempC: w.tempC, rh: w.rh,
      precipMm: isNum(w.precipMm) ? w.precipMm : 0,
    }));
    const res = deadMoistureSeries(rows, FP, state.dead.last);
    const cf = couplingFactors(state, FP, base);
    const out = [];
    for (const r of res.series) {
      const m = { d1: r.d1, d10: r.d10, d100: r.d100 };
      if (base && FP.kopplung.maxAbweichungPct) {
        for (const k of ["d1", "d10", "d100"]) {
          const lim = FP.kopplung.maxAbweichungPct[k];
          if (isNum(lim) && isNum(base[k])) m[k] = clamp(m[k], base[k] - lim, base[k] + lim);
        }
      }
      out.push({ ...m, lh: cf.moisture ? cf.moisture.lh : null, lw: cf.moisture ? cf.moisture.lw : null });
    }
    return out;
  }

  /**
   * ADAPTER für Demo und Tests, SOLANGE die Schnittstelle in js/model.js noch fehlt (siehe INTEGRATION.md).
   * Erzeugt eine KOPIE von PARAMS, in der
   *   - die bisherige Feuchteherleitung (FireModel.deadMoisture) genau die Basisfeuchten der
   *     Vorgeschichte liefert (gültig für STUNDEN MIT GLEICHER Witterung, z. B. die konstanten
   *     Prognosestunden der Demo; der Zielwert d1 muss >= Gleichgewichtsfeuchte sein),
   *   - die Lebendfeuchten gesetzt sind,
   *   - die Beladungen der Brennstoffmodelle mit den Dürre-Faktoren skaliert und der vergilbte
   *     Krautanteil (curing) in die 1-h-Klasse verschoben ist,
   *   - die Ensemble-Spannweite der toten Feuchte mit ensembleFaktor multipliziert ist.
   * Nach der Integration übernimmt js/model.js die Werte direkt je Stunde; dieser Adapter entfällt.
   * @param P  PARAMS (wird nicht verändert)
   * @param cf Ergebnis von couplingFactors()
   * @param m  Basisfeuchten {d1,d10,d100,lh,lw} in % (z. B. baseMoistureForHours()[0])
   */
  function adaptParams(P, cf, m) {
    const out = JSON.parse(JSON.stringify(P));
    if (!cf || !cf.active) return out;
    const mm = m || cf.moisture;
    out.moisture = {
      ...out.moisture,
      rain24hFactor: 0, rainMaxAdd: 0, rain72hFactor100h: 0,
      add10h: mm.d10 - mm.d1, add100h: mm.d100 - mm.d1,
      min: mm.d1, max: Math.max(out.moisture.max, mm.d10, mm.d100),
      liveHerb: mm.lh, liveWoody: mm.lw,
    };
    const L = cf.last || { w1: 1, w10: 1, w100: 1, wLH: 1, wLW: 1 };
    for (const key of Object.keys(out.fuelModels)) {
      const fm = out.fuelModels[key];
      const cured = cf.curingAnteil * fm.w[3];
      fm.w = [
        (fm.w[0] + cured) * L.w1, fm.w[1] * L.w10, fm.w[2] * L.w100,
        (fm.w[3] - cured) * L.wLH, fm.w[4] * L.wLW,
      ];
      // modus "reaktionsintensitaet": Beladungen UND Brennstofftiefe mit dem gleichen Faktor
      // skalieren. Dann bleibt die Packungsdichte beta = (Summe w)/Tiefe/rho_p unverändert und
      // in Rothermel (1972) gilt exakt R ~ I_R ~ Faktor - ohne Eingriff in js/model.js.
      if (cf.irFaktor !== 1) {
        fm.w = fm.w.map((v) => v * cf.irFaktor);
        fm.depth = fm.depth * cf.irFaktor;
      }
    }
    out.ensemble = { ...out.ensemble, deadMoistureAbs: out.ensemble.deadMoistureAbs * cf.ensembleFaktor };
    out.vorgeschichteAdapter = { irFaktor: cf.irFaktor, curing: cf.curingAnteil, last: L, ensembleFaktor: cf.ensembleFaktor };
    return out;
  }

  // ================================================================== Gesamtrechnung
  /**
   * Vorgeschichte auswerten.
   * @param input {hist, now, FP, enabled, pastDays, start, legacy}
   *   hist    = {rows, kind, source, fetchedAt} aus fetchHistory()/manualHistory()/Cache (oder null)
   *   now     = Zeitpunkt der Lage (ms)
   *   enabled = Schalter "Vorgeschichte einbeziehen" (Standard FP.enabled)
   *   start   = optionale FWI-Startwerte {ffmc,dmc,dc} (Standard: FP.fwi.start*)
   *   legacy  = optional {d1,d10,d100,lh,lw} bisherige Herleitung (für Begrenzung/Vergleich)
   * @returns Zustandsobjekt (siehe INTEGRATION.md)
   */
  function compute(input) {
    const FP = input.FP || defP();
    const now = input.now ?? Date.now();
    const enabled = input.enabled ?? FP.enabled;
    const warnings = [];
    const hist = input.hist || null;
    const state = {
      version: FP.version, enabled, active: false, kind: hist ? hist.kind : "fallback",
      source: hist ? hist.source : "keine Vorgeschichte",
      fetchedAt: hist ? hist.fetchedAt : null, now,
      pastDaysAngefragt: input.pastDays ?? FP.abruf.pastDaysDefault,
      warnings, hervorhebenTage: FP.abruf.hervorhebenTage,
    };
    if (!enabled) {
      warnings.push("Schalter \"Vorgeschichte einbeziehen\" ist AUS: Feuchte wie bisher (Gleichgewichtsfeuchte + Regenzuschlag).");
      state.coupling = couplingFactors(state, FP, input.legacy);
      return state;
    }
    if (!hist || !hist.rows || hist.rows.length < 24) {
      warnings.push("Keine Wettervorgeschichte verfügbar (Abruf gescheitert oder leer). Rechnung ohne Vorgeschichte; manuelle Ersatzeingabe möglich.");
      state.kind = "fallback";
      state.coupling = couplingFactors(state, FP, input.legacy);
      return state;
    }
    // Fenster: letzte pastDays Tage bis "jetzt" (Prognosestunden nach now werden nicht mitgerechnet)
    const days = clamp(Math.round(state.pastDaysAngefragt), FP.abruf.pastDaysMin, FP.abruf.pastDaysMax);
    const from = now - days * 24 * HOUR;
    const rows = hist.rows.filter((r) => r.t >= from && r.t <= now);
    state.hours = rows.length;
    state.vonMs = rows.length ? rows[0].t : null;
    state.bisMs = rows.length ? rows[rows.length - 1].t : null;
    state.pastDaysGenutzt = rows.length ? (state.bisMs - state.vonMs) / (24 * HOUR) : 0;
    if (state.pastDaysGenutzt < FP.abruf.pastDaysMin - 1) {
      warnings.push(`Vorgeschichte nur ${state.pastDaysGenutzt.toFixed(1)} Tage lang (angefragt ${days}); Dürre-Indikatoren sind entsprechend unsicher.`);
    }
    const lastRowAge = (now - (state.bisMs || 0)) / HOUR;
    if (lastRowAge > 6) warnings.push(`Letzter Stundenwert ist ${lastRowAge.toFixed(0)} h alt.`);

    // --- tote Feuchte
    const dead = deadMoistureSeries(rows, FP, input.deadInit);
    if (dead.gaps) warnings.push(`${dead.gaps} Stunden ohne Temperatur/Feuchte in der Vorgeschichte (mit dem letzten Wert überbrückt).`);
    state.dead = {
      series: dead.series, last: dead.last, current: { ...dead.last },
      hoursUsed: dead.hoursUsed, gaps: dead.gaps,
      klassen: FP.tote.klassen,
    };

    // --- FWI
    const dayRows = dailyNoon(rows, FP);
    const fwi = fwiSeries(dayRows, FP, input.start);
    state.fwi = fwi;
    state.fwiTage = fwi.days.length;
    if (fwi.days.length < FP.fwi.minTageFuerFwi) {
      warnings.push(`Nur ${fwi.days.length} Mittagswerte: FWI-Reihe zu kurz (Mindestvorlauf ${FP.fwi.minTageFuerFwi} Tage), Werte nur orientierend.`);
    }
    if (fwi.skipped) warnings.push(`${fwi.skipped} Tage ohne Mittagswerte (FWI dort fortgeschrieben, nicht neu gerechnet).`);
    if (fwi.teilweise > 1) warnings.push(`${fwi.teilweise} Tage mit unvollständiger 24-h-Niederschlagssumme (Fensterrand).`);
    state.ffmcFeuchte = fwi.last ? ffmcMoisture(fwi.last.ffmc) : null;

    // --- lebende Feuchte
    state.live = liveMoisture(now, fwi.last ? fwi.last.dc : null, FP);

    // --- Kennzahlen und Ampel
    state.stats = rainStats(fwi.days, FP);
    state.level = droughtLevel(fwi.last, state.stats, FP);
    state.active = true;
    state.coupling = couplingFactors(state, FP, input.legacy);
    state.attribution = hist.attribution || null;
    return state;
  }

  /**
   * Alles in einem Schritt: Cache lesen, sonst abrufen, sonst Fallback/manuell.
   * store = localStorage-ähnliches Objekt (getItem/setItem) oder null.
   */
  async function load(opts) {
    const FP = opts.FP || defP();
    const now = opts.now ?? Date.now();
    const days = clamp(Math.round(opts.pastDays ?? FP.abruf.pastDaysDefault), FP.abruf.pastDaysMin, FP.abruf.pastDaysMax);
    const notes = [];
    let hist = null;
    const cached = opts.store ? loadCache(opts.store, FP, opts.lat, opts.lon, days, now) : null;
    if (cached && !cached.stale && !opts.force) {
      hist = { ...cached, warnings: [] };
      notes.push(`Vorgeschichte aus dem Zwischenspeicher (${cached.ageH.toFixed(1)} h alt).`);
    } else {
      try {
        hist = await fetchHistory({ ...opts, FP, pastDays: days, now });
        if (opts.store) {
          const s = saveCache(opts.store, FP, hist, opts.lat, opts.lon, days);
          if (!s.ok) notes.push(`Zwischenspeicher nicht verfügbar (${s.error}).`);
          else if (s.reduced) notes.push("Zwischenspeicher: nur jede dritte Stunde gespeichert (Platzgrenze).");
        }
      } catch (e) {
        notes.push(`Abruf gescheitert: ${(e && e.message) || e}`);
        if (cached) {
          hist = { ...cached, warnings: [`Zuletzt geladene Vorgeschichte weiter verwendet (${cached.ageH.toFixed(1)} h alt).`] };
          if (cached.tooOld) notes.push("Zwischenspeicher älter als " + FP.abruf.cacheWarnAgeH + " h: Vorgeschichte veraltet.");
        } else if (opts.manual) {
          hist = manualHistory(opts.manual, { FP, now, pastDays: days });
        }
      }
    }
    const state = compute({ hist, now, FP, enabled: opts.enabled, pastDays: days, start: opts.start, legacy: opts.legacy });
    state.notes = notes;
    for (const w of (hist && hist.warnings) || []) state.warnings.push(w);
    return state;
  }

  const FuelHistory = {
    // Zeit
    tzOffsetMin, localParts,
    // Abruf
    buildForecastUrl, buildArchiveUrl, parseHourly, fetchHistory, manualHistory,
    cacheKey, saveCache, loadCache, load,
    // Feuchte
    equilibriumMoisture, deadMoistureSeries, ffmcMoisture, liveMoisture,
    // FWI
    ffmcStep, dmcStep, dcStep, isiOf, buiOf, fwiOf, dsrOf, dailyNoon, fwiSeries,
    // Kennzahlen/Kopplung
    rainStats, droughtLevel, droughtFraction, couplingFactors, baseMoistureForHours, adaptParams,
    compute,
  };
  root.FuelHistory = FuelHistory;
  if (typeof module !== "undefined" && module.exports) module.exports = FuelHistory;
})(typeof globalThis !== "undefined" ? globalThis : this);
