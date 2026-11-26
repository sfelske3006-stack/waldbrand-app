/*
 * Modul "Windpfeil" (Karten-Interaktion), Rechenteil – OHNE DOM, OHNE Leaflet.
 *
 * Aufgaben:
 *  - Winkelrechnung (Rastung, Interpolation über 0°/360°, Kompasskürzel, Beschriftung)
 *  - Geometrie des Pfeils (für die SVG-Anzeige, aber DOM-frei berechnet)
 *  - Zeitplan "ab HH:MM aus Richtung X mit Y km/h": Stützstellen, Interpolation,
 *    Anwendung auf die Stundenreihe von js/weather.js (überschreibt NUR ab dem jeweiligen
 *    Zeitpunkt; frühere Stunden bleiben echtes Wetter)
 *  - Szenario-Vergleich A/B: Kennzahlenvergleich (Fläche, Hauptrichtung, erreichte Objekte)
 *  - Entprellung und Abbruch-Wache für die automatische Neuberechnung
 *
 * ALLE Zahlen stehen in PARAMS.interaktion.wind (siehe INTEGRATION.md / ASSUMPTIONS.md) und sind
 * ANNAHMEN, solange sie nicht mit der Feuerwehr abgestimmt sind.
 *
 * Schnittstelle (globales Objekt `Windrose`, in Node `module.exports`):
 *   Windrose.norm(d) / angDiff(a,b) / signedDiff(von,nach) / lerpDeg(a,b,t)
 *   Windrose.snapDeg(deg, {step, fine, fineStep})            -> gerastete Richtung
 *   Windrose.compass(deg) / label({dirDeg, kmh, gustKmh})    -> "SW 12 km/h, Böen 25"
 *   Windrose.dirFromPointer({cx, cy, x, y})                  -> Richtung, aus der der Wind kommt
 *   Windrose.arrowGeometry({dirDeg, kmh, radiusPx, ...})     -> Punkte für den SVG-Pfeil
 *   Windrose.normalizeSchedule(entries)                      -> sortiert, geprüft
 *   Windrose.windAt(schedule, t, base, opt)                  -> Wind zum Zeitpunkt t
 *   Windrose.applySchedule(hours, schedule, opt)             -> {hours, info}
 *   Windrose.timeline(hours, schedule, opt)                  -> je Stunde ein Pfeil
 *   Windrose.compare(runA, runB)                             -> Kennzahlenvergleich
 *   Windrose.createDebouncer({delayMs, run, setTimer, clearTimer})
 *   Windrose.createRunGuard() / abortError() / isAbort(e)
 *   Windrose.parseClock(text, refT) / formatClock(t)
 *   Windrose.kmhFromRadius(px, opt) / snapKmh(kmh, opt)      -> Windstaerke beim Ziehen
 *   Windrose.keyAdjust(state, key, opt)                      -> Tastaturbedienung
 *   Windrose.emptyOverride() / setDirection / setSpeed / setGust / setSchedule / clearOverride
 *   Windrose.isManual(ov) / overrideFields(ov) / overrideText(ov)
 *   Windrose.applyOverride(hours, ov, opt)                   -> Stundenreihe mit Kennzeichnung
 *   Windrose.protocolEntry(ov) / exportProps(ov)             -> Protokoll und GeoJSON-Export
 *   Windrose.compareRows(cmp) / contourStyle("A"|"B")        -> Anzeige des A/B-Vergleichs
 *   Windrose.params(PARAMS) / Windrose.DEFAULTS              -> Parameterblock (Annahmen)
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ Winkel
  const norm = (d) => ((Number(d) % 360) + 360) % 360;
  /** kleinster absoluter Winkelabstand (0..180) */
  function angDiff(a, b) { const d = Math.abs(norm(a) - norm(b)) % 360; return d > 180 ? 360 - d : d; }
  /**
   * vorzeichenbehaftete Differenz von -> nach auf dem KÜRZEREN Weg (-180 < d <= 180).
   * Bei genau 180° Unterschied wird im Uhrzeigersinn (positiv) gedreht (Annahme, eindeutig/deterministisch).
   */
  function signedDiff(from, to) {
    let d = norm(to) - norm(from);
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }
  /** Interpolation zwischen zwei Richtungen über den kürzeren Winkelweg (350° -> 10° geht über 0°). */
  function lerpDeg(a, b, t) { return norm(norm(a) + signedDiff(a, b) * t); }

  /**
   * Rastung: Standard auf `step` (Annahme 5°), im Feinmodus auf `fineStep` (Annahme 1°).
   * Rückgabe immer 0..359 (360 -> 0).
   */
  function snapDeg(deg, opt = {}) {
    const step = opt.fine ? (opt.fineStep ?? 1) : (opt.step ?? 5);
    if (!(step > 0)) return norm(deg);
    return norm(Math.round(norm(deg) / step) * step);
  }

  const COMPASS8 = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  /** Kompasskürzel wie in js/app.js (8 Sektoren), damit Beschriftungen übereinstimmen. */
  function compass(deg) { return deg === null || deg === undefined || Number.isNaN(Number(deg)) ? "–" : COMPASS8[Math.round(norm(deg) / 45) % 8]; }

  const numDe = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "–" : Number(v).toLocaleString("de-DE", { maximumFractionDigits: d, minimumFractionDigits: 0 }));

  /** Beschriftung des Pfeils, z. B. "SW 12 km/h, Böen 25" (Richtung = Richtung, AUS der es weht). */
  function label(w = {}) {
    const dir = w.dirDeg === null || w.dirDeg === undefined ? null : norm(w.dirDeg);
    const parts = [`${compass(dir)} ${numDe(w.kmh, 0)} km/h`];
    if (w.gustKmh !== null && w.gustKmh !== undefined && !Number.isNaN(Number(w.gustKmh))) parts.push(`Böen ${numDe(w.gustKmh, 0)}`);
    return parts.join(", ");
  }
  /** Langform für ARIA/Screenreader. */
  function ariaLabel(w = {}) {
    const dir = w.dirDeg === null || w.dirDeg === undefined ? null : norm(w.dirDeg);
    const name = { N: "Nord", NO: "Nordost", O: "Ost", SO: "Südost", S: "Süd", SW: "Südwest", W: "West", NW: "Nordwest" }[compass(dir)] || "unbekannt";
    return `Wind aus ${name}, ${dir === null ? "–" : Math.round(dir)} Grad, ${numDe(w.kmh, 0)} Kilometer pro Stunde${w.gustKmh ? `, Böen ${numDe(w.gustKmh, 0)}` : ""}`;
  }

  // ------------------------------------------------------------------ Bedienung (Ziehen)
  /**
   * Richtung aus der Zeigerposition. Gezogen wird der PFEILKOPF; der Pfeil zeigt in die
   * Strömungsrichtung (dorthin, wo der Wind hinweht) – wie die Ebene "Geländewind" in js/app.js.
   * Die meteorologische Angabe `windDirDeg` ist die Richtung, AUS der der Wind kommt, also + 180°.
   * (cx, cy) = Drehpunkt, (x, y) = Zeigerposition, beide in Bildschirmpixeln (y nach unten).
   * Der Abstand zum Drehpunkt geht NICHT in die Richtung ein: je weiter weg der Finger, desto
   * genauer die Winkelauflösung (langer Hebel) – wichtig für die Bedienung mit Handschuhen.
   */
  function dirFromPointer(p) {
    const dx = p.x - p.cx, dy = p.y - p.cy;
    if (dx === 0 && dy === 0) return null;
    const toDeg = norm((Math.atan2(dx, -dy) * 180) / Math.PI); // Bildschirm: -y = Nord
    return { toDeg, fromDeg: norm(toDeg + 180), radiusPx: Math.hypot(dx, dy) };
  }

  /**
   * Punkte des Pfeils im lokalen SVG-System (0,0 = Drehpunkt, y nach unten).
   * Länge wächst mit der Windstärke (zwischen minLen und radiusPx), rein zur Anzeige.
   */
  function arrowGeometry(o = {}) {
    const dirFrom = norm(o.dirDeg ?? 0);
    const to = norm(dirFrom + 180); // Strömungsrichtung
    const r = o.radiusPx ?? 78;
    const maxKmh = o.maxKmh ?? 120;
    const minLen = o.minLenPx ?? r * 0.45;
    const f = Math.max(0, Math.min(1, (Number(o.kmh) || 0) / maxKmh));
    const len = minLen + (r - minLen) * Math.sqrt(f); // Wurzel: kleine Stärken bleiben unterscheidbar
    const ux = Math.sin((to * Math.PI) / 180), uy = -Math.cos((to * Math.PI) / 180);
    const head = { x: ux * len, y: uy * len };
    const tail = { x: -ux * len * 0.55, y: -uy * len * 0.55 };
    const wing = (sign) => {
      const a = ((to + 180 + sign * 32) * Math.PI) / 180;
      const wl = Math.max(14, len * 0.34);
      return { x: head.x + Math.sin(a) * wl, y: head.y - Math.cos(a) * wl };
    };
    return { dirFrom, dirTo: to, lenPx: len, head, tail, wings: [wing(-1), wing(1)], factor: f };
  }

  // ------------------------------------------------------------------ Zeitplan
  /** Uhrzeit "15:00" / "1500" / "15.00" -> Zeitstempel (ms) am Referenztag; früher als refT -> nächster Tag. */
  function parseClock(text, refT) {
    const m = String(text == null ? "" : text).trim().match(/^(\d{1,2})\s*[:.hH]?\s*(\d{2})?$/);
    if (!m) return null;
    const hh = Number(m[1]), mm = m[2] === undefined ? 0 : Number(m[2]);
    if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
    const ref = new Date(refT ?? Date.now());
    const d = new Date(ref.getTime());
    d.setHours(hh, mm, 0, 0);
    // Vergangene Uhrzeit = kommender Tag (Annahme; der Zeitplan gilt immer in die Zukunft)
    if (d.getTime() < ref.getTime() - 60000) d.setTime(d.getTime() + 24 * 3600000);
    return d.getTime();
  }
  function formatClock(t) {
    if (!Number.isFinite(t)) return "–";
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /**
   * Zeitplan prüfen und sortieren. Jede Stützstelle braucht Zeitpunkt, Richtung und Stärke;
   * Böen sind optional. Gleiche Zeitpunkte: der letzte Eintrag gewinnt (deterministisch).
   */
  function normalizeSchedule(entries) {
    const out = [];
    for (const e of entries || []) {
      const t = Number(e.t);
      const dirDeg = Number(e.dirDeg);
      const kmh = Number(e.kmh);
      if (!Number.isFinite(t) || !Number.isFinite(dirDeg) || !Number.isFinite(kmh)) continue;
      const g = e.gustKmh === null || e.gustKmh === undefined || e.gustKmh === "" ? null : Number(e.gustKmh);
      out.push({ id: e.id || `zp${t}`, t, dirDeg: norm(dirDeg), kmh: Math.max(0, kmh), gustKmh: Number.isFinite(g) ? Math.max(0, g) : null, note: e.note || "" });
    }
    out.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const dedup = [];
    for (const e of out) {
      if (dedup.length && dedup[dedup.length - 1].t === e.t) dedup[dedup.length - 1] = e;
      else dedup.push(e);
    }
    return dedup;
  }

  /**
   * Wind zum Zeitpunkt t.
   *  - vor der ersten Stützstelle: `base` unverändert (echtes Wetter) -> source "echt"
   *  - zwischen zwei Stützstellen: linear interpoliert, Richtung über den kürzeren Winkelweg
   *  - nach der letzten Stützstelle: Wert der letzten Stützstelle gehalten (Annahme `holdAfterLast`)
   * Böen: Stützstelle ohne Böenangabe -> Böen des echten Wetters, mindestens die mittlere
   * Windgeschwindigkeit (Böe kann nicht unter dem Mittelwind liegen) – ANNAHME, gekennzeichnet.
   */
  function windAt(schedule, t, base, opt = {}) {
    const sch = Array.isArray(schedule) && schedule.length && schedule[0] && schedule[0].t !== undefined ? schedule : normalizeSchedule(schedule);
    const b = base || {};
    const baseOut = { windKmh: b.windKmh, windDirDeg: b.windDirDeg, gustKmh: b.gustKmh, source: "echt", entry: null, interpolated: false };
    if (!sch.length || !Number.isFinite(t) || t < sch[0].t) return baseOut;
    const hold = opt.holdAfterLast !== false;
    const last = sch[sch.length - 1];
    const gustOf = (e, kmh) => (e.gustKmh !== null ? e.gustKmh : Math.max(Number.isFinite(Number(b.gustKmh)) ? Number(b.gustKmh) : 0, kmh));
    if (t >= last.t) {
      if (!hold) return baseOut;
      return { windKmh: last.kmh, windDirDeg: last.dirDeg, gustKmh: gustOf(last, last.kmh), source: "zeitplan", entry: last.id, interpolated: false, gustDerived: last.gustKmh === null };
    }
    let i = 0;
    while (i + 1 < sch.length && sch[i + 1].t <= t) i++;
    const a = sch[i], c = sch[i + 1];
    const f = c.t === a.t ? 0 : (t - a.t) / (c.t - a.t);
    const kmh = a.kmh + (c.kmh - a.kmh) * f;
    const dir = lerpDeg(a.dirDeg, c.dirDeg, f);
    let gust;
    let derived = false;
    if (a.gustKmh !== null && c.gustKmh !== null) gust = a.gustKmh + (c.gustKmh - a.gustKmh) * f;
    else { gust = gustOf(a, kmh); derived = a.gustKmh === null; }
    return { windKmh: kmh, windDirDeg: dir, gustKmh: gust, source: "zeitplan", entry: a.id, interpolated: f > 0, gustDerived: derived };
  }

  /**
   * Zeitplan auf die Stundenreihe von Weather.prepareHours anwenden.
   * Stunden VOR der ersten Stützstelle bleiben unverändert (echtes Wetter bzw. die konstante
   * Überschreibung aus dem Bedienfeld). Überschriebene Felder werden wie in js/weather.js in
   * `row.overridden` eingetragen (Anzeige "*") und zusätzlich mit `row.windSource = "zeitplan"`
   * gekennzeichnet.
   */
  function applySchedule(hours, schedule, opt = {}) {
    const sch = normalizeSchedule(schedule);
    const rows = (hours || []).map((r) => ({ ...r, overridden: Array.isArray(r.overridden) ? r.overridden.slice() : [] }));
    const info = { entries: sch.length, firstT: sch.length ? sch[0].t : null, overriddenHours: 0, keptHours: 0, changed: [], gustDerived: false, holdAfterLast: opt.holdAfterLast !== false };
    if (!sch.length) { info.keptHours = rows.length; return { hours: rows, info, schedule: sch }; }
    for (const r of rows) {
      const w = windAt(sch, r.t, r, opt);
      if (w.source !== "zeitplan") { info.keptHours++; r.windSource = "echt"; continue; }
      info.overriddenHours++;
      r.windSource = "zeitplan";
      r.windSchedule = { entry: w.entry, interpoliert: !!w.interpolated };
      // Jede vom Zeitplan bestimmte Stunde ist eine MANUELLE ÜBERSCHREIBUNG und wird als solche
      // gekennzeichnet (row.overridden wie in js/weather.js) – auch dann, wenn der Zahlenwert
      // zufällig dem echten Wetter entspricht. `info.changed` zählt nur zahlenmäßige Änderungen.
      const set = (k, v, round) => {
        const nv = round ? Math.round(v * 10) / 10 : v;
        const was = r[k];
        r[k] = nv;
        if (!r.overridden.includes(k)) r.overridden.push(k);
        const changed = was === null || was === undefined || !(Math.abs(Number(was) - nv) < 1e-9);
        if (changed && !info.changed.includes(k)) info.changed.push(k);
      };
      set("windDirDeg", norm(w.windDirDeg), true);
      set("windKmh", Math.max(0, w.windKmh), true);
      if (w.gustKmh !== null && w.gustKmh !== undefined) set("gustKmh", Math.max(0, w.gustKmh), true);
      if (w.gustDerived) info.gustDerived = true;
    }
    return { hours: rows, info, schedule: sch };
  }

  /** Je Stunde ein Eintrag für die kleine Zeitleiste (Pfeil + Quelle). */
  function timeline(hours, schedule, opt = {}) {
    const sch = normalizeSchedule(schedule);
    return (hours || []).map((r, k) => {
      const w = windAt(sch, r.t, r, opt);
      return {
        index: k, t: r.t, clock: Number.isFinite(r.t) ? formatClock(r.t) : `+${k} h`,
        dirDeg: w.windDirDeg === null || w.windDirDeg === undefined ? null : norm(w.windDirDeg),
        kmh: w.windKmh ?? null, gustKmh: w.gustKmh ?? null,
        source: w.source, interpolated: !!w.interpolated,
        manual: w.source === "zeitplan" || (Array.isArray(r.overridden) && r.overridden.some((x) => x === "windKmh" || x === "windDirDeg" || x === "gustKmh")),
      };
    });
  }

  /** Kurzbeschreibung eines Zeitplans für Protokoll/Export/Anzeige. */
  function scheduleText(schedule) {
    const sch = normalizeSchedule(schedule);
    if (!sch.length) return "kein Zeitplan";
    return sch.map((e) => `ab ${formatClock(e.t)} aus ${Math.round(e.dirDeg)}° (${compass(e.dirDeg)}), ${numDe(e.kmh, 0)} km/h${e.gustKmh !== null ? `, Böen ${numDe(e.gustKmh, 0)}` : ""}`).join("; ");
  }

  // ------------------------------------------------------------------ Szenario-Vergleich A/B
  /** Beschreibung einer Windeinstellung (für Szenarioname, Protokoll, Legende). */
  function windText(w = {}) {
    const parts = [];
    if (w.dirDeg !== null && w.dirDeg !== undefined) parts.push(`aus ${Math.round(norm(w.dirDeg))}° (${compass(w.dirDeg)})`);
    if (w.kmh !== null && w.kmh !== undefined) parts.push(`${numDe(w.kmh, 0)} km/h`);
    if (w.gustKmh !== null && w.gustKmh !== undefined) parts.push(`Böen ${numDe(w.gustKmh, 0)}`);
    if (w.schedule && normalizeSchedule(w.schedule).length) parts.push(`Zeitplan: ${scheduleText(w.schedule)}`);
    return parts.length ? parts.join(", ") : "unverändert (echtes Wetter)";
  }

  const OBJ_LABEL = { wohnbebauung: "Wohnbebauung/Gebäude", strasse: "Hauptstraßen", bahn: "Bahnlinie", schutzgebiet: "Schutzgebiete" };

  /**
   * Kennzahlenvergleich zweier Läufe (A, B). Reine Funktion, erwartet die Struktur aus js/app.js:
   *   run.metrics.perH[{H, likelyHa, possibleHa}], run.metrics.mainDirDeg, run.reach[k].earliest
   * Rückgabe enthält Differenzen; `null` steht für "nicht vorhanden".
   */
  function compare(A, B) {
    const out = { areas: [], mainDir: null, objects: [], wind: null, note: "Beide Werte sind Modellprognosen mit Unsicherheitsband (Ensemble), keine Messung." };
    const pa = (A && A.metrics && A.metrics.perH) || [], pb = (B && B.metrics && B.metrics.perH) || [];
    for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
      const a = pa[k], b = pb[k];
      const d = (x, y) => (x === undefined || y === undefined ? null : y - x);
      const pct = (x, y) => (x === undefined || y === undefined || !(x > 0) ? null : ((y - x) / x) * 100);
      out.areas.push({
        H: (a || b).H,
        aLikelyHa: a ? a.likelyHa : null, bLikelyHa: b ? b.likelyHa : null,
        aPossibleHa: a ? a.possibleHa : null, bPossibleHa: b ? b.possibleHa : null,
        dLikelyHa: d(a && a.likelyHa, b && b.likelyHa), dPossibleHa: d(a && a.possibleHa, b && b.possibleHa),
        dPossiblePct: pct(a && a.possibleHa, b && b.possibleHa),
      });
    }
    const da = A && A.metrics ? A.metrics.mainDirDeg : null, db = B && B.metrics ? B.metrics.mainDirDeg : null;
    out.mainDir = {
      a: da === null || da === undefined ? null : norm(da), b: db === null || db === undefined ? null : norm(db),
      aCompass: compass(da), bCompass: compass(db),
      deltaDeg: da === null || da === undefined || db === null || db === undefined ? null : angDiff(da, db),
    };
    const keys = new Set([...Object.keys((A && A.reach) || {}), ...Object.keys((B && B.reach) || {})]);
    for (const k of keys) {
      const a = A && A.reach && A.reach[k] ? A.reach[k].earliest : null;
      const b = B && B.reach && B.reach[k] ? B.reach[k].earliest : null;
      const fin = (v) => Number.isFinite(v);
      out.objects.push({
        key: k, label: OBJ_LABEL[k] || k, aMin: a, bMin: b,
        deltaMin: fin(a) && fin(b) ? b - a : null,
        aReached: fin(a), bReached: fin(b),
      });
    }
    out.objects.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    out.wind = { a: A && A.windSetting ? windText(A.windSetting) : null, b: B && B.windSetting ? windText(B.windSetting) : null };
    return out;
  }

  // ------------------------------------------------------------------ Entprellung / Abbruch
  /**
   * Entprellung: `trigger()` startet die Wartezeit neu (Annahme 300 ms nach dem Loslassen),
   * danach läuft `run(arg)` genau einmal. Timer sind injizierbar (Tests ohne echte Zeit).
   */
  function createDebouncer(opt = {}) {
    const delay = opt.delayMs ?? 300;
    const setT = opt.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clrT = opt.clearTimer || ((h) => clearTimeout(h));
    let handle = null, lastArg;
    const api = {
      trigger(arg) {
        lastArg = arg;
        if (handle !== null) clrT(handle);
        handle = setT(() => { handle = null; if (opt.run) opt.run(lastArg); }, delay);
        return api;
      },
      cancel() { if (handle !== null) { clrT(handle); handle = null; } return api; },
      flush() { if (handle !== null) { clrT(handle); handle = null; if (opt.run) opt.run(lastArg); } return api; },
      get pending() { return handle !== null; },
      get delayMs() { return delay; },
    };
    return api;
  }

  const ABORT = "WB_INTERAKTION_ABBRUCH";
  /** Fehlerobjekt, mit dem eine laufende Ensemble-Rechnung aus onProgress heraus abgebrochen wird. */
  function abortError(reason) {
    const e = new Error(reason || "Berechnung abgebrochen");
    e.name = ABORT;
    e.wbAbort = true;
    return e;
  }
  function isAbort(e) { return !!(e && (e.wbAbort === true || e.name === ABORT)); }

  /**
   * Wache für "nur die jüngste Rechnung zählt": start() liefert eine Generation; wird erneut
   * gestartet oder abgebrochen, werfen throwIfStale()/check() für ältere Generationen abortError.
   * FireModel.runEnsemble ruft onProgress nach jedem Lauf auf und wartet darauf – der Abbruch
   * wirkt also spätestens nach einem Ensemble-Lauf (ca. 20–40 ms).
   */
  function createRunGuard() {
    let gen = 0, cancelled = false;
    return {
      start() { gen++; cancelled = false; return gen; },
      // Abbruch durch Bedienung: NUR das Abbruchkennzeichen setzen, die Generation bleibt stehen –
      // sonst meldet throwIfStale() "neuere Eingabe" statt "durch Bedienung abgebrochen".
      cancel() { cancelled = true; return gen; },
      get generation() { return gen; },
      get cancelled() { return cancelled; },
      isCurrent(g) { return g === gen && !cancelled; },
      throwIfStale(g) { if (g !== gen || cancelled) throw abortError(g !== gen ? "neuere Eingabe" : "durch Bedienung abgebrochen"); },
    };
  }

  // ------------------------------------------------------------------ Parameter (Annahmen)
  /**
   * Vorgabewerte des Moduls. Bei der Integration gehört dieser Block nach js/params.js
   * (PARAMS.interaktion); hier steht er nur, damit das Modul auch ohne Params-Änderung läuft.
   * ALLE Zahlen sind ANNAHMEN (siehe ASSUMPTIONS.md), keine ist mit der Feuerwehr abgestimmt.
   */
  const DEFAULTS = {
    snapDeg: 5,          // Rastung der Windrichtung beim Ziehen (Grad)
    fineSnapDeg: 1,      // Feinmodus (Umschalter/Shift)
    snapKmh: 1,          // Rastung der Windstärke (km/h)
    fineSnapKmh: 0.5,    // Feinmodus
    maxKmh: 120,         // Obergrenze der Bedienung (Anzeige und Regler)
    radiusPx: 78,        // Radius des Pfeilfelds auf der Karte (Bildschirmpixel)
    minLenPx: 35,        // kürzeste Pfeillänge (bei 0 km/h)
    minDragPx: 18,       // kleinerer Abstand zum Drehpunkt = keine eindeutige Richtung
    debounceMs: 300,     // Neuberechnung erst so lange nach dem Loslassen
    keyStepDeg: 5,       // Tastatur: Pfeiltasten links/rechts
    keyFineStepDeg: 1,   // Tastatur mit Umschalttaste
    keyStepKmh: 1,       // Tastatur: Pfeiltasten hoch/runter
    keyFineStepKmh: 0.5,
    keyPageDeg: 45,      // Bild auf/ab: Sektor weiter
    holdAfterLast: true, // nach der letzten Zeitplan-Stützstelle deren Wert halten
  };

  /** Parameterblock aus PARAMS.interaktion.wind lesen, fehlende Werte aus DEFAULTS. */
  function params(P) {
    const src = (P && P.interaktion && P.interaktion.wind) || {};
    return { ...DEFAULTS, ...src };
  }

  // ------------------------------------------------------------------ Bedienung: Stärke und Tastatur
  /**
   * Windstärke aus dem Abstand des Zeigers zum Drehpunkt – Umkehrung von arrowGeometry():
   * len = minLen + (r - minLen) * sqrt(kmh/maxKmh). Außerhalb des Felds wird auf maxKmh begrenzt.
   * ANNAHME: Wurzelkennlinie, damit kleine Stärken auf dem Tablet unterscheidbar bleiben.
   */
  function kmhFromRadius(radiusPx, opt = {}) {
    const r = opt.radiusPx ?? DEFAULTS.radiusPx;
    const minLen = opt.minLenPx ?? r * 0.45;
    const maxKmh = opt.maxKmh ?? DEFAULTS.maxKmh;
    if (!(r > minLen)) return 0;
    const f = Math.max(0, Math.min(1, (Number(radiusPx) - minLen) / (r - minLen)));
    return Math.max(0, Math.min(maxKmh, f * f * maxKmh));
  }
  /** Rastung der Windstärke (Annahme 1 km/h, Feinmodus 0,5 km/h). */
  function snapKmh(kmh, opt = {}) {
    const step = opt.fine ? (opt.fineKmh ?? DEFAULTS.fineSnapKmh) : (opt.stepKmh ?? DEFAULTS.snapKmh);
    const maxKmh = opt.maxKmh ?? DEFAULTS.maxKmh;
    if (!(step > 0)) return Math.max(0, Math.min(maxKmh, Number(kmh) || 0));
    return Math.max(0, Math.min(maxKmh, Math.round((Number(kmh) || 0) / step) * step));
  }

  /**
   * Tastaturbedienung des Pfeils (der Pfeil ist fokussierbar, role="slider").
   * Links/Rechts = Richtung, Hoch/Runter = Stärke, Bild auf/ab = ganzer Sektor,
   * Pos1/Ende = 0 bzw. Höchstwert der Stärke, Umschalttaste = Feinmodus, "0" = zurück auf echtes Wetter.
   * Reine Funktion: nimmt den Zustand, liefert den neuen Zustand (oder handled=false).
   */
  function keyAdjust(state, key, opt = {}) {
    const p = { ...DEFAULTS, ...opt };
    const fine = !!opt.shift;
    const dStep = fine ? p.keyFineStepDeg : p.keyStepDeg;
    const kStep = fine ? p.keyFineStepKmh : p.keyStepKmh;
    const cur = { dirDeg: norm(state && state.dirDeg !== null && state.dirDeg !== undefined ? state.dirDeg : 0), kmh: Math.max(0, Number(state && state.kmh) || 0) };
    const out = (patch, action) => ({ handled: true, action, dirDeg: norm(patch.dirDeg ?? cur.dirDeg), kmh: snapKmh(patch.kmh ?? cur.kmh, { fine, stepKmh: p.snapKmh, fineKmh: p.fineSnapKmh, maxKmh: p.maxKmh }) });
    switch (key) {
      case "ArrowLeft": return out({ dirDeg: snapDeg(cur.dirDeg - dStep, { fine, step: p.snapDeg, fineStep: p.fineSnapDeg }) }, "richtung");
      case "ArrowRight": return out({ dirDeg: snapDeg(cur.dirDeg + dStep, { fine, step: p.snapDeg, fineStep: p.fineSnapDeg }) }, "richtung");
      case "ArrowUp": return out({ kmh: cur.kmh + kStep }, "staerke");
      case "ArrowDown": return out({ kmh: cur.kmh - kStep }, "staerke");
      case "PageUp": return out({ dirDeg: snapDeg(cur.dirDeg + p.keyPageDeg, { step: p.snapDeg }) }, "richtung");
      case "PageDown": return out({ dirDeg: snapDeg(cur.dirDeg - p.keyPageDeg, { step: p.snapDeg }) }, "richtung");
      case "Home": return out({ kmh: 0 }, "staerke");
      case "End": return out({ kmh: p.maxKmh }, "staerke");
      case "0": return { handled: true, action: "zurueck", reset: true };
      default: return { handled: false };
    }
  }

  // ------------------------------------------------------------------ Manuelle Überschreibung
  /**
   * Zustand der manuellen Windüberschreibung. KENNZEICHNUNG ist Pflicht: im UI, im Ergebnis
   * (row.overridden / windSource), im Protokoll und im Export. Das Konzept ist aus dem Repo
   * übernommen (js/weather.js `overridden`, js/app.js `ueberschrieben`, GeoJSON-Eigenschaften).
   */
  function emptyOverride() {
    return { dirDeg: null, kmh: null, gustKmh: null, schedule: [], manual: false, changedAt: null, quelle: "Bedienung Windpfeil" };
  }
  function isManual(ov) {
    if (!ov) return false;
    return ov.dirDeg !== null && ov.dirDeg !== undefined
      || ov.kmh !== null && ov.kmh !== undefined
      || ov.gustKmh !== null && ov.gustKmh !== undefined
      || (Array.isArray(ov.schedule) && normalizeSchedule(ov.schedule).length > 0);
  }
  /** Felder, die gegenüber dem echten Wetter überschrieben sind (Namen wie in js/weather.js). */
  function overrideFields(ov) {
    const f = [];
    if (!ov) return f;
    if (ov.dirDeg !== null && ov.dirDeg !== undefined) f.push("windDirDeg");
    if (ov.kmh !== null && ov.kmh !== undefined) f.push("windKmh");
    if (ov.gustKmh !== null && ov.gustKmh !== undefined) f.push("gustKmh");
    return f;
  }
  function setDirection(ov, deg, opt = {}) {
    const p = { ...DEFAULTS, ...opt };
    const o = { ...(ov || emptyOverride()) };
    o.dirDeg = snapDeg(deg, { fine: !!opt.fine, step: p.snapDeg, fineStep: p.fineSnapDeg });
    o.manual = true; o.changedAt = opt.now ?? Date.now();
    return o;
  }
  function setSpeed(ov, kmh, opt = {}) {
    const p = { ...DEFAULTS, ...opt };
    const o = { ...(ov || emptyOverride()) };
    o.kmh = snapKmh(kmh, { fine: !!opt.fine, stepKmh: p.snapKmh, fineKmh: p.fineSnapKmh, maxKmh: p.maxKmh });
    o.manual = true; o.changedAt = opt.now ?? Date.now();
    return o;
  }
  function setGust(ov, kmh, opt = {}) {
    const o = { ...(ov || emptyOverride()) };
    o.gustKmh = kmh === null || kmh === undefined || kmh === "" ? null : Math.max(0, Number(kmh));
    o.manual = isManual(o); o.changedAt = opt.now ?? Date.now();
    return o;
  }
  function setSchedule(ov, entries, opt = {}) {
    const o = { ...(ov || emptyOverride()) };
    o.schedule = normalizeSchedule(entries);
    o.manual = isManual(o); o.changedAt = opt.now ?? Date.now();
    return o;
  }
  /** Knopf „Zurück auf echtes Wetter“: alle Überschreibungen verwerfen. */
  function clearOverride() { return emptyOverride(); }

  /**
   * Überschreibung auf die Stundenreihe anwenden (nach Weather.prepareHours).
   *  1. konstante Werte aus dem Pfeil gelten für ALLE Stunden (wie das Bedienfeld „Werte vor Ort
   *     überschreiben“ in js/weather.js),
   *  2. der Zeitplan überschreibt zusätzlich AB seinem jeweiligen Zeitpunkt.
   * Stunden ohne Überschreibung behalten das echte Wetter (windSource "echt").
   */
  function applyOverride(hours, ov, opt = {}) {
    const rows = (hours || []).map((r) => ({ ...r, overridden: Array.isArray(r.overridden) ? r.overridden.slice() : [] }));
    const info = { manual: false, constantFields: [], constantHours: 0, entries: 0, overriddenHours: 0, keptHours: rows.length, changed: [], gustDerived: false, holdAfterLast: opt.holdAfterLast !== false };
    if (!isManual(ov)) { for (const r of rows) r.windSource = r.windSource || "echt"; return { hours: rows, info }; }
    info.manual = true;
    const fields = overrideFields(ov);
    info.constantFields = fields.slice();
    if (fields.length) {
      for (const r of rows) {
        if (ov.dirDeg !== null && ov.dirDeg !== undefined) r.windDirDeg = norm(ov.dirDeg);
        if (ov.kmh !== null && ov.kmh !== undefined) r.windKmh = Math.max(0, Number(ov.kmh));
        if (ov.gustKmh !== null && ov.gustKmh !== undefined) r.gustKmh = Math.max(0, Number(ov.gustKmh));
        for (const k of fields) if (!r.overridden.includes(k)) r.overridden.push(k);
        r.windSource = "pfeil";
      }
      info.constantHours = rows.length;
      for (const k of fields) if (!info.changed.includes(k)) info.changed.push(k);
    }
    const res = applySchedule(rows, ov.schedule, opt);
    info.entries = res.info.entries;
    info.overriddenHours = res.info.overriddenHours;
    info.keptHours = res.info.keptHours;
    info.gustDerived = res.info.gustDerived;
    for (const k of res.info.changed) if (!info.changed.includes(k)) info.changed.push(k);
    // Stunden vor der ersten Stützstelle: echtes Wetter nur, wenn auch keine konstante Überschreibung gilt
    for (const r of res.hours) if (r.windSource === "echt" && fields.length) r.windSource = "pfeil";
    return { hours: res.hours, info, schedule: res.schedule };
  }

  /** Kurztext der Überschreibung für UI, Protokoll und Export. */
  function overrideText(ov) {
    if (!isManual(ov)) return "keine manuelle Überschreibung (echtes Wetter)";
    const parts = [];
    if (ov.dirDeg !== null && ov.dirDeg !== undefined) parts.push(`Richtung aus ${Math.round(norm(ov.dirDeg))}° (${compass(ov.dirDeg)})`);
    if (ov.kmh !== null && ov.kmh !== undefined) parts.push(`${numDe(ov.kmh, 1)} km/h`);
    if (ov.gustKmh !== null && ov.gustKmh !== undefined) parts.push(`Böen ${numDe(ov.gustKmh, 0)} km/h`);
    const sch = normalizeSchedule(ov.schedule);
    if (sch.length) parts.push(`Zeitplan (${sch.length} Stützstelle${sch.length === 1 ? "" : "n"}): ${scheduleText(sch)}`);
    return `MANUELL ÜBERSCHRIEBEN – ${parts.join(", ")}`;
  }

  /** Protokolleintrag (js/protocol.js: Protocol.add("wind_manuell", …)). */
  function protocolEntry(ov, extra = {}) {
    const sch = normalizeSchedule(ov && ov.schedule);
    return {
      manuell: isManual(ov),
      quelle: (ov && ov.quelle) || "Bedienung Windpfeil",
      richtung_aus_grad: ov && ov.dirDeg !== null && ov.dirDeg !== undefined ? Math.round(norm(ov.dirDeg) * 10) / 10 : null,
      wind_kmh: ov && ov.kmh !== null && ov.kmh !== undefined ? Math.round(Number(ov.kmh) * 10) / 10 : null,
      boeen_kmh: ov && ov.gustKmh !== null && ov.gustKmh !== undefined ? Math.round(Number(ov.gustKmh) * 10) / 10 : null,
      zeitplan: sch.map((e) => ({ ab: formatClock(e.t), zeit: Number.isFinite(e.t) ? new Date(e.t).toISOString() : null, richtung_aus_grad: Math.round(e.dirDeg * 10) / 10, wind_kmh: Math.round(e.kmh * 10) / 10, boeen_kmh: e.gustKmh })),
      text: overrideText(ov),
      hinweis: "Manuelle Überschreibung des Windes. Ergebnis ist eine Modellprognose mit vom Bediener gesetzten Eingangswerten, kein gemessenes Wetter.",
      ...extra,
    };
  }

  /** Eigenschaften für den GeoJSON-Export (js/app.js, Feature-properties). */
  function exportProps(ov) {
    const sch = normalizeSchedule(ov && ov.schedule);
    return {
      wind_manuell: isManual(ov),
      wind_manuell_text: overrideText(ov),
      wind_richtung_aus_grad: ov && ov.dirDeg !== null && ov.dirDeg !== undefined ? Math.round(norm(ov.dirDeg) * 10) / 10 : null,
      wind_kmh: ov && ov.kmh !== null && ov.kmh !== undefined ? Math.round(Number(ov.kmh) * 10) / 10 : null,
      wind_boeen_kmh: ov && ov.gustKmh !== null && ov.gustKmh !== undefined ? Math.round(Number(ov.gustKmh) * 10) / 10 : null,
      wind_zeitplan: sch.length ? scheduleText(sch) : null,
    };
  }

  // ------------------------------------------------------------------ Szenario A/B: Anzeige
  /**
   * Konturstile für den Vergleich zweier Windszenarien. Unterscheidbar OHNE Farbe
   * (Strichmuster und Strichstärke), damit die Karte auch bei Sonnenlicht und für
   * Farbfehlsichtige lesbar bleibt. Farben aus css/app.css (Prognose bzw. Vorschläge).
   */
  const SCENARIO_STYLE = {
    A: { key: "A", label: "Szenario A", dashArray: null, weight: 3.5, color: "#0b4f8a", legend: "durchgezogen" },
    B: { key: "B", label: "Szenario B", dashArray: "10 7", weight: 3.5, color: "#b3261e", legend: "gestrichelt" },
  };
  function contourStyle(which) { return { ...(SCENARIO_STYLE[which] || SCENARIO_STYLE.A) }; }

  /** Zeilen des Kennzahlenvergleichs als fertige Texte (Anzeige und Export). */
  function compareRows(cmp) {
    if (!cmp) return [];
    const rows = [];
    const num = (v, d = 1) => (v === null || v === undefined ? "–" : numDe(v, d));
    const sgn = (v, d = 1) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${numDe(v, d)}`);
    for (const a of cmp.areas) {
      rows.push({
        gruppe: "Fläche", name: `${a.H} h „möglich“`, a: `${num(a.aPossibleHa)} ha`, b: `${num(a.bPossibleHa)} ha`,
        delta: `${sgn(a.dPossibleHa)} ha${a.dPossiblePct === null ? "" : ` (${sgn(a.dPossiblePct, 0)} %)`}`,
      });
      rows.push({ gruppe: "Fläche", name: `${a.H} h „wahrscheinlich“`, a: `${num(a.aLikelyHa)} ha`, b: `${num(a.bLikelyHa)} ha`, delta: `${sgn(a.dLikelyHa)} ha` });
    }
    if (cmp.mainDir) {
      rows.push({
        gruppe: "Richtung", name: "Hauptausbreitungsrichtung",
        a: cmp.mainDir.a === null ? "–" : `${Math.round(cmp.mainDir.a)}° (${cmp.mainDir.aCompass})`,
        b: cmp.mainDir.b === null ? "–" : `${Math.round(cmp.mainDir.b)}° (${cmp.mainDir.bCompass})`,
        delta: cmp.mainDir.deltaDeg === null ? "–" : `${numDe(cmp.mainDir.deltaDeg, 0)}° Unterschied`,
      });
    }
    for (const o of cmp.objects) {
      const fm = (v, reached) => (reached ? `${numDe(v, 0)} min` : "nicht erreicht");
      rows.push({
        gruppe: "Objekte", name: `${o.label} erreicht`, a: fm(o.aMin, o.aReached), b: fm(o.bMin, o.bReached),
        delta: o.deltaMin === null ? (o.aReached === o.bReached ? "–" : o.bReached ? "in B zusätzlich erreicht" : "in B nicht mehr erreicht") : `${sgn(o.deltaMin, 0)} min`,
      });
    }
    return rows;
  }

  const Windrose = {
    norm, angDiff, signedDiff, lerpDeg, snapDeg, snapKmh, compass, label, ariaLabel, windText,
    dirFromPointer, kmhFromRadius, arrowGeometry, keyAdjust,
    parseClock, formatClock, normalizeSchedule, windAt, applySchedule, timeline, scheduleText,
    emptyOverride, clearOverride, isManual, overrideFields, setDirection, setSpeed, setGust, setSchedule,
    applyOverride, overrideText, protocolEntry, exportProps,
    compare, compareRows, contourStyle, SCENARIO_STYLE,
    createDebouncer, createRunGuard, abortError, isAbort,
    DEFAULTS, params, COMPASS8, OBJ_LABEL,
  };
  root.Windrose = Windrose;
  if (typeof module !== "undefined" && module.exports) module.exports = Windrose;
})(typeof globalThis !== "undefined" ? globalThis : this);
