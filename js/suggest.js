/*
 * Einfache Einsatzvorschläge (vereinfacht, heuristisch):
 *  - Riegelstellungen/Abwehrlinien aus OSM-Barrieren (Wege, Straßen, Gewässer, Bahn) bzw. ohne OSM
 *    als geometrische Linie quer zur Hauptausbreitungsrichtung.
 *    GÜLTIG ist eine Linie nur, wenn sie zum Zeitpunkt der Einsatzbereitschaft (Prognosebeginn +
 *    Anfahrt + Aufbau) vollständig außerhalb der "möglich"-Zone dieses Zeitpunkts liegt (mit
 *    Mindestabstand), quer zur Hauptausbreitungsrichtung verläuft und vor der Front liegt.
 *    Findet sich keine solche Linie, wird keine erfunden (lineInfo.reason).
 *  - Fahrzeuge: Löschfahrzeuge mit Wasser verteilt auf gültige Linien (nach Länge), Objektschutz an
 *    bedrohter Bebauung, Wasserversorgung/Pendelverkehr; nur echte Reserve im Bereitstellungsraum.
 *  - nächstgelegene Wasserentnahmestellen (OSM, nicht verifiziert) mit grober Pendelabschätzung
 * Alle Kriterien und Gewichte sind ANNAHMEN (PARAMS.suggestions).
 * Anfahrt (ab 0.4.0): je Fahrzeug aus der Entfernung Wache -> Einsatzstelle geschätzt (js/dispatch.js,
 * kein Routing). Die Bereitschaft für Riegel richtet sich nach dem n-t nächsten geeigneten Löschfahrzeug
 * (PARAMS.anfahrt.lineReadyVehicleRank); Fahrzeuge werden nach Anfahrt sortiert eingeplant, zu späte
 * Fahrzeuge als „zu spät für Riegel X“ gekennzeichnet. Ohne Koordinate: nicht eingeplant.
 * NICHT umgesetzt: Routing/echte Fahrzeiten, Rückzugswege, feuerwehrinterne Sicherheitsabstände (Offen).
 */
(function (root) {
  const G = root.Grid;
  const D = () => root.Dispatch;

  const KIND_LABEL = {
    primary: "Bundes-/Landesstraße", secondary: "Landes-/Kreisstraße", tertiary: "Kreis-/Gemeindestraße",
    unclassified: "Verbindungsstraße", residential: "Ortsstraße", service: "Zufahrtsweg", track: "Wirtschafts-/Waldweg",
    path: "Pfad", river: "Fluss", stream: "Bach", railway: "Bahnlinie", geometrisch: "Geometrische Linie",
  };

  function fmtMin(m) {
    if (!isFinite(m)) return "nicht innerhalb des Horizonts";
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return h > 0 ? `${h} h ${String(mm).padStart(2, "0")} min` : `${mm} min`;
  }

  /** Chamfer-Distanz (m) zu Zellen der Maske. */
  function distanceTo(g, mask) {
    const { nx, ny, cell } = g;
    const d = new Float32Array(nx * ny);
    const INF = 1e9, a = cell, b = cell * Math.SQRT2;
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i; let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + a);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + b);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + b);
      }
      d[k] = v;
    }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i; let v = d[k];
      if (i < nx - 1) v = Math.min(v, d[k + 1] + a);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + a);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + b);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + b);
      }
      d[k] = v;
    }
    return d;
  }

  function bearingDeg(dx, dy) { return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360; }
  function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  /**
   * Zeit (min), ab der eine Zelle "möglich" ist (>= P.ensemble.possible der Läufe). Exakt aus
   * runEnsemble (tPossible); für andere Modelle grob aus den Horizont-Zählern.
   */
  function possibleTimes(result, P) {
    if (result.tPossible) return result.tPossible;
    const n = result.counts[0].length, t = new Float32Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) for (let h = 0; h < result.horizons.length; h++) {
      if (result.counts[h][i] / result.runs >= P.ensemble.possible) { t[i] = result.horizons[h] * 60; break; }
    }
    return t;
  }

  /** Minimum von arr im Quadrat (2r+1)² um Zelle k. */
  function localMin(g, arr, k, r) {
    const ci = k % g.nx, cj = (k - ci) / g.nx;
    let m = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = ci + di, b = cj + dj;
      if (a < 0 || b < 0 || a >= g.nx || b >= g.ny) continue;
      const v = arr[b * g.nx + a];
      if (v < m) m = v;
    }
    return m;
  }

  /**
   * Prüfkontext. opt.anfahrtMin: geschätzte Anfahrt für die Riegelbereitschaft (sonst Ersatzwert
   * PARAMS.suggestions.anfahrtMin = pauschal 30 min).
   */
  function context(g, result, ignition, P, opt = {}) {
    const S = P.suggestions;
    const n = g.nx * g.ny;
    const poss = P.ensemble.possible;
    const tP = possibleTimes(result, P);
    const anfahrtMin = opt.anfahrtMin ?? S.anfahrtMin;
    const readyMin = opt.readyMin ?? anfahrtMin + S.setupMin;
    // Prüfzeitpunkt für Linien: Einsatzbereitschaft + Mindest-Wirkzeit (Annahme, 0 = nur Bereitschaft)
    const checkMin = readyMin + (S.lineMinLeadMin || 0);
    const tMax = Math.max(...result.horizons) * 60;
    const h1 = new Uint8Array(n), ready = new Uint8Array(n), last = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (result.counts[0][i] / result.runs >= poss) h1[i] = 1;
      if (tP[i] <= checkMin) ready[i] = 1;
      if (tP[i] <= tMax) last[i] = 1;
    }
    for (const i of ignition) { h1[i] = 1; ready[i] = 1; last[i] = 1; }
    let ix = 0, iy = 0;
    for (const i of ignition) { const [x, y] = G.cellCenter(g, i); ix += x; iy += y; }
    ix /= ignition.length || 1; iy /= ignition.length || 1;
    return {
      readyCells: (() => { const a = []; for (let i = 0; i < n; i++) if (ready[i]) a.push(i); return a; })(),
      dist1h: distanceTo(g, h1), readyMask: ready, distReady: distanceTo(g, ready), distLast: distanceTo(g, last),
      ignXY: [ix, iy], tMax, tP, readyMin, checkMin, vehicleSafetyMin: S.vehicleSafetyMin, vehicleSafeMin: readyMin + S.vehicleSafetyMin,
      anfahrtMin, readyText: opt.readyText || `${anfahrtMin} min Anfahrt (pauschal) + ${S.setupMin} min Aufbau`,
    };
  }

  // Douglas-Peucker für offene Linien (Punkte in m)
  function simplifyLine(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let best = -1, bd = tol * tol;
      for (let k = a + 1; k < b; k++) {
        let t = l2 > 0 ? ((pts[k][0] - ax) * dx + (pts[k][1] - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = ax + t * dx - pts[k][0], ey = ay + t * dy - pts[k][1];
        const d = ex * ex + ey * ey;
        if (d > bd) { bd = d; best = k; }
      }
      if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter((_, k) => keep[k]);
  }
  function polyLength(pts) { let s = 0; for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return s; }
  /** Punkt bei Anteil f (0..1) der Bogenlänge. */
  function pointAt(pts, f) {
    const L = polyLength(pts); let goal = f * L;
    for (let k = 1; k < pts.length; k++) {
      const s = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (goal <= s || k === pts.length - 1) {
        const t = s > 0 ? Math.min(1, goal / s) : 0;
        return [pts[k - 1][0] + t * (pts[k][0] - pts[k - 1][0]), pts[k - 1][1] + t * (pts[k][1] - pts[k - 1][1])];
      }
      goal -= s;
    }
    return pts[0];
  }
  /** Hauptachse (Grad, 0..180) per Hauptkomponentenanalyse. */
  function axisDeg(pts) {
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // Winkel zur x-Achse (Ost)
    const dx = Math.cos(th), dy = Math.sin(th);
    return { deg: bearingDeg(dx, dy) % 180, cx: mx, cy: my };
  }
  /** Winkel zwischen Linienachse und Richtung (0 = parallel, 90 = quer). */
  function crossAngle(axis, dir) { const d = angDiff(axis, dir) % 180; return d > 90 ? 180 - d : d; }

  const REJECT_TEXT = {
    bereitschaft: "schneiden die „möglich“-Zone zum Prüfzeitpunkt oder halten den Mindestabstand nicht ein",
    quer: "verlaufen nicht quer zur Hauptausbreitungsrichtung",
    sektor: "liegen nicht vor der Front (Flanke, rückwärtig oder von der Bereitschafts-Zone überholt)",
    kurz: "sind im zulässigen Bereich zu kurz",
    ausserhalb: "liegen außerhalb des 6-h-Ausbreitungsbereichs",
  };

  /**
   * Bewertet eine Folge von Linienzellen. Liefert {ok, reason|segment-Daten}.
   * Gültig nur, wenn alle Zellen des Segments außerhalb der "möglich"-Zone zum Prüfzeitpunkt (Bereitschaft + Mindest-Wirkzeit)
   * liegen (Abstand >= lineClearanceM), das Segment den 6-h-Bereich berührt, quer und vor der Front liegt.
   */
  /**
   * Zellkriterium einer Riegel-/Abwehrlinie – die EINZIGE Stelle, an der es steht:
   * Die Zelle muss zum Prüfzeitpunkt außerhalb der „möglich“-Zone liegen und mindestens
   * `lineClearanceM` Abstand dazu halten. Wird von evalCells() und von js/vehicle-drag.js
   * (angepasste Linie beim Ziehen eines Fahrzeugs) benutzt – nicht kopieren.
   */
  function lineCellOk(ctx, P, i) {
    return !ctx.readyMask[i] && ctx.distReady[i] >= P.suggestions.lineClearanceM;
  }

  /**
   * Dasselbe Kriterium für eine ganze Zellenliste, mit Zahlen für die Begründung.
   * @returns {ok, bad, minClearanceM, minArrivalMin, reason}
   */
  function lineCellsOk(ctx, P, cells) {
    const S = P.suggestions;
    let bad = 0, minClear = Infinity, minArrival = Infinity;
    for (const i of cells) {
      if (i < 0 || i >= ctx.distReady.length) {
        return { ok: false, bad: 1, minClearanceM: 0, minArrivalMin: 0, reason: "Linie verlässt das Rechengebiet." };
      }
      if (ctx.distReady[i] < minClear) minClear = ctx.distReady[i];
      if (ctx.tP[i] < minArrival) minArrival = ctx.tP[i];
      if (!lineCellOk(ctx, P, i)) bad++;
    }
    return {
      ok: bad === 0, bad,
      minClearanceM: minClear === Infinity ? 0 : minClear,
      minArrivalMin: minArrival,
      reason: bad === 0 ? "" : `${bad} Rasterzelle(n) der geänderten Linie liegen in der „möglich“-Zone zum Prüfzeitpunkt (${Math.round(ctx.checkMin)} min) oder halten den Mindestabstand ${S.lineClearanceM} m nicht ein (geringster Abstand ${Math.round(minClear === Infinity ? 0 : minClear)} m).`,
    };
  }

  function evalCells(g, cells, ctx, P, refDir, mainDir) {
    const S = P.suggestions;
    const ok = cells.map((i) => lineCellOk(ctx, P, i));
    const near = cells.map((i) => ctx.distLast[i] <= S.lineReachM);
    if (!near.some(Boolean)) return { ok: false, why: "ausserhalb" };
    if (!near.some((v, q) => v && ok[q])) return { ok: false, why: "bereitschaft" };
    const ext = Math.round(S.lineExtendM / g.cell);
    let best = null, why = "kurz";
    // zusammenhängende gültige Abschnitte
    for (let a = 0; a < cells.length;) {
      if (!ok[a]) { a++; continue; }
      let b = a; while (b + 1 < cells.length && ok[b + 1]) b++;
      let f = -1, l = -1;
      for (let q = a; q <= b; q++) if (near[q]) { if (f < 0) f = q; l = q; }
      if (f >= 0) {
        const seg = cells.slice(Math.max(a, f - ext), Math.min(b, l + ext) + 1);
        const pts = seg.map((i) => G.cellCenter(g, i));
        const lenM = polyLength(simplifyLine(pts, g.cell * 0.4)) || g.cell;
        const ax = axisDeg(pts);
        const dir = refDir(ax.cx, ax.cy);
        const cross = crossAngle(ax.deg, dir);
        const sector = mainDir === null ? 0 : angDiff(bearingDeg(ax.cx - ctx.ignXY[0], ax.cy - ctx.ignXY[1]), mainDir);
        let w = null;
        if (lenM < S.lineMinLengthM) w = "kurz";
        else if (cross < S.lineMinCrossDeg) w = "quer";
        else if (sector > S.lineMaxSectorDeg || !aheadOfFront(g, ctx, seg, mainDir)) w = "sektor";
        if (!w) {
          const cand = { seg, pts, lenM, axis: ax, cross, sector, dir };
          if (!best || lenM > best.lenM) best = cand;
        } else if (["quer", "sektor"].includes(w) || why === "kurz") why = w;
      }
      a = b + 1;
    }
    if (!best && why !== "kurz" && cells.some((i, q) => near[q] && !ok[q])) why = "bereitschaft"; // Linie wird von der Zone geschnitten
    return best ? { ok: true, ...best } : { ok: false, why };
  }

  /**
   * "Vor der Front": jede Zelle des Abschnitts liegt in Ausbreitungsrichtung weiter vorn als die
   * "möglich"-Zone zum Prüfzeitpunkt im selben Querstreifen (±50 m quer zur Hauptrichtung). Ohne
   * deutliche Richtung: weiter vom Brand entfernt als die Zone im selben Richtungssektor (±5°).
   * Verhindert Flankenstücke einer von der Zone durchschnittenen oder überholten Linie.
   * Mindestens eine Zelle muss die Zone im Querstreifen "vor sich" haben (sonst reine Flankenlage).
   */
  function aheadOfFront(g, ctx, seg, mainDir) {
    if (!ctx.readyCells.length) return true;
    const [ix, iy] = ctx.ignXY;
    const key = mainDir === null ? "radial" : mainDir;
    if (ctx._ahead?.key !== key) {
      const bins = new Map();
      const r = mainDir === null ? 0 : (mainDir * Math.PI) / 180, ux = Math.sin(r), uy = Math.cos(r);
      for (const k of ctx.readyCells) {
        const [x, y] = G.cellCenter(g, k);
        const [b, v] = coordOf(x - ix, y - iy, mainDir, ux, uy, g.cell);
        if (!(bins.get(b) >= v)) bins.set(b, v);
      }
      ctx._ahead = { key, bins, ux, uy };
    }
    const { bins, ux, uy } = ctx._ahead;
    let faced = 0;
    for (const k of seg) {
      const [x, y] = G.cellCenter(g, k);
      const [b, v] = coordOf(x - ix, y - iy, mainDir, ux, uy, g.cell);
      let m = -Infinity;
      for (let d = -2; d <= 2; d++) { const w = bins.get(b + d); if (w !== undefined && w > m) m = w; }
      if (m === -Infinity) continue; // seitlich außerhalb der Zone (Flankenanschluss)
      if (v <= m) return false;
      faced++;
    }
    return faced > 0;
  }
  /** [Streifen-Nr., Längskoordinate] für den Vor-der-Front-Test. */
  function coordOf(dx, dy, mainDir, ux, uy, cell) {
    if (mainDir === null) {
      const ang = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      return [Math.round(ang / 2.5), Math.hypot(dx, dy)];
    }
    return [Math.round((dx * uy - dy * ux) / cell), dx * ux + dy * uy];
  }

  /** Anteil der Frontbreite (6-h-"möglich"-Zone hinter der Linie), den die Linie überdeckt. */
  function coverage(ctx, zonePts, pts, dir) {
    if (dir === null) return 0.5;
    const r = (dir * Math.PI) / 180, ux = Math.sin(r), uy = Math.cos(r); // Ausbreitungsrichtung
    const px = uy, py = -ux; // quer dazu
    let along = 0; for (const [x, y] of pts) along += (x - ctx.ignXY[0]) * ux + (y - ctx.ignXY[1]) * uy;
    along /= pts.length;
    let wmin = Infinity, wmax = -Infinity;
    for (const [x, y] of zonePts) {
      const a = (x - ctx.ignXY[0]) * ux + (y - ctx.ignXY[1]) * uy;
      if (a < along - 50) continue;
      const p = (x - ctx.ignXY[0]) * px + (y - ctx.ignXY[1]) * py;
      if (p < wmin) wmin = p; if (p > wmax) wmax = p;
    }
    if (!(wmax > wmin)) return 1;
    let lmin = Infinity, lmax = -Infinity;
    for (const [x, y] of pts) { const p = (x - ctx.ignXY[0]) * px + (y - ctx.ignXY[1]) * py; lmin = Math.min(lmin, p); lmax = Math.max(lmax, p); }
    return Math.max(0, Math.min(lmax, wmax) - Math.max(lmin, wmin)) / (wmax - wmin);
  }

  function lineReason(S, ctx, l, extra) {
    const reserve = l.minArrivalMin - ctx.readyMin;
    return `${extra} Vorlaufzeit: Einsatzbereitschaft an der Linie (früheste Bereitschaft eines Löschfahrzeugs) nach ${ctx.readyMin} min: ${ctx.readyText}. ` +
      `„Möglich“-Front erreicht die Linie frühestens in ${fmtMin(l.minArrivalMin)}, also ${fmtMin(reserve)} nach Einsatzbereitschaft (gefordert mind. ${S.lineMinLeadMin || 0} min); früheste Ankunft in einem einzelnen Lauf ${fmtMin(l.earliestMin)}. ` +
      `Zum Prüfzeitpunkt (${ctx.checkMin} min) mindestens ${Math.round(l.clearanceM)} m Abstand zur „möglich“-Zone.`;
  }

  function lineSuggestions(g, result, osm, ignition, P, ctx, mainDir, excluded) {
    const S = P.suggestions, W = S.weights;
    const e = result.earliest;
    const headDeg = result.refInfo?.[0]?.headDeg ?? 0;
    // Bezugsrichtung für "quer": Hauptausbreitungsrichtung; ohne deutliche Richtung radial vom Brand
    const refDir = (x, y) => (mainDir !== null ? mainDir : bearingDeg(x - ctx.ignXY[0], y - ctx.ignXY[1]));
    const zonePts = [];
    for (let k = 0; k < ctx.tP.length; k++) if (ctx.tP[k] <= ctx.tMax) zonePts.push(G.cellCenter(g, k));
    const rejected = { bereitschaft: 0, quer: 0, sektor: 0, kurz: 0, ausserhalb: 0 };
    const finish = (seg, pts) => {
      const minArrivalMin = Math.min(...seg.map((i) => localMin(g, ctx.tP, i, 1)));
      const earliestMin = Math.min(...seg.map((i) => localMin(g, e, i, 1)));
      const clearanceM = Math.min(...seg.map((i) => ctx.distReady[i]));
      const xy = simplifyLine(pts, g.cell * 0.4);
      return { minArrivalMin, earliestMin, clearanceM, xy, latlngs: xy.map(([x, y]) => g.proj.toLatLng(x, y)) };
    };
    const out = [];
    if (osm && osm.candidates && osm.candidates.length) {
      for (const c of osm.candidates) {
        if (excluded.has(c.id)) continue;
        const cells = [];
        G.rasterLine(g, c.pts, (i) => { if (cells[cells.length - 1] !== i) cells.push(i); });
        if (!cells.length) continue;
        const r = evalCells(g, cells, ctx, P, refDir, mainDir);
        if (!r.ok) { rejected[r.why]++; continue; }
        const f = finish(r.seg, r.pts);
        // Schutzwirkung: Bebauungszellen hinter der Linie (weiter vom Brand entfernt, < 1 km)
        let protects = 0;
        const dIgn = Math.hypot(r.axis.cx - ctx.ignXY[0], r.axis.cy - ctx.ignXY[1]);
        if (osm.objects) {
          const m = osm.objects.wohnbebauung, rr = Math.ceil(1000 / g.cell);
          const ci = Math.floor((r.axis.cx - g.x0) / g.cell), cj = Math.floor((r.axis.cy - g.y0) / g.cell);
          for (let dj = -rr; dj <= rr; dj += 2) for (let di = -rr; di <= rr; di += 2) {
            const a = ci + di, b = cj + dj;
            if (a < 0 || b < 0 || a >= g.nx || b >= g.ny) continue;
            const k = b * g.nx + a;
            if (!m[k]) continue;
            const [x, y] = G.cellCenter(g, k);
            if (Math.hypot(x - ctx.ignXY[0], y - ctx.ignXY[1]) > dIgn) protects++;
          }
        }
        const cov = coverage(ctx, zonePts, r.pts, mainDir);
        const dw = mainDir === null ? 0.5 : (Math.cos((r.sector * Math.PI) / 180) + 1) / 2;
        const typeScore = S.barrierTypeScore[c.kind] ?? 0.3;
        const buffer = Math.max(0, Math.min(1, (f.minArrivalMin - ctx.readyMin) / 120));
        const lenPen = Math.min(1, r.lenM / 2000);
        const prot = Math.min(1, protects / 20);
        const crossS = Math.sin((r.cross * Math.PI) / 180);
        const score = W.barrierType * typeScore + W.bufferTime * buffer - W.length * lenPen + W.protects * prot + W.downwind * dw + W.cross * crossS + W.coverage * cov;
        const label = KIND_LABEL[c.kind] || c.kind;
        const l = { lengthM: r.lenM, ...f };
        const reason = lineReason(S, ctx, l, `${label}${c.name ? ` „${c.name}“` : ""}, ca. ${Math.round(r.lenM / 10) * 10} m, ${mainDir === null ? "keine deutliche Hauptrichtung, quer zur radialen Ausbreitung" : `vor der Front (${Math.round(r.sector)}° neben der Hauptrichtung), Winkel zur Ausbreitungsrichtung ${Math.round(r.cross)}°`}, deckt ca. ${Math.round(cov * 100)} % der Frontbreite (6 h, „möglich“).`) +
          `${protects > 0 ? ` Bebauung dahinter (ca. ${protects} Rasterpunkte).` : ""} Barrierewirkung und Befahrbarkeit vor Ort prüfen.`;
        out.push({
          id: `linie:${c.id}`, candId: c.id, type: "linie", kind: c.kind, score, lengthM: r.lenM, minArrivalMin: f.minArrivalMin,
          earliestMin: f.earliestMin, clearanceM: f.clearanceM, readyMin: ctx.readyMin, leadMin: f.minArrivalMin - ctx.readyMin,
          coverage: cov, crossDeg: r.cross, sectorDeg: r.sector, latlngs: f.latlngs, xy: f.xy,
          reason, source: "OSM (nicht verifiziert) + Modellprognose", cells: r.seg,
        });
      }
      out.sort((a, b) => b.score - a.score);
      const picked = [];
      for (const s of out) {
        if (picked.length >= S.maxLines) break;
        const set = new Set(s.cells);
        if (!picked.some((p) => p.cells.some((i) => set.has(i)))) picked.push(s);
      }
      return { lines: picked, rejected, candidates: osm.candidates.length };
    }
    // Ohne OSM: geometrische Linie quer zur Hauptrichtung, erste Lage, die alle Bedingungen erfüllt
    const dir = mainDir ?? headDeg;
    const rad = (dir * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad);
    let lastWhy = "ausserhalb";
    for (let d = g.cell; d < g.nx * g.cell; d += g.cell) {
      const x = ctx.ignXY[0] + ux * d, y = ctx.ignXY[1] + uy * d;
      const i = G.cellOf(g, x, y);
      if (i < 0) break;
      if (ctx.distLast[i] > S.lineReachM) break; // jenseits des 6-h-Bereichs
      // halbe Breite der 6-h-"möglich"-Zone quer zur Richtung an dieser Stelle (+100 m)
      let half = 0;
      for (let s = 0; s < 4000; s += g.cell) {
        let any = false;
        for (const sg of [-1, 1]) { const k = G.cellOf(g, x + uy * s * sg, y - ux * s * sg); if (k >= 0 && ctx.tP[k] <= ctx.tMax) any = true; }
        if (any) half = s; else if (s > half + 200) break;
      }
      half = Math.max(150, half + 100);
      const a = [x + uy * half, y - ux * half], b = [x - uy * half, y + ux * half];
      const cells = [];
      G.rasterLine(g, [a, b], (k) => { if (cells[cells.length - 1] !== k) cells.push(k); });
      if (cells.some((k) => ctx.readyMask[k] || ctx.distReady[k] < S.lineClearanceM)) { lastWhy = "bereitschaft"; continue; }
      const f = finish(cells, [a, b]);
      f.latlngs = [g.proj.toLatLng(...a), g.proj.toLatLng(...b)]; f.xy = [a, b];
      const l = { lengthM: 2 * half, ...f };
      return {
        lines: [{
          id: "linie:geometrisch", candId: "geometrisch", type: "linie", kind: "geometrisch", score: 0,
          lengthM: 2 * half, minArrivalMin: f.minArrivalMin, earliestMin: f.earliestMin, clearanceM: f.clearanceM,
          readyMin: ctx.readyMin, leadMin: f.minArrivalMin - ctx.readyMin, coverage: 1, crossDeg: 90, sectorDeg: 0,
          latlngs: f.latlngs, xy: f.xy,
          reason: lineReason(S, ctx, l, `Ohne OSM-Daten: geometrische Linie quer zur Hauptausbreitungsrichtung (${Math.round(dir)}°), ${Math.round(d)} m vor dem Brandschwerpunkt, Länge ca. ${Math.round(2 * half / 10) * 10} m (Breite der 6-h-„möglich“-Zone + 100 m je Seite).`) +
            " Kein Bezug zu Wegen/Barrieren, Befahrbarkeit unbekannt. Nur als Orientierung.",
          source: "Modellprognose (ohne Geländedaten)", cells,
        }],
        rejected: { ...rejected }, candidates: 0,
      };
    }
    rejected[lastWhy]++;
    return { lines: [], rejected, candidates: 0, geometric: true };
  }

  /** Begründung, wenn keine gültige Linie gefunden wurde. */
  function noLineReason(S, ctx, info, osm) {
    const parts = [];
    for (const [k, n] of Object.entries(info.rejected)) if (n) parts.push(`${n} ${REJECT_TEXT[k]}`);
    const head = `Keine geeignete Riegelstellung gefunden. Bedingung: Linie liegt zum Zeitpunkt der frühesten Einsatzbereitschaft (${ctx.readyMin} min: ${ctx.readyText}) zuzüglich ${S.lineMinLeadMin || 0} min Mindest-Wirkzeit (Prüfzeitpunkt ${ctx.checkMin} min) vollständig außerhalb der „möglich“-Zone (mind. ${S.lineClearanceM} m Abstand), quer zur Hauptausbreitungsrichtung und vor der Front.`;
    if (osm) return `${head} Geprüft: ${info.candidates} OSM-Wege/-Gewässer; davon ${parts.join(", ") || "keine im Ausbreitungsbereich"}. Es wird keine Linie erfunden; Lage vor Ort erkunden.`;
    return `${head} Ohne OSM-Daten wurde eine geometrische Linie entlang der Hauptrichtung gesucht: ${info.rejected.bereitschaft ? "jede Lage innerhalb des 6-h-Bereichs schneidet die „möglich“-Zone zum Prüfzeitpunkt oder hält den Abstand nicht ein" : "innerhalb des 6-h-Bereichs gibt es keine Lage außerhalb der Bereitschafts-Zone"}. Es wird keine Linie erfunden.`;
  }

  /** Bedrohte Bebauung: Gruppen von Gebäude-/Wohnflächenzellen nahe der 6-h-"möglich"-Zone. */
  function threatenedObjects(g, result, osm, ctx, P) {
    const S = P.suggestions;
    if (!osm || !osm.objects) return [];
    const m = osm.objects.wohnbebauung;
    const cand = [];
    for (let k = 0; k < m.length; k++) if (m[k] && ctx.distLast[k] <= S.objectThreatDistM) cand.push(k);
    const idx = new Map(cand.map((k, q) => [k, q]));
    const seen = new Uint8Array(cand.length);
    const gap = Math.max(1, Math.round(S.objectClusterGapM / g.cell));
    const clusters = [];
    for (let q0 = 0; q0 < cand.length; q0++) {
      if (seen[q0]) continue;
      const stack = [q0]; seen[q0] = 1; const cells = [];
      while (stack.length) {
        const q = stack.pop(); const k = cand[q]; cells.push(k);
        const ci = k % g.nx, cj = (k - ci) / g.nx;
        for (let dj = -gap; dj <= gap; dj++) for (let di = -gap; di <= gap; di++) {
          const a = ci + di, b = cj + dj;
          if (a < 0 || b < 0 || a >= g.nx || b >= g.ny) continue;
          const r = idx.get(b * g.nx + a);
          if (r !== undefined && !seen[r]) { seen[r] = 1; stack.push(r); }
        }
      }
      let best = -1, bestT = Infinity, bestE = Infinity;
      for (const k of cells) {
        const t = localMin(g, ctx.tP, k, 2);
        if (t < bestT) { bestT = t; best = k; }
        bestE = Math.min(bestE, localMin(g, result.earliest, k, 2));
      }
      if (best >= 0 && isFinite(bestT)) clusters.push({ cells, at: best, threatMin: bestT, earliestMin: bestE, areaHa: (cells.length * g.cell * g.cell) / 1e4 });
    }
    clusters.sort((a, b) => a.threatMin - b.threatMin);
    return clusters;
  }

  /**
   * Zeitliche Sicherheit eines Standorts (Annahme): "möglich"-Front frühestens Bereitschaft + Puffer
   * (tPossible >= vehicleSafeMin) UND kein einzelner Lauf vor der Einsatzbereitschaft (earliest > readyMin).
   */
  function safeCell(ctx, e, k, readyMin) {
    const r = readyMin ?? ctx.readyMin;
    return ctx.tP[k] >= r + ctx.vehicleSafetyMin && e[k] > r;
  }

  /**
   * Sicherer Standort nahe (tx, ty): früheste Ankunft (einzelner Lauf) >= Bereitschaft + Puffer,
   * Abstand zum 1-h-"möglich"-Bereich, befahrbar (mit OSM), nicht zu nah an bereits belegten Standorten,
   * optional nicht auf der Brandseite einer Linie (behind = {ux, uy, x, y}).
   */
  function pickPosition(g, result, osm, ctx, P, tx, ty, radiusM, opt = {}) {
    const S = P.suggestions, e = result.earliest;
    const r = Math.ceil(radiusM / g.cell);
    const ci0 = Math.floor((tx - g.x0) / g.cell), cj0 = Math.floor((ty - g.y0) / g.cell);
    const minDist = opt.minDistTo1h ?? S.vehicleMinDistM;
    let best = null;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = ci0 + di, b = cj0 + dj;
      if (a < 0 || b < 0 || a >= g.nx || b >= g.ny) continue;
      const k = b * g.nx + a;
      const dist = Math.hypot(di, dj) * g.cell;
      if (dist > radiusM) continue;
      if (!safeCell(ctx, e, k, opt.readyMin) || ctx.dist1h[k] < minDist) continue;
      const drv = osm && osm.drivable ? osm.drivable[k] : 0;
      if (osm && osm.drivable && !drv) continue;
      const [x, y] = G.cellCenter(g, k);
      if (opt.behind && (x - opt.behind.x) * opt.behind.ux + (y - opt.behind.y) * opt.behind.uy < -g.cell) continue;
      if (opt.used && opt.used.some(([ux, uy]) => Math.hypot(ux - x, uy - y) < 60)) continue;
      const score = -dist / 100 + Math.min(isFinite(e[k]) ? e[k] : 400, 400) / 200 + (drv === 1 ? 1 : drv === 2 ? 0.5 : 0);
      if (!best || score > best.score) best = { k, score, drv, x, y };
    }
    return best;
  }

  function nearestWater(waterPoints, lat, lon, k) {
    if (!waterPoints || !waterPoints.length) return [];
    const d = (p) => {
      const dy = (p.lat - lat) * 111195, dx = (p.lon - lon) * 111195 * Math.cos((lat * Math.PI) / 180);
      return Math.hypot(dx, dy);
    };
    return waterPoints.filter((p) => !p.deleted).map((p) => ({ ...p, distM: d(p) })).sort((a, b) => a.distM - b.distM).slice(0, k);
  }

  function waterText(v, water, P) {
    const S = P.suggestions;
    const tank = v.tank_l;
    const parts = [];
    if (tank) parts.push(`Tank ${tank} l reicht bei ${S.waterUseLpm} l/min ca. ${Math.round(tank / S.waterUseLpm)} min.`);
    if (water.length) {
      const w = water[0];
      const dist = Math.round(w.distM / 10) * 10;
      if (w.distM <= S.hoseMaxM) parts.push(`Nächste Entnahmestelle (${w.kind}, ${w.verified ? "verifiziert" : "nicht verifiziert"}) ca. ${dist} m Luftlinie: Schlauchleitung ca. ${Math.ceil((w.distM * 1.2) / 20) * 20} m (Annahme +20 %).`);
      else {
        const rt = ((2 * w.distM * 1.3) / 1000 / S.shuttleKmh) * 60 + (tank ? tank / 1000 : 2);
        parts.push(`Nächste Entnahmestelle (${w.kind}, ${w.verified ? "verifiziert" : "nicht verifiziert"}) ca. ${dist} m Luftlinie: Pendelverkehr, Umlauf grob ${Math.round(rt)} min (ohne Routing).`);
      }
    } else parts.push("Keine Entnahmestelle in den Daten. Wasserversorgung vor Ort klären.");
    return parts.join(" ");
  }

  /** Fahrzeug führt Löschwasser und ist für Riegel/Objektschutz geeignet (Annahme). */
  function hasWater(v, P) {
    const S = P.suggestions;
    const typ = String(v.typ || "");
    if (S.noWaterTypes.some((t) => typ === t || typ.startsWith(t + " ") || typ.startsWith(t + "-"))) return false;
    if (v.loeschfahrzeug === false) return false;
    if (typeof v.tank_l === "number") return v.tank_l > 0;
    return S.suppressionTypes.includes(typ) || v.loeschfahrzeug === true;
  }

  /**
   * Hauptfunktion. state: {locked: Map(id->suggestion), excluded: Set(candId|vehicleId)}
   * opts: {stations: [] (Wachen mit Koordinaten), maxAnfahrtMin (Option "nur bis X min"),
   *        grundschutzOverride: {wacheId: vehicleId}}
   * Rückgabe: {lines, vehicles, notes, alerts, stage, lineInfo, demand, ctx, dispatch, grundschutz}
   */
  function compute(g, result, osm, ignition, vehicles, P, mainDir, state, opts = {}) {
    const S = P.suggestions, A = P.anfahrt;
    const Dp = D();
    const stMap = Dp.stationMap(opts.stations || []);
    const maxAnf = opts.maxAnfahrtMin ?? A.maxAnfahrtMin;
    const excluded = state?.excluded || new Set();
    const locked = state?.locked || new Map();
    const notes = [], alerts = [];
    const pflicht = pflichtSet(vehicles, P);
    const isPflicht = (v) => pflicht.has(v.id);

    // ---------------- Anfahrt je Fahrzeug zur Einsatzstelle (Brandschwerpunkt), geschätzt
    let cx = 0, cy = 0;
    for (const i of ignition) { const [x, y] = G.cellCenter(g, i); cx += x; cy += y; }
    cx /= ignition.length || 1; cy /= ignition.length || 1;
    const [fLat, fLon] = g.proj.toLatLng(cx, cy);
    const lockedVehicleIds = new Set([...locked.values()].filter((s) => s.type === "fahrzeug").map((s) => s.vehicleId));
    const avail0 = vehicles.filter((v) => v.verfuegbar !== false && !excluded.has(v.id) && !lockedVehicleIds.has(v.id));
    // Gemeindeteil des Einsatzorts (für die Bereitschaftsvorgabe der eigenen Wehr)
    const teil = opts.teil !== undefined ? opts.teil : (opts.grenzen || opts.teilMode ? Dp.gemeindeteil(fLat, fLon, opts.grenzen, opts.teilMode) : undefined);
    // Bereitschaft je Fahrzeug: eigene Wehr nach Vorgabe (25/40 min), sonst Anfahrt geschätzt + Aufbau.
    // Pflichtfahrzeug ohne schätzbare Anfahrt: pauschaler Ersatzwert (gekennzeichnet), damit es eingebunden werden kann.
    const rdyAt = (v, lat, lon, setup) => {
      const r = Dp.readiness(v, stMap, lat, lon, setup, P, teil);
      if (r.ok || !isPflicht(v)) return r;
      const m = S.anfahrtMin + setup;
      return { ok: true, fallback: true, ready: m, kind: "pauschal", e: r.e, short: `${m} min (pauschal)`, text: `löschbereit ${m} min: Anfahrt unbekannt (${r.reason}), pauschaler Ersatzwert ${S.anfahrtMin} min + ${setup} min Aufbau (Pflichtfahrzeug)` };
    };
    const disp = (r) => (r && r.ok ? { ok: true, min: r.e && r.e.ok ? r.e.min : null, ready: r.ready, kind: r.kind, short: r.short, text: r.text, fallback: r.kind !== "geschaetzt" } : r);
    const est = new Map(), rdy = new Map();
    for (const v of vehicles) { est.set(v.id, Dp.estimate(v, stMap, fLat, fLon, P)); rdy.set(v.id, rdyAt(v, fLat, fLon, S.setupMin)); }
    for (const v of vehicles) {
      if (!isPflicht(v)) continue;
      if (v.verfuegbar === false) alerts.push(`ACHTUNG: Pflichtfahrzeug ${v.bezeichnung || v.id} ist als „nicht verfügbar“ markiert und wird nicht eingeplant.`);
      else if (excluded.has(v.id)) alerts.push(`ACHTUNG: Pflichtfahrzeug ${v.bezeichnung || v.id} wurde verworfen und wird nicht eingeplant.`);
      else if (rdy.get(v.id).fallback) notes.push(`Pflichtfahrzeug ${v.bezeichnung || v.id}: ${rdy.get(v.id).text}.`);
      // 0.4.2: Pflichtfahrzeuge sind laut Vorgabe Fahrzeuge der EIGENEN Wehr. Ein angehaktes Fahrzeug einer
      // Nachbarkommune ist fast immer ein Versehen (es fehlt dann für den Grundschutz am Gerätehaus).
      const kv = v.kommune || (v.wache && stMap.get(String(v.wache)) ? stMap.get(String(v.wache)).kommune : null);
      if (kv && P.grundschutz && normK(kv) !== normK(P.grundschutz.kommune)) notes.push(`Pflichtfahrzeug ${v.bezeichnung || v.id} gehört zur Kommune ${kv}, nicht zu ${P.grundschutz.kommune}. Pflichtfahrzeuge sind laut Vorgabe Fahrzeuge der eigenen Wehr; ein Fahrzeug der Nachbarkommune steht dann nicht mehr für den Grundschutz zur Verfügung. Häkchen „Pflicht“ in der Fahrzeugliste prüfen.`);
    }
    // Anfahrtsgrenze: geschätzte Anfahrt bzw. bei Vorgabe die Bereitschaftszeit
    const anfOf = (v) => { const r = rdy.get(v.id); return r.kind === "geschaetzt" ? r.e.min : r.ready; };
    const noCoord = avail0.filter((v) => !rdy.get(v.id).ok);
    const tooFar = avail0.filter((v) => rdy.get(v.id).ok && anfOf(v) > maxAnf && !isPflicht(v));
    const byReady = (a, b) => rdy.get(a.id).ready - rdy.get(b.id).ready;
    const avail = avail0.filter((v) => rdy.get(v.id).ok && (anfOf(v) <= maxAnf || isPflicht(v))).sort(byReady);
    const supp = avail.filter((v) => hasWater(v, P));
    const supplyOnly = (v) => (S.waterSupplyOnlyTypes || []).some((t) => String(v.typ || "").toUpperCase().startsWith(t.toUpperCase()));
    if (noCoord.length) notes.push(`Nicht eingeplant, keine Wachenkoordinate (Anfahrt nicht schätzbar): ${noCoord.map((v) => v.bezeichnung || v.typ).join(", ")}. Koordinate unter „Fahrzeuge“ eintragen.`);
    if (tooFar.length) notes.push(`Nicht eingeplant, geschätzte Anfahrt über ${maxAnf} min (Option „nur bis ${maxAnf} min“): ${tooFar.map((v) => `${v.bezeichnung || v.typ} (${rdy.get(v.id).kind === "geschaetzt" ? rdy.get(v.id).e.short : rdy.get(v.id).short})`).join(", ")}.`);

    // ---------------- Prüfgrenze Riegel: früheste Bereitschaft eines geeigneten Löschfahrzeugs (je Fahrzeug wird
    // bei der Zuordnung zusätzlich geprüft, ob es rechtzeitig mit Wirkzeit-Reserve bereit ist)
    const rieg = supp.filter((v) => !supplyOnly(v));
    let readyMin = S.anfahrtMin + S.setupMin, readyText = `${S.anfahrtMin} min Anfahrt (pauschaler Ersatzwert, kein einplanbares Löschfahrzeug) + ${S.setupMin} min Aufbau`, anfahrtSource = "pauschal", anfahrtVehicle = null, ready2 = null;
    if (rieg.length) {
      const rank = Math.min(A.lineReadyVehicleRank || 1, rieg.length);
      const v = rieg[rank - 1], r = rdy.get(v.id);
      readyMin = Math.ceil(r.ready - 1e-9);
      anfahrtSource = r.kind === "vorgabe" ? "Vorgabe" : r.kind === "pauschal" ? "pauschal" : "geschätzt";
      anfahrtVehicle = v.id;
      readyText = `${v.bezeichnung || v.typ} ${r.text}`;
      const nxt = rieg.slice(rank).find((x) => rdy.get(x.id).ready > r.ready + 5);
      if (nxt) ready2 = { min: Math.ceil(rdy.get(nxt.id).ready - 1e-9), vehicle: nxt.id, text: `${nxt.bezeichnung || nxt.typ} ${rdy.get(nxt.id).text}` };
    } else if (vehicles.length) notes.push(`Riegelbereitschaft mit pauschal ${S.anfahrtMin} min Anfahrt + ${S.setupMin} min Aufbau gerechnet (kein einplanbares Löschfahrzeug).`);
    const anfahrtMin = readyMin - S.setupMin, anfahrtText = readyText;
    const ctx = context(g, result, ignition, P, { readyMin, readyText, anfahrtMin });

    const ls = lineSuggestions(g, result, osm, ignition, P, ctx, mainDir, excluded);
    const lines = ls.lines.filter((l) => !locked.has(l.id));
    const lockedLines = [...locked.values()].filter((s) => s.type === "linie");
    const allLines = [...lockedLines, ...lines];
    const lineInfo = {
      readyMin: ctx.readyMin, checkMin: ctx.checkMin, leadMinRequired: S.lineMinLeadMin || 0, anfahrtMin, anfahrtText, anfahrtSource, anfahrtVehicle, readyText,
      second: ready2 ? { readyMin: ready2.min, checkMin: ready2.min + (S.lineMinLeadMin || 0), text: ready2.text, vehicle: ready2.vehicle } : null,
      teil: teil || null,
      setupMin: S.setupMin, found: allLines.length > 0, rejected: ls.rejected, candidates: ls.candidates,
      reason: allLines.length ? null : noLineReason(S, ctx, ls, osm),
    };

    const veh = [];
    const used = [...locked.values()].filter((s) => s.type === "fahrzeug").map((s) => g.proj.toXY(s.lat, s.lon));
    if (!osm) notes.push("Ohne OSM-Daten sind Bebauung, Wege und Entnahmestellen unbekannt: kein Objektschutz-Vorschlag, Riegel nur als geometrische Orientierung, Standorte ohne Befahrbarkeitsprüfung.");

    // ---------------- Bedarf (Aufgaben) in Prioritätsreihenfolge (Annahme)
    const dirDeg = mainDir ?? (result.refInfo?.[0]?.headDeg ?? 0);
    const dirU = [Math.sin((dirDeg * Math.PI) / 180), Math.cos((dirDeg * Math.PI) / 180)];
    const lineXY = (line) => line.xy || line.latlngs.map(([la, lo]) => g.proj.toXY(la, lo));
    const lineTasks = (line, rank) => {
      const xy = lineXY(line);
      const n = Math.max(1, Math.min(S.maxVehiclesPerLine, Math.ceil(line.lengthM / S.sectionPerVehicleM)));
      return Array.from({ length: n }, (_, q) => {
        const [x, y] = pointAt(xy, (q + 0.5) / n);
        return { task: "Riegel", line, rank, section: q + 1, sections: n, x, y, sectionM: line.lengthM / n };
      });
    };

    // Zweite Riegellinie für die ZWEITE Bereitschaftsstufe (Annahme, 0.4.2): Fahrzeuge, die für die erste
    // Linie zu spät sind (z. B. Löschzug im anderen Gemeindeteil, 40 statt 25 min), bekommen eine weiter
    // rückwärts liegende Auffanglinie, statt pauschal als Reserve geparkt zu werden. Sicherheitsprüfung
    // unverändert: die Linie wird gegen die „möglich“-Zone zum SPÄTEREN Prüfzeitpunkt geprüft.
    const tooLateForFirst = allLines.length
      ? rieg.filter((v) => rdy.get(v.id).ready + (S.lineMinLeadMin || 0) > allLines[0].minArrivalMin)
      : [];
    let ctx2 = null;
    if (ready2 && (S.secondStageLines || 0) > 0 && allLines.length && tooLateForFirst.length) {
      ctx2 = context(g, result, ignition, P, { readyMin: ready2.min, readyText: ready2.text, anfahrtMin: ready2.min - S.setupMin });
      const ex2 = new Set([...excluded, ...allLines.map((l) => l.candId)]);
      const l2 = lineSuggestions(g, result, osm, ignition, P, ctx2, mainDir, ex2);
      const along = (l) => { const m = pointAt(lineXY(l), 0.5); return (m[0] - ctx.ignXY[0]) * dirU[0] + (m[1] - ctx.ignXY[1]) * dirU[1]; };
      const a1 = allLines.map(along);
      const add = l2.lines
        .filter((l) => a1.every((v) => Math.abs(along(l) - v) >= S.lineMinSeparationM))
        .slice(0, S.secondStageLines);
      const haveIds = new Set(allLines.map((l) => l.id));
      for (const l of add) {
        if (haveIds.has(l.id)) { l.id = `${l.id}:stufe2`; l.candId = `${l.candId}:stufe2`; }
        haveIds.add(l.id);
        l.secondStage = true; l.readyMin = ctx2.readyMin; l.leadMin = l.minArrivalMin - ctx2.readyMin;
        l.reason = `Auffanglinie für die zweite Bereitschaftsstufe (${ctx2.readyMin} min: ${ready2.text}), weil ${tooLateForFirst.length} wasserführende(s) Fahrzeug(e) für die vorderste Linie zu spät einsatzbereit sind. ` + l.reason;
        allLines.push(l);
      }
      if (!add.length) notes.push(`Keine zweite Riegelstellung für die spätere Bereitschaftsstufe (${ready2.min} min) gefunden: ${l2.lines.length ? "nur Lagen zu nah an der ersten Linie" : "keine Lage erfüllt die Bedingungen zum späteren Prüfzeitpunkt"}.`);
    }
    if (allLines.some((l) => l.kind === "geometrisch")) notes.push("Ohne OSM-Daten wird genau EINE geometrische Riegellinie je Bereitschaftsstufe erzeugt (die erste Lage quer zur Hauptausbreitungsrichtung, die alle Bedingungen erfüllt). Es werden keine Alternativen bewertet und keine Wege/Barrieren berücksichtigt.");

    const objects = threatenedObjects(g, result, osm, ctx, P).slice(0, S.maxObjectTasks);
    if (osm && osm.objects && !objects.length) notes.push(`Kein Objektschutz vorgeschlagen: keine Gebäude-/Wohnflächen (OSM) innerhalb von ${S.objectThreatDistM} m um den 6-h-„möglich“-Bereich.`);
    const tasks = [];
    if (allLines[0]) tasks.push(...lineTasks(allLines[0], 0));
    for (const o of objects) { const [x, y] = G.cellCenter(g, o.at); tasks.push({ task: "Objektschutz", obj: o, x, y }); }
    allLines.slice(1).forEach((l, q) => tasks.push(...lineTasks(l, q + 1)));
    for (const l of allLines) {
      const mid = pointAt(lineXY(l), 0.5);
      const [la, lo] = g.proj.toLatLng(mid[0], mid[1]);
      const w = nearestWater(osm?.waterPoints, la, lo, 1)[0];
      if (!w || w.distM > S.hoseMaxM) tasks.push({ task: "Wasserversorgung", line: l, water: w || null, x: mid[0], y: mid[1] });
      else notes.push(`${lineName(allLines, l)}: Entnahmestelle (${w.kind}, ${w.verified ? "verifiziert" : "nicht verifiziert"}) ca. ${Math.round(w.distM / 10) * 10} m von der Linienmitte, Schlauchleitung statt Pendelverkehr.`);
    }

    // ---------------- Zuordnung: nächste geeignete Fahrzeuge zuerst (Pool nach Anfahrt sortiert);
    // Wasserversorgung bevorzugt großen Tank. Je Fahrzeug Anfahrt zum Aufgabenort, Bereitschaft = Anfahrt + Aufbau.
    // Pflichtfahrzeuge zuerst (vorrangig), danach nach Anfahrt
    const pool = [...supp.filter(isPflicht), ...supp.filter((v) => !isPflicht(v))];
    const late = new Map(); // vehicleId -> [Linienname]
    const vehWhy = new Map(); // vehicleId -> [Grund, warum keine (weitere) Aufgabe]
    const why = (v, txt) => { if (!vehWhy.has(v.id)) vehWhy.set(v.id, []); const a = vehWhy.get(v.id); if (!a.includes(txt) && a.length < 4) a.push(txt); };
    const readyAtXY = (v, x, y, setup) => { const [la, lo] = g.proj.toLatLng(x, y); return rdyAt(v, la, lo, setup); };
    let unmet = 0;
    /** Besetzt eine Aufgabe mit dem ersten geeigneten Fahrzeug des Pools. Gibt true zurück, wenn besetzt. */
    const assignTask = (t, opt = {}) => {
      if (!pool.length) return false;
      const label = t.line ? lineName(allLines, t.line) : "";
      const setup = t.task === "Objektschutz" ? S.objectSetupMin : S.setupMin;
      let order = pool.map((v, q) => q);
      // Wasserversorgung: Großtanker (waterSupplyOnlyTypes) zuerst, dann größter Tank (Annahme)
      if (t.task === "Wasserversorgung") order.sort((a, b) => (supplyOnly(pool[b]) - supplyOnly(pool[a])) || (pool[b].tank_l || 0) - (pool[a].tank_l || 0) || a - b);
      let chosen = -1, p = null, a = null, firstLate = null, noPos = null;
      for (const q of order) {
        const v = pool[q];
        if (t.task !== "Wasserversorgung" && supplyOnly(v)) continue; // Tanker nur Wasserversorgung (Annahme)
        const e = readyAtXY(v, t.x, t.y, setup);
        if (!e.ok) continue;
        const ready = e.ready;
        if ((t.task === "Riegel" || t.task === "Verstärkung") && ready + (S.lineMinLeadMin || 0) > t.line.minArrivalMin) {
          if (t.task === "Riegel") {
            if (!late.has(v.id)) late.set(v.id, []);
            if (!late.get(v.id).includes(label)) late.get(v.id).push(label);
            if (!firstLate) firstLate = { v, ready };
            why(v, `zu spät für Riegel ${label} (bereit nach ${Math.round(ready)} min, „möglich“-Front an der Linie nach ${fmtMin(t.line.minArrivalMin)})`);
          }
          continue;
        }
        let pos;
        if (t.task === "Riegel" || t.task === "Verstärkung") pos = pickPosition(g, result, osm, ctx, P, t.x, t.y, 500, { used, readyMin: ready, behind: { x: t.x, y: t.y, ux: dirU[0], uy: dirU[1] } });
        else if (t.task === "Objektschutz") pos = pickPosition(g, result, osm, ctx, P, t.x, t.y, 300, { used, readyMin: ready });
        else if (t.task === "Flanke") pos = pickPosition(g, result, osm, ctx, P, t.x, t.y, 500, { used, readyMin: ready });
        else {
          const tx = t.water ? g.proj.toXY(t.water.lat, t.water.lon) : null;
          pos = tx ? pickPosition(g, result, osm, ctx, P, tx[0], tx[1], 200, { used, readyMin: ready }) : null;
          if (!pos) pos = pickPosition(g, result, osm, ctx, P, t.x - dirU[0] * 300, t.y - dirU[1] * 300, 400, { used, readyMin: ready, behind: { x: t.x, y: t.y, ux: dirU[0], uy: dirU[1] } });
        }
        if (!pos) { // ohne sicheren Standort für dieses Fahrzeug (Bereitschaft zu spät): nächstes prüfen
          why(v, `kein sicherer Standort für ${t.task}${label ? " " + label : ""} bei Bereitschaft nach ${Math.round(ready)} min`);
          if (!noPos) noPos = { e, ready };
          continue;
        }
        chosen = q; p = pos; a = { e, ready };
        break;
      }
      if (chosen < 0) {
        if (opt.optional) return false;
        if (noPos) notes.push(`${t.task}${label ? " " + label : ""}${t.section ? ` Abschnitt ${t.section}/${t.sections}` : ""}: kein sicherer${osm ? ", befahrbarer" : ""} Standort gefunden (Bedingungen: „möglich“-Front frühestens ${S.vehicleSafetyMin} min nach Bereitschaft des Fahrzeugs (${Math.round(noPos.ready)} min), kein Lauf vor der Bereitschaft, ≥ ${S.vehicleMinDistM} m vom 1-h-Bereich).`);
        else if (firstLate) notes.push(`Riegel ${label} Abschnitt ${t.section}/${t.sections}: kein Fahrzeug rechtzeitig. Nächstes geeignetes (${firstLate.v.bezeichnung || firstLate.v.typ}) wäre nach ${Math.round(firstLate.ready)} min bereit, „möglich“-Front an der Linie nach ${fmtMin(t.line.minArrivalMin)} (Mindest-Wirkzeit ${S.lineMinLeadMin || 0} min).`);
        else unmet++;
        return false;
      }
      const v = pool.splice(chosen, 1)[0];
      used.push([p.x, p.y]);
      const [lat, lon] = G.cellLatLng(g, p.k);
      const water = nearestWater(osm?.waterPoints, lat, lon, 3);
      const rr = rdyAt(v, lat, lon, setup);
      const anf = disp(rr);
      const anfTxt = ` Bereitschaft: ${rr.text}.`;
      let reason, task = t.task, taskKind = t.task;
      if (t.task === "Riegel") {
        task = `Riegel ${label}, Abschnitt ${t.section}/${t.sections}`;
        reason = `Riegel an ${KIND_LABEL[t.line.kind] || t.line.kind} (${label}): Linie ca. ${Math.round(t.line.lengthM / 10) * 10} m, aufgeteilt in ${t.sections} Abschnitt(e) zu ca. ${Math.round(t.sectionM / 10) * 10} m (Annahme ${S.sectionPerVehicleM} m je Fahrzeug). Front („möglich“) an der Linie frühestens in ${fmtMin(t.line.minArrivalMin)}.${anfTxt} Standort auf der brandabgewandten Seite, frühestens erreicht: ${fmtMin(result.earliest[p.k])}, ${Math.round(ctx.dist1h[p.k])} m vom 1-h-Bereich.`;
      } else if (t.task === "Verstärkung") {
        taskKind = "Riegel";
        task = `Riegel ${label}, Verstärkung/Ablösung`;
        reason = `Verstärkung/Ablösung an Riegel ${label} (Annahme 0.4.2: solange Fahrzeuge verfügbar sind und rechtzeitig bereit werden, wird die Linie dichter besetzt als die Planungsannahme ${S.sectionPerVehicleM} m je Fahrzeug, höchstens ${S.maxVehiclesPerLine} Fahrzeuge je Linie). Front („möglich“) an der Linie frühestens in ${fmtMin(t.line.minArrivalMin)}.${anfTxt} Standort ${Math.round(ctx.dist1h[p.k])} m vom 1-h-Bereich.`;
      } else if (t.task === "Flanke") {
        task = `Flankensicherung ${t.side}`;
        reason = `Flankensicherung ${t.side} der Ausbreitungsachse (ANNAHME 0.4.2, nicht mit der Feuerwehr abgestimmt): Fahrzeug ist weder für eine Riegelstellung rechtzeitig noch für Objektschutz/Wasserversorgung nötig und begrenzt stattdessen die seitliche Ausbreitung. Standort ca. ${Math.round(t.offsetM)} m seitlich der Hauptausbreitungsrichtung, ${Math.round(ctx.dist1h[p.k])} m vom 1-h-Bereich, frühestens erreicht ${fmtMin(result.earliest[p.k])}.${anfTxt} Keine durchgehende Flankenlinie geprüft; Lage vor Ort erkunden.`;
      } else if (t.task === "Objektschutz") {
        const o = t.obj;
        const rdyO = rr.ready;
        reason = `Objektschutz: Bebauung (ca. ${o.areaHa.toFixed(1).replace(".", ",")} ha Gebäude-/Wohnflächenzellen, OSM) liegt im 6-h-Bereich; „möglich“-Front frühestens in ${fmtMin(o.threatMin)}, einzelner Lauf ${fmtMin(o.earliestMin)}.${anfTxt} ${o.threatMin < rdyO ? `ACHTUNG: Front früher als Bereitschaft (${Math.round(rdyO)} min), zu spät für vorbereitenden Objektschutz. ` : ""}Standort ${Math.round(ctx.dist1h[p.k])} m vom 1-h-Bereich.`;
      } else {
        task = `Wasserversorgung ${label}`;
        reason = (t.water
          ? `Wasserversorgung/Pendelverkehr für ${label}: nächste Entnahmestelle (${t.water.kind}, ${t.water.verified ? "verifiziert" : "nicht verifiziert"}) ca. ${Math.round(t.water.distM / 10) * 10} m von der Linienmitte, über der Schlauchreichweite (${S.hoseMaxM} m, Annahme). Fahrzeug mit großem Tank pendelt.`
          : `Wasserversorgung/Pendelverkehr für ${label}: keine Entnahmestelle in den Daten. Entnahmestelle vor Ort klären; Fahrzeug mit großem Tank rückwärtig der Linie.`) + anfTxt;
      }
      reason += osm ? (p.drv === 1 ? " Liegt an einer Straße (OSM)." : " Liegt an einem Wirtschaftsweg (OSM): Befahrbarkeit prüfen.") : " Befahrbarkeit nicht geprüft (keine OSM-Daten).";
      reason += " Rückzugsweg nicht geprüft.";
      veh.push({
        id: `fz:${v.id}`, type: "fahrzeug", vehicleId: v.id, vehicle: v, task, taskKind, lat, lon,
        reason, water, waterInfo: waterText(v, water, P), lineId: t.line?.id || null,
        arrivalMin: result.earliest[p.k], distTo1hM: ctx.dist1h[p.k], anfahrt: anf, readyMin: rr.ready,
        source: osm ? "Modellprognose + OSM (nicht verifiziert) + Fahrzeugliste" : "Modellprognose + Fahrzeugliste",
      });
      return true;
    };
    for (const t of tasks) assignTask(t);

    // ---------------- Grundschutz: direkt nach den Einsatzaufgaben und VOR Verstärkung/Flanke/Bereitstellung
    // (0.4.2). Der Grundschutz an den Gerätehäusern ist eine Vorgabe des Auftraggebers und hat damit Vorrang
    // vor der Reserve im Bereitstellungsraum; Fahrzeuge mit Einsatzaufgabe sind gebunden und bleiben es.
    const plannedTask = new Set(veh.map((s) => s.vehicleId));
    for (const s of locked.values()) if (s.type === "fahrzeug") plannedTask.add(s.vehicleId);
    const gs = grundschutz(vehicles, opts.stations || [], P, plannedTask, opts.grundschutzOverride || {});
    const gsIds = new Map(gs.assignments.filter((a) => a.vehicle).map((a) => [a.vehicle.id, a]));
    for (let q = pool.length - 1; q >= 0; q--) {
      const a = gsIds.get(pool[q].id);
      if (!a) continue;
      notes.push(`${pool[q].bezeichnung || pool[q].typ}: keine Einsatzaufgabe, deshalb Grundschutz am Gerätehaus ${a.wache ? a.wache.name : a.wacheId} (Vorgabe Grundschutz vor Verstärkung/Flanke/Reserve); steht nicht im Bereitstellungsraum.`);
      pool.splice(q, 1);
    }

    // ---------------- Verbleibende wasserführende Fahrzeuge sinnvoll einsetzen, statt sie als Reserve zu parken
    // (Annahme 0.4.2): 1. Linien bis maxVehiclesPerLine verstärken, 2. Flanken sichern. Sicherheitsprüfung
    // (sicherer Standort, rechtzeitige Bereitschaft) unverändert; wer sie nicht erfüllt, bleibt Reserve.
    if (S.lineReinforceToMax) {
      for (const l of allLines) {
        const xy = lineXY(l);
        let n = veh.filter((x) => x.lineId === l.id && x.taskKind === "Riegel").length;
        const base = Math.max(1, Math.min(S.maxVehiclesPerLine, Math.ceil(l.lengthM / S.sectionPerVehicleM)));
        while (n > 0 && n < S.maxVehiclesPerLine && pool.some((v) => !supplyOnly(v))) {
          const [x, y] = pointAt(xy, (n + 0.5) / (n + 1));
          if (!assignTask({ task: "Verstärkung", line: l, x, y, sections: base }, { optional: true })) break;
          n++;
        }
      }
    }
    const flankLeft = pool.filter((v) => !supplyOnly(v)).length;
    if (flankLeft && (S.maxFlankVehicles || 0) > 0 && allLines.length) {
      const px = dirU[1], py = -dirU[0];
      let half = 0;
      for (const k of ctx.readyCells) { const [x, y] = G.cellCenter(g, k); const q = Math.abs((x - ctx.ignXY[0]) * px + (y - ctx.ignXY[1]) * py); if (q > half) half = q; }
      const n = Math.min(S.maxFlankVehicles, flankLeft);
      for (let q = 0; q < n; q++) {
        const sg = q % 2 === 0 ? 1 : -1, step = Math.floor(q / 2);
        const off = half + S.flankOffsetM * (1 + step);
        assignTask({ task: "Flanke", side: sg > 0 ? "rechts der Ausbreitungsrichtung" : "links der Ausbreitungsrichtung", offsetM: off, x: ctx.ignXY[0] + px * off * sg, y: ctx.ignXY[1] + py * off * sg }, { optional: true });
      }
    }
    if (unmet) notes.push(`Bedarf übersteigt die verfügbaren Löschfahrzeuge: ${unmet} Aufgabe(n) ohne Fahrzeug (Nachalarmierung/Überlandhilfe prüfen).`);
    if (late.size) notes.push(`Zu spät für Riegel (Bereitschaft + ${S.lineMinLeadMin || 0} min Mindest-Wirkzeit nach Eintreffen der „möglich“-Front, Anfahrt geschätzt): ${[...late.entries()].map(([id, ls]) => `${(vehicles.find((v) => v.id === id) || {}).bezeichnung || id} (${ls.join(", ")})`).join("; ")}.`);

    // ---------------- Bereitstellungsraum: rückwärtig (Halbebene gegen die Hauptrichtung), sicher, befahrbar,
    // >= 300 m vom 1-h-Bereich; gewählt wird der nächstgelegene geeignete Punkt (Annahme)
    let stage = null, stageNoRoad = false;
    for (const needRoad of [true, false]) {
      if (stage) break;
      if (!needRoad && !(osm && osm.drivable)) break;
      stageNoRoad = !needRoad;
      const e = result.earliest, step = 1; // Wege sind 1 Zelle breit: jede Zelle prüfen
      for (let j = 0; j < g.ny; j += step) for (let i = 0; i < g.nx; i += step) {
        const k = j * g.nx + i;
        if (!safeCell(ctx, e, k) || ctx.dist1h[k] < 300) continue;
        const drv = osm && osm.drivable ? osm.drivable[k] : 0;
        if (needRoad && osm && osm.drivable && !drv) continue;
        const [x, y] = G.cellCenter(g, k);
        const dx = x - ctx.ignXY[0], dy = y - ctx.ignXY[1];
        const back = -(dx * dirU[0] + dy * dirU[1]); // > 0: gegen die Hauptrichtung
        const dist = Math.hypot(dx, dy);
        if (dist > 3000 || back < 0.3 * dist) continue; // innerhalb ca. ±72° um die Gegenrichtung
        if (used.some(([ux, uy]) => Math.hypot(ux - x, uy - y) < 60)) continue;
        const score = dist + (drv === 2 ? 150 : 0) + (dist - back) * 0.5;
        if (!stage || score < stage.score) stage = { k, score, drv, x, y };
      }
    }
    // Begründung je Fahrzeug im Bereitstellungsraum (0.4.2: immer nachvollziehbar, nie nur „Reserve“)
    const whyOf = (v) => {
      const r = vehWhy.get(v.id);
      if (r && r.length) return r.join("; ");
      if (!tasks.length) return `keine Aufgabe ermittelt (keine gültige Riegelstellung${osm ? ", keine bedrohte Bebauung" : " und ohne OSM-Daten kein Objektschutz"})`;
      return `alle ${tasks.length} Aufgaben (Riegelabschnitte, Objektschutz, Wasserversorgung) wurden an früher einsatzbereite Fahrzeuge vergeben (Bereitschaft dieses Fahrzeugs: ${Math.round(rdy.get(v.id).ready)} min)`;
    };
    // Pflichtfahrzeuge ohne Aufgabe: eigener Status, nicht Reserve. Grundschutzfahrzeuge stehen am Gerätehaus
    // und erscheinen NICHT im Bereitstellungsraum.
    const stagePool = pool;
    const pflichtLeft = stagePool.filter(isPflicht);
    const restPool = stagePool.filter((v) => !isPflicht(v));
    const pflichtStaged = pflichtLeft.map((v) => ({ v, role: "Pflichtfahrzeug – bereitgestellt", pflicht: true, why: `Pflichtfahrzeug (wird bei jedem Einsatz eingebunden), aber keine sichere Aufgabe: ${whyOf(v)}. Bereitgestellt nahe der Einsatzstelle.` }));
    const reserveAll = restPool;
    const reserveUse = reserveAll.slice(0, A.maxReserve ?? reserveAll.length);
    const reserve = reserveUse.map((v) => ({ v, role: "Reserve", why: `Keine sichere Aufgabe für dieses Fahrzeug: ${whyOf(v)}. Löschfahrzeug bleibt als Reserve im Bereitstellungsraum.` }));
    const leadAll = avail.filter((v) => /^(ELW|KdoW)/.test(String(v.typ)));
    const crewAll = avail.filter((v) => /^(MTF|MTW)/.test(String(v.typ)));
    const lim = (list, n) => [...list.filter(isPflicht), ...list.filter((v) => !isPflicht(v)).slice(0, n ?? list.length)];
    const lead = lim(leadAll, A.maxStageLead).map((v) => ({ v, role: "Führung", why: "Führungsfahrzeug ohne Löschwasser: kein Riegel-, Objektschutz- oder Wasserversorgungsauftrag möglich; Einsatzleitung am Bereitstellungsraum (Annahme)." }));
    const crew = lim(crewAll, A.maxStageCrew).map((v) => ({ v, role: "Personalreserve", why: "Mannschaftstransportfahrzeug ohne Löschwasser: kein Riegel-, Objektschutz- oder Wasserversorgungsauftrag möglich; Personalreserve/Ablösung (Annahme)." }));
    const notNeeded = [...reserveAll.slice(reserve.length), ...leadAll.filter((v) => !lead.some((x) => x.v === v)), ...crewAll.filter((v) => !crew.some((x) => x.v === v))];
    if (notNeeded.length) notes.push(`Nicht benötigt (nicht eingeplant, Begrenzung Bereitstellungsraum: max. ${A.maxReserve} Reserve, ${A.maxStageLead} Führung, ${A.maxStageCrew} Personal; Annahme): ${notNeeded.map((v) => v.bezeichnung || v.typ).join(", ")}.`);
    const staged = [...pflichtStaged, ...lead, ...reserve, ...crew];
    let stageInfo = null;
    if (stage && staged.length) {
      const [lat, lon] = G.cellLatLng(g, stage.k);
      const where = `Rückwärtiger Bereitstellungsraum gegen die Hauptausbreitungsrichtung, ${Math.round(ctx.dist1h[stage.k])} m vom 1-h-Bereich${isFinite(result.earliest[stage.k]) ? `, frühestens erreicht in ${fmtMin(result.earliest[stage.k])}` : ", im Horizont nicht erreicht"}.${stageNoRoad ? " Kein befahrbarer Weg in den OSM-Daten: Zufahrt vor Ort prüfen." : ""}`;
      stageInfo = { lat, lon, reason: where, vehicleIds: staged.map((s) => s.v.id) };
      for (const s of staged) {
        const anf = disp(rdyAt(s.v, lat, lon, S.setupMin));
        veh.push({
          id: `fz:${s.v.id}`, type: "fahrzeug", vehicleId: s.v.id, vehicle: s.v, task: `Bereitstellung: ${s.role}`, taskKind: "Bereitstellung", role: s.role,
          lat, lon, water: [], waterInfo: s.role === "Reserve" ? waterText(s.v, nearestWater(osm?.waterPoints, lat, lon, 3), P) : "",
          reason: `${s.why} ${where} Bereitschaft: ${anf.text}.`, stage: true, anfahrt: anf, pflicht: !!s.pflicht,
          arrivalMin: result.earliest[stage.k], distTo1hM: ctx.dist1h[stage.k], source: "Modellprognose + Fahrzeugliste",
        });
      }
    } else if (staged.length) {
      notes.push("Kein sicherer Bereitstellungsraum gefunden.");
      for (const s of pflichtStaged) alerts.push(`ACHTUNG: Pflichtfahrzeug ${s.v.bezeichnung || s.v.id}: keine sichere Aufgabe und kein sicherer Bereitstellungsraum gefunden (${whyOf(s.v)}).`);
    }
    for (const x of veh) { if (late.has(x.vehicleId)) x.lateFor = late.get(x.vehicleId); if (isPflicht(x.vehicle)) x.pflicht = true; }
    const planned = new Set([...veh.map((s) => s.vehicleId), ...gsIds.keys()]);
    for (const s of locked.values()) if (s.type === "fahrzeug") planned.add(s.vehicleId);
    const unassigned = avail.filter((v) => !planned.has(v.id) && !notNeeded.includes(v));
    if (unassigned.length) notes.push(`Nicht eingeplant (kein Löschwasser bzw. Ausstattung offen, für Vegetationsbrand nicht vorgesehen): ${unassigned.map((v) => v.bezeichnung || v.typ).join(", ")}.`);
    if (!supp.length) notes.push(vehicles.some((v) => hasWater(v, P)) ? "Keine einplanbaren Löschfahrzeuge mit Wasser (Koordinate, Verfügbarkeit oder Anfahrtsgrenze prüfen)." : "Keine verfügbaren Löschfahrzeuge mit Wasser in der Fahrzeugliste.");
    const lockedVeh = [...locked.values()].filter((s) => s.type === "fahrzeug");
    notes.push(...gs.notes);
    alerts.push(...gs.alerts);
    return {
      lines: allLines, vehicles: [...lockedVeh, ...veh], notes, alerts, stage, stageInfo, lineInfo, objects, demand: { tasks: tasks.length, unmet }, ctx,
      grundschutz: gs.assignments,
      dispatch: { firePoint: [fLat, fLon], maxAnfahrtMin: maxAnf, estimates: est, readiness: rdy, teil: teil || null, noCoord: noCoord.map((v) => v.id), tooFar: tooFar.map((v) => v.id), late: Object.fromEntries(late), pflicht: [...pflicht], notNeeded: notNeeded.map((v) => v.id) },
    };
  }

  /** Pflichtfahrzeuge: Häkchen am Fahrzeug (pflicht: true/false) hat Vorrang vor PARAMS.pflichtFahrzeuge. */
  function pflichtSet(vehicles, P) {
    const def = new Set(P.pflichtFahrzeuge || []);
    return new Set(vehicles.filter((v) => v.pflicht === true || (v.pflicht === undefined && def.has(v.id))).map((v) => v.id));
  }

  const normK = (k) => String(k || "").trim().toLowerCase();
  /** Typstufe für den Grundschutz (Annahme PARAMS.grundschutz.typStufen; sonstige wasserführende zuletzt). */
  function gsTier(v, P) {
    const t = String(v.typ || "").toUpperCase();
    const st = P.grundschutz.typStufen;
    for (let q = 0; q < st.length; q++) if (st[q].some((p) => t === p.toUpperCase() || t.startsWith(p.toUpperCase() + " ") || t.startsWith(p.toUpperCase() + "-") || (p.length > 2 && t.startsWith(p.toUpperCase())))) return q;
    return st.length;
  }

  /**
   * Grundschutz: je Gerätehaus (PARAMS.grundschutz.wachen) ein verfügbares wasserführendes Fahrzeug aus einer
   * anderen Kommune, nicht im Einsatz (planned), nicht doppelt. Auswahl nach Typstufe, dann geschätzter Anfahrt
   * zum Gerätehaus. override {wacheId: vehicleId} = manuelle Wahl (wird geprüft).
   * @returns {assignments: [{wacheId, wache, vehicle|null, anfahrt, manual, candidates}], notes, alerts}
   */
  function grundschutz(vehicles, stations, P, planned, override) {
    const GS = P.grundschutz, Dp = D();
    const notes = [], alerts = [];
    if (!GS || !GS.wachen || !GS.wachen.length) return { assignments: [], notes, alerts };
    const stMap = Dp.stationMap(stations);
    const home = normK(GS.kommune);
    const kommuneOf = (v) => v.kommune || (v.wache && stMap.get(String(v.wache)) ? stMap.get(String(v.wache)).kommune : null);
    const unknownK = [];
    const cand = vehicles.filter((v) => {
      if (v.verfuegbar === false || planned.has(v.id) || !hasWater(v, P)) return false;
      if ((P.suggestions.waterSupplyOnlyTypes || []).some((t) => String(v.typ || "").toUpperCase().startsWith(t.toUpperCase()))) return false;
      const k = kommuneOf(v);
      if (!k) { unknownK.push(v); return false; }
      return normK(k) !== home;
    });
    const order = new Map(vehicles.map((v, q) => [v.id, q]));
    const wachen = GS.wachen.map((id) => ({ id, st: stMap.get(String(id)) || null }));
    const est = (v, w) => (w.st && Dp.hasCoord(w.st) ? Dp.estimate(v, stMap, Number(w.st.lat), Number(w.st.lon), P) : { ok: false, reason: w.st ? "Gerätehaus ohne Koordinate" : "Gerätehaus nicht in der Wachenliste" });
    const used = new Set();
    const res = new Map();
    // manuelle Wahl zuerst (wenn weiterhin zulässig)
    for (const w of wachen) {
      const vid = override && override[w.id];
      if (!vid) continue;
      const v = cand.find((x) => x.id === vid);
      if (v && !used.has(v.id)) { used.add(v.id); res.set(w.id, { v, manual: true }); }
      else notes.push(`Grundschutz ${w.st ? w.st.name : w.id}: manuell gewähltes Fahrzeug „${vid}“ ist nicht mehr zulässig (im Einsatz, nicht verfügbar, keine Nachbarkommune oder doppelt); automatische Auswahl.`);
    }
    const pairs = [];
    for (const w of wachen) {
      if (res.has(w.id)) continue;
      for (const v of cand) { const e = est(v, w); pairs.push({ w, v, e, tier: gsTier(v, P), t: e.ok ? e.min : Infinity }); }
    }
    pairs.sort((a, b) => a.tier - b.tier || a.t - b.t || order.get(a.v.id) - order.get(b.v.id));
    for (const pr of pairs) {
      if (res.has(pr.w.id) || used.has(pr.v.id)) continue;
      res.set(pr.w.id, { v: pr.v, manual: false }); used.add(pr.v.id);
    }
    const assignments = wachen.map((w) => {
      const r = res.get(w.id);
      const candidates = cand.map((v) => ({ v, e: est(v, w), tier: gsTier(v, P) })).sort((a, b) => a.tier - b.tier || (a.e.ok ? a.e.min : Infinity) - (b.e.ok ? b.e.min : Infinity)).map((x) => x.v.id);
      const name = w.st ? w.st.name : w.id;
      if (!r) {
        alerts.push(`Kein Fahrzeug aus Nachbarkommune verfügbar – Grundschutz nicht sichergestellt (${name}).`);
        return { wacheId: w.id, wache: w.st, vehicle: null, anfahrt: null, manual: false, candidates };
      }
      const e = est(r.v, w);
      if (!e.ok) notes.push(`Grundschutz ${name}: Anfahrtszeit unbekannt (${e.reason}).`);
      return { wacheId: w.id, wache: w.st, vehicle: r.v, anfahrt: e, manual: r.manual, candidates, kommune: kommuneOf(r.v) };
    });
    if (unknownK.length && !cand.length) notes.push(`Grundschutz: ${unknownK.length} Fahrzeug(e) ohne Kommunenangabe nicht berücksichtigt.`);
    return { assignments, notes, alerts };
  }

  function lineName(lines, l) { const q = lines.indexOf(l); return q >= 0 ? `R${q + 1}` : "Linie"; }

  /** Prüft einen manuell verschobenen Standort gegen Prognose und Sicherheitsannahmen. */
  function checkPosition(g, result, ctx, P, lat, lon, readyMin) {
    const [x, y] = g.proj.toXY(lat, lon);
    const k = G.cellOf(g, x, y);
    if (k < 0) return { ok: false, text: "Außerhalb des Rechengebiets." };
    const e = result.earliest[k];
    const S = P.suggestions;
    const tP = (ctx.tP || possibleTimes(result, P))[k];
    const ready = readyMin ?? ctx.readyMin ?? (S.anfahrtMin + S.setupMin);
    const need = ready + S.vehicleSafetyMin;
    const okT = tP >= need && e > ready;
    const okD = ctx.dist1h[k] >= S.vehicleMinDistM;
    return {
      ok: okT && okD, arrivalMin: e, distTo1hM: ctx.dist1h[k],
      text: `${okT ? "" : `„Möglich“-Front frühestens in ${fmtMin(tP)}, einzelner Lauf ${fmtMin(e)} (gefordert: „möglich“ ≥ ${Math.round(need)} min = Bereitschaft ${Math.round(ready)} + ${S.vehicleSafetyMin} min Puffer, kein Lauf vor ${Math.round(ready)} min). `}${okD ? "" : `Nur ${Math.round(ctx.dist1h[k])} m vom 1-h-Bereich (Annahme Mindestabstand ${S.vehicleMinDistM} m). `}${okT && okD ? "Sicherheitsannahmen erfüllt." : ""}`,
    };
  }

  function diff(oldS, newS) {
    if (!oldS) return null;
    const key = (s) => s.id;
    const o = new Map([...oldS.lines, ...oldS.vehicles].map((s) => [key(s), s]));
    const n = new Map([...newS.lines, ...newS.vehicles].map((s) => [key(s), s]));
    const added = [...n.keys()].filter((k) => !o.has(k));
    const removed = [...o.keys()].filter((k) => !n.has(k));
    const changed = [...n.keys()].filter((k) => {
      if (!o.has(k)) return false;
      const a = o.get(k), b = n.get(k);
      if (a.type === "fahrzeug") return Math.abs(a.lat - b.lat) > 1e-5 || Math.abs(a.lon - b.lon) > 1e-5 || a.task !== b.task;
      return a.latlngs.length !== b.latlngs.length;
    });
    return { added, removed, changed };
  }

  const Suggest = { compute, checkPosition, context, diff, fmtMin, KIND_LABEL, distanceTo, hasWater, possibleTimes, threatenedObjects, grundschutz, pflichtSet, lineCellOk, lineCellsOk };
  root.Suggest = Suggest;
  if (typeof module !== "undefined" && module.exports) module.exports = Suggest;
})(typeof globalThis !== "undefined" ? globalThis : this);
