/*
 * Modul "Fahrzeuge per Drag & Drop" (Karten-Interaktion).
 *
 * Zwei Teile in einer Datei (klassisches Skript, globales Objekt `VehicleDrag`, kein ES-Import):
 *   1. RECHENTEIL – ohne DOM, ohne Leaflet, in Node testbar:
 *        Zuordnung Fahrzeug -> Riegellinie nach Radius, Anpassung der Linie (verlängern/verschieben),
 *        Sicherheitsprüfung, Warntext mit Zahlen, Hilfslinien, Ablage der reservierten Fahrzeuge
 *        mit Rückgängig/Wiederherstellen, Vergleich vorher/nachher.
 *   2. BEDIENTEIL – `VehicleDrag.attach({...})`: Ziehen mit Maus UND Touch (Pointer Events),
 *        Hilfslinien während des Ziehens, Ablegen, Zurückziehen in die Liste.
 *
 * WIEDERVERWENDUNG statt Neubau (wichtig):
 *   - Die SICHERHEITSPRÜFUNG eines Fahrzeugstandorts ist `Suggest.checkPosition(...)` aus
 *     js/suggest.js. Sie wird aufgerufen, nicht nachgebaut und nicht aufgeweicht.
 *   - Die Gültigkeit einer Riegellinie wird mit demselben Kriterium geprüft, das `evalCells()`
 *     in js/suggest.js je Zelle anwendet: `!ctx.readyMask[i] && ctx.distReady[i] >= lineClearanceM`.
 *     `ctx` stammt aus `Suggest.context(...)`; die Rasterung der Linie aus `Grid.rasterLine(...)`.
 *     (`evalCells` selbst ist in js/suggest.js nicht exportiert – siehe INTEGRATION.md.)
 *   - Bereitschaftszeiten kommen aus `Dispatch.readiness(...)` / `Dispatch.estimate(...)`.
 *
 * ALLE Zahlen stehen in PARAMS.interaktion.drag (hier als DEFAULTS) und sind ANNAHMEN,
 * solange sie nicht mit der Feuerwehr abgestimmt sind (siehe ASSUMPTIONS.md).
 */
(function (root) {
  "use strict";

  const G = () => root.Grid;
  const S_ = () => root.Suggest;
  const D_ = () => root.Dispatch;

  // ------------------------------------------------------------------ Parameter (Annahmen)
  const DEFAULTS = {
    // ANNAHME: Wird ein Fahrzeug näher als dieser Radius an einer Riegellinie abgelegt, gilt es als
    // dieser Linie zugeordnet. 150 m ~ halber wirksamer Abschnitt (sectionPerVehicleM 300 m).
    snapRadiusM: 150,
    // ANNAHME: Die Linie darf sich höchstens so weit zum Fahrzeug hin verlängern (je Ende).
    maxExtendM: 300,
    // ANNAHME: ... und höchstens so weit quer verschieben.
    maxShiftM: 60,
    // Schrittweite, in der die Verschiebung geprüft wird (m); kleinere Schritte = feiner, langsamer.
    shiftStepM: 10,
    // Hilfslinie zur nächsten Entnahmestelle nur bis zu dieser Entfernung zeichnen (m).
    waterGuideMaxM: 2000,
    // Mindestgröße der Ziehpunkte in Bildschirmpixeln (wie --tap in css/app.css).
    tapTargetPx: 52,
    // ANNAHME: Von Hand gesetzte Fahrzeuge sind gegen automatisches Umsetzen gesperrt.
    lockOnDrop: true,
    // Tiefe der Rückgängig-Liste (Schritte).
    undoDepth: 20,
  };
  function params(P) {
    const src = (P && P.interaktion && P.interaktion.drag) || {};
    return { ...DEFAULTS, ...src };
  }

  const fmtMin = (m) => (S_() && S_().fmtMin ? S_().fmtMin(m) : `${Math.round(m)} min`);
  const numDe = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "–" : Number(v).toLocaleString("de-DE", { maximumFractionDigits: d }));

  // ------------------------------------------------------------------ Geometrie (Meter, Rasterkoordinaten)
  /** Fußpunkt und Abstand eines Punktes zu einer Polylinie. t = Bogenlängenanteil 0..1. */
  function projectOnPolyline(pts, x, y) {
    if (!pts || !pts.length) return null;
    if (pts.length === 1) return { distM: Math.hypot(x - pts[0][0], y - pts[0][1]), foot: pts[0].slice(), seg: 0, u: 0, t: 0, before: false, after: false, offsetM: 0, side: 0 };
    let best = null, acc = 0, total = 0;
    const segLen = [];
    for (let k = 1; k < pts.length; k++) { const s = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); segLen.push(s); total += s; }
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1][0], ay = pts[k - 1][1], bx = pts[k][0], by = pts[k][1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const uRaw = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      const u = Math.max(0, Math.min(1, uRaw));
      const fx = ax + u * dx, fy = ay + u * dy;
      const d = Math.hypot(x - fx, y - fy);
      if (!best || d < best.distM) {
        const len = l2 > 0 ? Math.sqrt(l2) : 0;
        const side = len > 0 ? Math.sign((dx * (y - ay) - dy * (x - ax)) / len) : 0;
        best = { distM: d, foot: [fx, fy], seg: k - 1, u, uRaw, t: total > 0 ? (acc + u * segLen[k - 1]) / total : 0, side, lengthM: total };
      }
      acc += segLen[k - 1];
    }
    // "vor dem Anfang" / "hinter dem Ende": Lot fällt außerhalb des ersten/letzten Abschnitts
    best.before = best.seg === 0 && best.uRaw < 0;
    best.after = best.seg === pts.length - 2 && best.uRaw > 1;
    best.offsetM = best.distM;
    return best;
  }

  /** Nächstgelegene Riegellinie innerhalb des Zuordnungsradius (Annahme snapRadiusM). */
  function nearestLine(g, lines, x, y, P) {
    const p = params(P);
    let best = null;
    for (const l of lines || []) {
      const pts = l.xy || (l.latlngs || []).map(([la, lo]) => g.proj.toXY(la, lo));
      if (!pts.length) continue;
      const pr = projectOnPolyline(pts, x, y);
      if (!pr) continue;
      if (!best || pr.distM < best.distM) best = { line: l, pts, ...pr };
    }
    if (!best) return null;
    best.inRadius = best.distM <= p.snapRadiusM;
    best.snapRadiusM = p.snapRadiusM;
    return best;
  }

  /** Zellen einer Polylinie (Rasterlinie wie in js/suggest.js). */
  function lineCells(g, pts) {
    const cells = [];
    G().rasterLine(g, pts, (i) => { if (cells[cells.length - 1] !== i) cells.push(i); });
    return cells;
  }

  /**
   * Sicherheitsprüfung einer (geänderten) Riegellinie. Das Zellkriterium steht seit 0.8.0 NUR in
   * js/suggest.js (`Suggest.lineCellsOk`, dieselbe Funktion, die `evalCells()` benutzt) – hier wird
   * es aufgerufen, nicht kopiert. Nichts wird aufgeweicht.
   */
  function lineSafe(g, ctx, P, cells) {
    const Sg = S_();
    if (!Sg || typeof Sg.lineCellsOk !== "function") {
      throw new Error("VehicleDrag: js/suggest.js mit Suggest.lineCellsOk wird benötigt (Linienkriterium).");
    }
    return Sg.lineCellsOk(ctx, P, cells);
  }

  /**
   * Linie zum Fahrzeug hin anpassen.
   * Reihenfolge (ANNAHME):
   *   1. "unveraendert": Lot liegt innerhalb der Linie und der Abstand ist klein (<= 1 Zelle).
   *   2. "verlaengern": Lot liegt hinter einem Ende -> dieses Ende wird entlang der eigenen
   *      Achse bis zum Lot des Fahrzeugs verlängert (höchstens maxExtendM).
   *   3. "verschieben": sonst wird die GANZE Linie quer zu ihrer Achse zum Fahrzeug hin
   *      verschoben (höchstens maxShiftM), in Schritten von shiftStepM, so weit es sicher bleibt.
   * Jede Zwischenstufe wird mit lineSafe() geprüft; die größte sichere Stufe gewinnt.
   * Ist keine Stufe sicher, bleibt die Linie UNVERÄNDERT (ok:false).
   */
  function adjustLine(g, ctx, P, line, x, y, opt = {}) {
    const p = params(P);
    const pts0 = (line.xy || (line.latlngs || []).map(([la, lo]) => g.proj.toXY(la, lo))).map((q) => [q[0], q[1]]);
    const out = (mode, pts, safe, extra) => {
      const cells = lineCells(g, pts);
      return {
        ok: true, changed: mode !== "unveraendert", mode, xy: pts, cells,
        latlngs: pts.map(([a, b]) => g.proj.toLatLng(a, b)),
        lengthM: polyLength(pts), minClearanceM: safe.minClearanceM, minArrivalMin: safe.minArrivalMin,
        ...extra,
      };
    };
    if (pts0.length < 2) return { ok: false, changed: false, mode: "unveraendert", reason: "Linie ohne Geometrie.", xy: pts0, latlngs: line.latlngs || [], cells: line.cells || [] };
    const pr = projectOnPolyline(pts0, x, y);
    const base = lineSafe(g, ctx, P, lineCells(g, pts0));

    // 1. nichts zu tun
    if (!pr.before && !pr.after && pr.distM <= g.cell) return out("unveraendert", pts0, base, { reason: "Fahrzeug steht bereits an der Linie; keine Anpassung nötig." });

    const tries = [];
    // 2. verlängern (nur wenn das Lot hinter einem Ende liegt)
    if (pr.before || pr.after) {
      const atEnd = pr.after;
      const a = atEnd ? pts0[pts0.length - 2] : pts0[1];
      const b = atEnd ? pts0[pts0.length - 1] : pts0[0];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const need = Math.max(0, (x - b[0]) * ux + (y - b[1]) * uy); // Projektion des Fahrzeugs auf die Achse
      const extend = Math.min(need, p.maxExtendM);
      for (let d = extend; d >= p.shiftStepM; d -= p.shiftStepM) {
        const nb = [b[0] + ux * d, b[1] + uy * d];
        const pts = pts0.slice();
        if (atEnd) pts[pts.length - 1] = nb; else pts[0] = nb;
        tries.push({ mode: "verlaengern", pts, amountM: d, capped: need > p.maxExtendM });
      }
    }
    // 3. verschieben (quer zur Achse zum Fahrzeug hin)
    {
      const a = pts0[0], b = pts0[pts0.length - 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len; // Normale
      const sgn = Math.sign((x - pr.foot[0]) * nx + (y - pr.foot[1]) * ny) || 1;
      const want = Math.min(pr.distM, p.maxShiftM);
      for (let d = want; d >= p.shiftStepM; d -= p.shiftStepM) {
        tries.push({ mode: "verschieben", pts: pts0.map(([qx, qy]) => [qx + nx * sgn * d, qy + ny * sgn * d]), amountM: d, capped: pr.distM > p.maxShiftM });
      }
    }

    for (const t of tries) {
      const cells = lineCells(g, t.pts);
      const safe = lineSafe(g, ctx, P, cells);
      if (!safe.ok) continue;
      const S = P.suggestions;
      const lead = safe.minArrivalMin - ctx.readyMin;
      if (lead < (S.lineMinLeadMin || 0)) continue; // Mindest-Wirkzeit bleibt gewahrt
      return out(t.mode, t.pts, safe, {
        amountM: Math.round(t.amountM), capped: !!t.capped,
        reason: `${t.mode === "verlaengern" ? "Linie um" : "Linie quer verschoben um"} ca. ${Math.round(t.amountM)} m ${t.mode === "verlaengern" ? "zum Fahrzeug hin verlängert" : "zum Fahrzeug hin"}${t.capped ? ` (begrenzt auf ${t.mode === "verlaengern" ? p.maxExtendM : p.maxShiftM} m, Annahme)` : ""}. Sicherheitsprüfung aus js/suggest.js weiterhin erfüllt: geringster Abstand zur „möglich“-Zone zum Prüfzeitpunkt ${Math.round(safe.minClearanceM)} m (gefordert ${S.lineClearanceM} m), Vorlauf ${fmtMin(lead)} (gefordert ${S.lineMinLeadMin || 0} min).`,
      });
    }

    const last = lineSafe(g, ctx, P, lineCells(g, (tries[0] || { pts: pts0 }).pts));
    return {
      ok: false, changed: false, mode: "unveraendert", xy: pts0, cells: lineCells(g, pts0),
      latlngs: pts0.map(([a, b]) => g.proj.toLatLng(a, b)), lengthM: polyLength(pts0),
      minClearanceM: base.minClearanceM, minArrivalMin: base.minArrivalMin,
      reason: `Linie bleibt unverändert: jede geprüfte Anpassung würde die Sicherheitsprüfung verletzen. ${last.reason}`,
    };
  }

  function polyLength(pts) { let s = 0; for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return s; }

  // ------------------------------------------------------------------ Prüfung des Ablageorts
  /**
   * Prüft einen von Hand gewählten Fahrzeugstandort. Die Prüfung selbst ist
   * `Suggest.checkPosition` (js/suggest.js) – hier kommen nur die Zahlen für die Warnung dazu:
   *   "Front erreicht Position nach X min, Einsatzbereitschaft erst nach Y min".
   * X = Zeit, ab der die Zelle „möglich“ ist (tPossible, Ensemble-Schwelle);
   *     zusätzlich wird der früheste EINZELNE Lauf genannt.
   * Y = Einsatzbereitschaft des Fahrzeugs am Ort (Dispatch.readiness, sonst Anfahrt + Aufbau).
   * Platzieren bleibt immer erlaubt; die Warnung geht ins Protokoll.
   */
  function checkDrop(g, result, ctx, P, veh, lat, lon, opt = {}) {
    const S = P.suggestions;
    const Sg = S_();
    const [x, y] = g.proj.toXY(lat, lon);
    const k = G().cellOf(g, x, y);
    const outside = k < 0;
    const ready = opt.readyMin !== undefined && opt.readyMin !== null ? opt.readyMin : readinessOf(veh, lat, lon, P, opt);
    const readyMin = ready && ready.ok ? ready.ready : null;
    const chk = Sg.checkPosition(g, result, ctx, P, lat, lon, readyMin === null ? undefined : readyMin);
    const tP = outside ? Infinity : ctx.tP[k];
    const earliest = outside ? Infinity : result.earliest[k];
    const needMin = (readyMin === null ? ctx.readyMin : readyMin) + S.vehicleSafetyMin;
    const parts = [];
    if (!outside) {
      parts.push(`Front („möglich“, ≥ ${Math.round(P.ensemble.possible * 100)} % der Läufe) erreicht die Position nach ${fmtMin(tP)}, frühester einzelner Lauf ${fmtMin(earliest)}; Einsatzbereitschaft erst nach ${readyMin === null ? `${Math.round(ctx.readyMin)} min (Ersatzwert)` : `${Math.round(readyMin)} min`}${ready && ready.ok && ready.kind ? ` (${ready.kind === "vorgabe" ? "Vorgabe Auftraggeber" : "geschätzt, kein Routing"})` : ""}.`);
      parts.push(`Gefordert: „möglich“ frühestens nach ${Math.round(needMin)} min (Bereitschaft + ${S.vehicleSafetyMin} min Puffer), kein einzelner Lauf vor der Bereitschaft, mindestens ${S.vehicleMinDistM} m Abstand zum 1-h-Bereich (hier ${Math.round(chk.distTo1hM === undefined ? NaN : chk.distTo1hM)} m).`);
    } else parts.push("Position liegt außerhalb des Rechengebiets; keine Prüfung möglich.");
    return {
      ok: !outside && chk.ok,
      outside,
      cell: k,
      frontMin: tP, earliestMin: earliest, readyMin, needMin,
      distTo1hM: chk.distTo1hM,
      readiness: ready,
      checkText: chk.text,
      warnText: !outside && chk.ok ? "" : parts.join(" "),
      text: `${chk.text} ${parts.join(" ")}`.trim(),
      kurz: outside ? "außerhalb des Rechengebiets" : chk.ok ? "Sicherheitsannahmen erfüllt" : `Front nach ${fmtMin(tP)}, Bereitschaft nach ${readyMin === null ? Math.round(ctx.readyMin) : Math.round(readyMin)} min`,
    };
  }

  /** Bereitschaft eines Fahrzeugs am Ort (Dispatch.readiness; ohne Daten null). */
  function readinessOf(veh, lat, lon, P, opt = {}) {
    const Dp = D_();
    if (!Dp || !veh) return null;
    const stMap = opt.stationMap || Dp.stationMap(opt.stations || []);
    const setup = opt.setupMin !== undefined ? opt.setupMin : P.suggestions.setupMin;
    try { return Dp.readiness(veh.vehicle || veh, stMap, lat, lon, setup, P, opt.teil); } catch { return null; }
  }

  // ------------------------------------------------------------------ Hilfslinien beim Ziehen
  /**
   * Hilfslinien: Entfernung zur Front, nächstgelegene Riegellinie, Wasserentnahmestelle in der Nähe.
   * "Front" = Rand der „möglich“-Zone zum Prüfzeitpunkt (ctx.distReady, dieselbe Zone, gegen die
   * js/suggest.js prüft) und zusätzlich der 1-h-Bereich (ctx.dist1h, Mindestabstand).
   */
  function guides(g, ctx, P, opt = {}) {
    const { lat, lon } = opt;
    const [x, y] = g.proj.toXY(lat, lon);
    const k = G().cellOf(g, x, y);
    const p = params(P);
    const res = { front: null, line: null, water: null, outside: k < 0 };
    if (k >= 0) {
      res.front = {
        distReadyM: ctx.distReady[k], dist1hM: ctx.dist1h[k], frontMin: ctx.tP[k],
        text: `Front: ${Math.round(ctx.distReady[k])} m bis zur „möglich“-Zone (Prüfzeitpunkt ${Math.round(ctx.checkMin)} min), ${Math.round(ctx.dist1h[k])} m bis zum 1-h-Bereich; erreicht die Position nach ${fmtMin(ctx.tP[k])}.`,
      };
    }
    const nl = nearestLine(g, opt.lines || [], x, y, P);
    if (nl) {
      res.line = {
        id: nl.line.id, name: opt.lineName ? opt.lineName(nl.line) : nl.line.id, distM: nl.distM,
        foot: g.proj.toLatLng(nl.foot[0], nl.foot[1]), inRadius: nl.inRadius,
        text: `Nächste Riegelstellung ${opt.lineName ? opt.lineName(nl.line) : nl.line.id}: ${Math.round(nl.distM)} m${nl.inRadius ? ` – innerhalb des Zuordnungsradius (${nl.snapRadiusM} m, Annahme)` : ` – außerhalb des Zuordnungsradius (${nl.snapRadiusM} m)`}.`,
      };
    }
    const wp = (opt.waterPoints || []).filter((w) => w && !w.deleted && Number.isFinite(w.lat) && Number.isFinite(w.lon));
    if (wp.length) {
      let best = null;
      for (const w of wp) {
        const d = D_() ? D_().haversineM(lat, lon, w.lat, w.lon) : Math.hypot(...g.proj.toXY(w.lat, w.lon).map((v, i) => v - [x, y][i]));
        if (!best || d < best.distM) best = { point: w, distM: d };
      }
      if (best && best.distM <= p.waterGuideMaxM) {
        best.text = `Nächste Entnahmestelle (${best.point.kind || "unbekannt"}, ${best.point.verified ? "verifiziert" : "nicht verifiziert"}): ${Math.round(best.distM)} m Luftlinie${best.distM <= P.suggestions.hoseMaxM ? " – Schlauchleitung möglich" : " – Pendelverkehr nötig (Annahme)"}.`;
        res.water = best;
      }
    }
    return res;
  }

  // ------------------------------------------------------------------ Ablage der reservierten Fahrzeuge
  /**
   * Zustand der von Hand gesetzten Fahrzeuge ("reserviert"). Reine Datenhaltung mit
   * Rückgängig/Wiederherstellen über flache Schnappschüsse (die Liste ist klein, deshalb
   * ohne großen Aufwand machbar).
   */
  function createStore(opt = {}) {
    const depth = opt.undoDepth ?? DEFAULTS.undoDepth;
    let items = [];
    const undo = [], redo = [];
    const clone = (l) => l.map((e) => ({ ...e }));
    const snap = () => { undo.push(clone(items)); if (undo.length > depth) undo.shift(); redo.length = 0; };
    const api = {
      get all() { return clone(items); },
      get(id) { const e = items.find((q) => q.id === id); return e ? { ...e } : null; },
      has(id) { return items.some((q) => q.id === id); },
      get canUndo() { return undo.length > 0; },
      get canRedo() { return redo.length > 0; },
      place(e) {
        snap();
        const k = items.findIndex((q) => q.id === e.id);
        const rec = { locked: true, manual: true, ...e, at: e.at ?? (opt.now ? opt.now() : Date.now()) };
        if (k >= 0) items[k] = { ...items[k], ...rec }; else items.push(rec);
        return { ...rec };
      },
      move(id, patch) {
        const k = items.findIndex((q) => q.id === id);
        if (k < 0) return null;
        snap();
        items[k] = { ...items[k], ...patch, manual: true };
        return { ...items[k] };
      },
      setLocked(id, locked) {
        const k = items.findIndex((q) => q.id === id);
        if (k < 0) return null;
        snap();
        items[k] = { ...items[k], locked: !!locked };
        return { ...items[k] };
      },
      remove(id) {
        const k = items.findIndex((q) => q.id === id);
        if (k < 0) return null;
        snap();
        const [e] = items.splice(k, 1);
        return { ...e };
      },
      clear() { snap(); items = []; },
      undo() { if (!undo.length) return false; redo.push(clone(items)); items = undo.pop(); return true; },
      redo() { if (!redo.length) return false; undo.push(clone(items)); items = redo.pop(); return true; },
      load(list) { items = clone(list || []); undo.length = 0; redo.length = 0; },
      /** Ids, die gegen automatisches Umsetzen gesperrt sind. */
      lockedIds() { return items.filter((e) => e.locked).map((e) => e.id); },
    };
    return api;
  }

  /** Unterschied zweier Fahrzeugverteilungen – für „Neu berechnen zeigt den Unterschied“. */
  function diffPlacements(before, after, opt = {}) {
    const tol = opt.toleranceM ?? 25;
    const key = (e) => String(e.id);
    const a = new Map((before || []).map((e) => [key(e), e]));
    const b = new Map((after || []).map((e) => [key(e), e]));
    const added = [], removed = [], moved = [], kept = [], retasked = [];
    const distM = (p, q) => (D_() ? D_().haversineM(p.lat, p.lon, q.lat, q.lon) : Math.hypot((p.lat - q.lat) * 111195, (p.lon - q.lon) * 111195));
    for (const [k, e] of b) {
      if (!a.has(k)) { added.push({ id: k, task: e.task || null }); continue; }
      const o = a.get(k);
      const d = distM(o, e);
      if (d > tol) moved.push({ id: k, distM: Math.round(d), von: [o.lat, o.lon], nach: [e.lat, e.lon], gesperrt: !!e.locked });
      else kept.push({ id: k });
      if ((o.task || null) !== (e.task || null)) retasked.push({ id: k, von: o.task || null, nach: e.task || null });
    }
    for (const [k, e] of a) if (!b.has(k)) removed.push({ id: k, task: e.task || null });
    const text = `Unterschied: ${added.length} neu, ${removed.length} entfallen, ${moved.length} verschoben (> ${tol} m), ${retasked.length} mit anderer Aufgabe, ${kept.length} unverändert. Von Hand gesetzte, gesperrte Fahrzeuge bleiben stehen.`;
    return { added, removed, moved, retasked, kept, toleranceM: tol, text };
  }

  /** Protokolleintrag für eine Ablage/Verschiebung (js/protocol.js). */
  function protocolEntry(kind, rec, chk, adj) {
    return {
      aktion: kind,
      fahrzeug: rec.id,
      bezeichnung: rec.label || null,
      lat: Number.isFinite(rec.lat) ? +rec.lat.toFixed(6) : null,
      lon: Number.isFinite(rec.lon) ? +rec.lon.toFixed(6) : null,
      von_hand: true,
      gesperrt: !!rec.locked,
      riegel: rec.lineId || null,
      linie_angepasst: adj ? { modus: adj.mode, geaendert: !!adj.changed, meter: adj.amountM ?? null, begruendung: adj.reason } : null,
      pruefung: chk ? { erfuellt: !!chk.ok, front_min: Number.isFinite(chk.frontMin) ? Math.round(chk.frontMin) : null, frueheste_ankunft_min: Number.isFinite(chk.earliestMin) ? Math.round(chk.earliestMin) : null, bereitschaft_min: chk.readyMin === null ? null : Math.round(chk.readyMin), text: chk.text } : null,
      warnung: chk && !chk.ok ? chk.warnText : null,
      hinweis: "Von Hand gesetzter Standort. Vorschläge sind keine Anordnung; Entscheidung und Verantwortung liegen bei der Einsatzleitung.",
    };
  }

  /** Eigenschaften für den GeoJSON-Export. */
  function exportProps(rec, chk) {
    return {
      typ: "fahrzeug_manuell",
      fahrzeug: rec.label || rec.id,
      aufgabe: rec.task || null,
      von_hand_gesetzt: true,
      gesperrt: !!rec.locked,
      riegel: rec.lineId || null,
      pruefung_erfuellt: chk ? !!chk.ok : null,
      warnung: chk && !chk.ok ? chk.warnText : null,
    };
  }

  // ------------------------------------------------------------------ Bedienteil (DOM + Leaflet)
  /**
   * Ziehen mit Maus UND Touch über Pointer Events (ein Codeweg für beides; `touch-action: none`
   * auf den Ziehpunkten verhindert das Scrollen/Zoomen der Seite). Leaflets eigenes
   * `marker.dragging` wird bewusst NICHT genutzt, weil die Hilfslinien dieselben Ereignisse
   * brauchen und das Ziehen aus der LISTE heraus ohnehin eigene Behandlung erfordert.
   *
   * attach({map, getState, onDrop, onMove, onRemove, listSelector, P}) -> Controller
   *   getState() -> {grid, result, ctx, lines, waterPoints, vehicles, stations, teil}
   */
  function attach(cfg) {
    const doc = root.document;
    const L = root.L;
    if (!doc || !L || !cfg || !cfg.map) throw new Error("VehicleDrag.attach: Karte, DOM und Leaflet nötig");
    const map = cfg.map;
    const P = cfg.P || root.PARAMS;
    const p = params(P);
    const store = cfg.store || createStore({ undoDepth: p.undoDepth });

    const guideLayer = L.layerGroup().addTo(map);
    const markerLayer = L.layerGroup().addTo(map);
    const ghost = doc.createElement("div");
    ghost.className = "wb-drag-ghost";
    ghost.hidden = true;
    doc.body.appendChild(ghost);
    const hint = doc.createElement("div");
    hint.className = "wb-drag-hint";
    hint.setAttribute("role", "status");
    hint.setAttribute("aria-live", "polite");
    hint.hidden = true;
    (cfg.hintParent || map.getContainer().parentNode || doc.body).appendChild(hint);

    let drag = null;

    const state = () => (cfg.getState ? cfg.getState() : {});
    const lineName = (l) => (cfg.lineName ? cfg.lineName(l) : l.id);

    function clearGuides() { guideLayer.clearLayers(); }

    function drawGuides(latlng) {
      clearGuides();
      const st = state();
      if (!st.grid || !st.ctx) return null;
      const gg = guides(st.grid, st.ctx, P, { lat: latlng.lat, lon: latlng.lng, lines: st.lines || [], waterPoints: st.waterPoints || [], lineName });
      const texts = [];
      if (gg.front) {
        texts.push(gg.front.text);
        // Hilfslinie zur Front: kürzester Weg zur „möglich“-Zone wird nicht gesucht (Chamfer-Distanz
        // liefert nur den Abstand); stattdessen Kreis mit diesem Radius – ehrliche Darstellung.
        L.circle(latlng, { radius: Math.max(1, gg.front.distReadyM), className: "wb-guide-front", color: "#6a1b9a", weight: 2, dashArray: "4 6", fill: false, interactive: false }).addTo(guideLayer);
      }
      if (gg.line) {
        texts.push(gg.line.text);
        L.polyline([latlng, gg.line.foot], { className: "wb-guide-line", color: "#6a1b9a", weight: 4, dashArray: "10 6", interactive: false }).addTo(guideLayer);
        L.marker(gg.line.foot, { icon: L.divIcon({ className: "", html: `<span class="wb-guide-label">${Math.round(gg.line.distM)} m → ${esc(lineName(gg.line))}</span>`, iconSize: null, iconAnchor: [-8, 10] }), interactive: false, keyboard: false }).addTo(guideLayer);
      }
      if (gg.water) {
        texts.push(gg.water.text);
        L.polyline([latlng, [gg.water.point.lat, gg.water.point.lon]], { className: "wb-guide-water", color: "#0b4f8a", weight: 4, dashArray: "2 7", interactive: false }).addTo(guideLayer);
        L.marker([gg.water.point.lat, gg.water.point.lon], { icon: L.divIcon({ className: "", html: `<span class="wb-guide-label water">${Math.round(gg.water.distM)} m Wasser</span>`, iconSize: null, iconAnchor: [-8, 10] }), interactive: false, keyboard: false }).addTo(guideLayer);
      }
      hint.hidden = !texts.length;
      hint.textContent = texts.join(" · ");
      return gg;
    }

    const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    function pointInMap(ev) {
      const r = map.getContainer().getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      return { inside, latlng: inside ? map.containerPointToLatLng([ev.clientX - r.left, ev.clientY - r.top]) : null };
    }
    function overList(ev) {
      const el = doc.elementFromPoint(ev.clientX, ev.clientY);
      return !!(el && cfg.listSelector && el.closest && el.closest(cfg.listSelector));
    }

    function startDrag(ev, info) {
      if (drag) return;
      ev.preventDefault();
      drag = { ...info, pointerId: ev.pointerId, moved: false };
      try { ev.target.setPointerCapture(ev.pointerId); drag.capture = ev.target; } catch { /* ohne Capture weiter */ }
      map.dragging.disable();
      ghost.hidden = false;
      ghost.textContent = info.label;
      moveGhost(ev);
      doc.addEventListener("pointermove", onMove, { passive: false });
      doc.addEventListener("pointerup", onUp);
      doc.addEventListener("pointercancel", onUp);
    }
    function moveGhost(ev) { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; }
    function onMove(ev) {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      ev.preventDefault();
      drag.moved = true;
      moveGhost(ev);
      const pm = pointInMap(ev);
      ghost.classList.toggle("over-map", pm.inside);
      ghost.classList.toggle("over-list", !pm.inside && overList(ev));
      if (pm.inside) drag.last = drawGuides(pm.latlng); else { clearGuides(); hint.hidden = true; }
      drag.lastLatLng = pm.latlng;
    }
    function onUp(ev) {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      doc.removeEventListener("pointercancel", onUp);
      try { if (drag.capture) drag.capture.releasePointerCapture(drag.pointerId); } catch { /* egal */ }
      ghost.hidden = true;
      ghost.className = "wb-drag-ghost";
      clearGuides();
      hint.hidden = true;
      map.dragging.enable();
      const d = drag; drag = null;
      const pm = pointInMap(ev);
      if (pm.inside && pm.latlng) api.drop(d.vehicle, pm.latlng.lat, pm.latlng.lng, { from: d.from });
      else if (d.from === "karte" && overList(ev)) api.remove(d.vehicle.id, "in die Liste zurückgezogen");
      else if (d.from === "karte") api.remove(d.vehicle.id, "außerhalb der Karte abgelegt");
      if (cfg.onAfter) cfg.onAfter();
    }

    /** Ziehpunkt in der Fahrzeugliste anmelden (Element mit data-veh-id). */
    function bindListItem(el, vehicle) {
      el.style.touchAction = "none";
      el.addEventListener("pointerdown", (ev) => {
        if (ev.button !== undefined && ev.button !== 0) return;
        startDrag(ev, { vehicle, label: vehicle.label || vehicle.id, from: "liste" });
      });
    }

    function render() {
      markerLayer.clearLayers();
      for (const rec of store.all) {
        const icon = L.divIcon({
          className: "",
          html: `<span class="veh-marker manual${rec.locked ? " locked" : ""}${rec.warn ? " warn" : ""}" data-veh="${esc(rec.id)}">${rec.locked ? '<span class="lockmark" aria-hidden="true">🔒</span>' : ""}${esc(rec.label || rec.id)}${rec.warn ? '<span class="warnmark" aria-hidden="true">⚠</span>' : ""}</span>`,
          iconSize: null, iconAnchor: [30, 14],
        });
        const mk = L.marker([rec.lat, rec.lon], { icon, keyboard: true, alt: `${rec.label || rec.id}, von Hand gesetzt${rec.locked ? ", gesperrt" : ""}${rec.warn ? ", Warnung" : ""}` }).addTo(markerLayer);
        mk.bindTooltip(`${esc(rec.label || rec.id)}${rec.lineId ? ` – ${esc(rec.lineId)}` : ""}<br>${esc(rec.checkShort || "")}${rec.warn ? `<br><b>Warnung:</b> ${esc(rec.warn)}` : ""}`);
        const el = mk.getElement && mk.getElement();
        if (el) {
          el.style.touchAction = "none";
          el.addEventListener("pointerdown", (ev) => {
            if (ev.button !== undefined && ev.button !== 0) return;
            startDrag(ev, { vehicle: { id: rec.id, label: rec.label, vehicle: rec.vehicle }, label: rec.label || rec.id, from: "karte" });
          });
        }
      }
    }

    const api = {
      store, render, bindListItem, guideLayer, markerLayer,
      /** Fahrzeug ablegen (aus der Liste oder verschoben). */
      drop(vehicle, lat, lon, o = {}) {
        const st = state();
        if (!st.grid || !st.result || !st.ctx) {
          if (cfg.onError) cfg.onError("Zuerst eine Prognose berechnen: ohne Prognose gibt es keine Sicherheitsprüfung.");
          return null;
        }
        const chk = checkDrop(st.grid, st.result, st.ctx, P, vehicle, lat, lon, { stations: st.stations, teil: st.teil, stationMap: st.stationMap });
        const nl = nearestLine(st.grid, st.lines || [], ...st.grid.proj.toXY(lat, lon), P);
        let adj = null, lineId = null;
        if (nl && nl.inRadius) {
          lineId = nl.line.id;
          adj = adjustLine(st.grid, st.ctx, P, nl.line, ...st.grid.proj.toXY(lat, lon));
          if (adj.ok && adj.changed && cfg.onLineChange) cfg.onLineChange(nl.line, adj);
        }
        const rec = store.place({
          id: vehicle.id, label: vehicle.label || vehicle.id, vehicle: vehicle.vehicle || vehicle,
          lat, lon, lineId, locked: p.lockOnDrop, task: o.task || (lineId ? `Riegel ${lineId}` : "von Hand gesetzt"),
          warn: chk.ok ? null : chk.warnText, checkShort: chk.kurz,
        });
        render();
        if (cfg.onDrop) cfg.onDrop(rec, chk, adj, { from: o.from || "liste" });
        return { rec, chk, adj };
      },
      remove(id, grund) {
        const rec = store.remove(id);
        render();
        if (rec && cfg.onRemove) cfg.onRemove(rec, grund || "entfernt");
        return rec;
      },
      setLocked(id, locked) { const r = store.setLocked(id, locked); render(); if (r && cfg.onLock) cfg.onLock(r); return r; },
      undo() { const ok = store.undo(); render(); if (ok && cfg.onAfter) cfg.onAfter(); return ok; },
      redo() { const ok = store.redo(); render(); if (ok && cfg.onAfter) cfg.onAfter(); return ok; },
      destroy() {
        clearGuides();
        markerLayer.clearLayers();
        map.removeLayer(guideLayer); map.removeLayer(markerLayer);
        ghost.remove(); hint.remove();
      },
    };
    return api;
  }

  const VehicleDrag = {
    DEFAULTS, params,
    projectOnPolyline, nearestLine, lineCells, lineSafe, adjustLine, polyLength,
    checkDrop, readinessOf, guides,
    createStore, diffPlacements, protocolEntry, exportProps,
    attach,
  };
  root.VehicleDrag = VehicleDrag;
  if (typeof module !== "undefined" && module.exports) module.exports = VehicleDrag;
})(typeof globalThis !== "undefined" ? globalThis : this);
