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
 * NICHT umgesetzt: Routing/Fahrzeiten, Rückzugswege, feuerwehrinterne Sicherheitsabstände (Offen).
 */
(function (root) {
  const G = root.Grid;

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

  function context(g, result, ignition, P) {
    const S = P.suggestions;
    const n = g.nx * g.ny;
    const poss = P.ensemble.possible;
    const tP = possibleTimes(result, P);
    const readyMin = S.anfahrtMin + S.setupMin;
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
      ignXY: [ix, iy], tMax, tP, readyMin, checkMin, vehicleSafeMin: readyMin + S.vehicleSafetyMin,
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
  function evalCells(g, cells, ctx, P, refDir, mainDir) {
    const S = P.suggestions;
    const ok = cells.map((i) => !ctx.readyMask[i] && ctx.distReady[i] >= S.lineClearanceM);
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
    return `${extra} Vorlaufzeit: Einsatzbereitschaft an der Linie nach ${S.anfahrtMin} min Anfahrt + ${S.setupMin} min Aufbau = ${ctx.readyMin} min (Annahmen). ` +
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
    const head = `Keine geeignete Riegelstellung gefunden. Bedingung: Linie liegt zum Zeitpunkt der Einsatzbereitschaft (${S.anfahrtMin} min Anfahrt + ${S.setupMin} min Aufbau = ${ctx.readyMin} min) zuzüglich ${S.lineMinLeadMin || 0} min Mindest-Wirkzeit (Prüfzeitpunkt ${ctx.checkMin} min) vollständig außerhalb der „möglich“-Zone (mind. ${S.lineClearanceM} m Abstand), quer zur Hauptausbreitungsrichtung und vor der Front.`;
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
  function safeCell(ctx, e, k) { return ctx.tP[k] >= ctx.vehicleSafeMin && e[k] > ctx.readyMin; }

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
      if (!safeCell(ctx, e, k) || ctx.dist1h[k] < minDist) continue;
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
   * Rückgabe: {lines, vehicles, notes, stage, lineInfo, demand}
   */
  function compute(g, result, osm, ignition, vehicles, P, mainDir, state) {
    const S = P.suggestions;
    const ctx = context(g, result, ignition, P);
    const excluded = state?.excluded || new Set();
    const locked = state?.locked || new Map();
    const ls = lineSuggestions(g, result, osm, ignition, P, ctx, mainDir, excluded);
    const lines = ls.lines.filter((l) => !locked.has(l.id));
    const lockedLines = [...locked.values()].filter((s) => s.type === "linie");
    const allLines = [...lockedLines, ...lines];
    const lineInfo = {
      readyMin: ctx.readyMin, checkMin: ctx.checkMin, leadMinRequired: S.lineMinLeadMin || 0, anfahrtMin: S.anfahrtMin, setupMin: S.setupMin, found: allLines.length > 0,
      rejected: ls.rejected, candidates: ls.candidates,
      reason: allLines.length ? null : noLineReason(S, ctx, ls, osm),
    };

    const lockedVehicleIds = new Set([...locked.values()].filter((s) => s.type === "fahrzeug").map((s) => s.vehicleId));
    const avail = vehicles.filter((v) => v.verfuegbar !== false && !excluded.has(v.id) && !lockedVehicleIds.has(v.id));
    const supp = avail.filter((v) => hasWater(v, P));
    const notes = [];
    const veh = [];
    const used = [...locked.values()].filter((s) => s.type === "fahrzeug").map((s) => g.proj.toXY(s.lat, s.lon));
    if (!osm) notes.push("Ohne OSM-Daten sind Bebauung, Wege und Entnahmestellen unbekannt: kein Objektschutz-Vorschlag, Riegel nur als geometrische Orientierung, Standorte ohne Befahrbarkeitsprüfung.");

    // ---------------- Bedarf (Aufgaben) in Prioritätsreihenfolge (Annahme)
    const dirDeg = mainDir ?? (result.refInfo?.[0]?.headDeg ?? 0);
    const dirU = [Math.sin((dirDeg * Math.PI) / 180), Math.cos((dirDeg * Math.PI) / 180)];
    const lineTasks = (line, rank) => {
      const xy = line.xy || line.latlngs.map(([la, lo]) => g.proj.toXY(la, lo));
      const n = Math.max(1, Math.min(S.maxVehiclesPerLine, Math.ceil(line.lengthM / S.sectionPerVehicleM)));
      return Array.from({ length: n }, (_, q) => {
        const [x, y] = pointAt(xy, (q + 0.5) / n);
        return { task: "Riegel", line, rank, section: q + 1, sections: n, x, y, sectionM: line.lengthM / n };
      });
    };
    const objects = threatenedObjects(g, result, osm, ctx, P).slice(0, S.maxObjectTasks);
    const tasks = [];
    if (allLines[0]) tasks.push(...lineTasks(allLines[0], 0));
    for (const o of objects) { const [x, y] = G.cellCenter(g, o.at); tasks.push({ task: "Objektschutz", obj: o, x, y }); }
    allLines.slice(1).forEach((l, q) => tasks.push(...lineTasks(l, q + 1)));
    // Wasserversorgung je Linie, wenn keine Entnahmestelle in Schlauchreichweite (Pendelverkehr)
    for (const l of allLines) {
      const mid = pointAt(l.xy || l.latlngs.map(([la, lo]) => g.proj.toXY(la, lo)), 0.5);
      const [la, lo] = g.proj.toLatLng(mid[0], mid[1]);
      const w = nearestWater(osm?.waterPoints, la, lo, 1)[0];
      if (!w || w.distM > S.hoseMaxM) tasks.push({ task: "Wasserversorgung", line: l, water: w || null, x: mid[0], y: mid[1] });
      else notes.push(`${lineName(allLines, l)}: Entnahmestelle (${w.kind}, ${w.verified ? "verifiziert" : "nicht verifiziert"}) ca. ${Math.round(w.distM / 10) * 10} m von der Linienmitte, Schlauchleitung statt Pendelverkehr.`);
    }

    // ---------------- Zuordnung: Wasserversorgung bevorzugt großer Tank, sonst Listenreihenfolge
    const pool = supp.slice();
    const take = (task) => {
      if (!pool.length) return null;
      let q = 0;
      if (task.task === "Wasserversorgung") pool.forEach((v, r) => { if ((v.tank_l || 0) > (pool[q].tank_l || 0)) q = r; });
      return pool.splice(q, 1)[0];
    };
    let unmet = 0;
    for (const t of tasks) {
      if (!pool.length) { unmet++; continue; }
      let p = null;
      if (t.task === "Riegel") {
        p = pickPosition(g, result, osm, ctx, P, t.x, t.y, 500, { used, behind: { x: t.x, y: t.y, ux: dirU[0], uy: dirU[1] } });
      } else if (t.task === "Objektschutz") {
        p = pickPosition(g, result, osm, ctx, P, t.x, t.y, 300, { used });
      } else {
        const tx = t.water ? g.proj.toXY(t.water.lat, t.water.lon) : null;
        p = tx ? pickPosition(g, result, osm, ctx, P, tx[0], tx[1], 200, { used }) : null;
        if (!p) p = pickPosition(g, result, osm, ctx, P, t.x - dirU[0] * 300, t.y - dirU[1] * 300, 400, { used, behind: { x: t.x, y: t.y, ux: dirU[0], uy: dirU[1] } });
      }
      const label = t.line ? lineName(allLines, t.line) : "";
      if (!p) { notes.push(`${t.task}${label ? " " + label : ""}${t.section ? ` Abschnitt ${t.section}/${t.sections}` : ""}: kein sicherer${osm ? ", befahrbarer" : ""} Standort gefunden (Bedingungen: „möglich“-Front frühestens nach ${ctx.vehicleSafeMin} min, kein Lauf vor ${ctx.readyMin} min, ≥ ${S.vehicleMinDistM} m vom 1-h-Bereich).`); continue; }
      const v = take(t);
      used.push([p.x, p.y]);
      const [lat, lon] = G.cellLatLng(g, p.k);
      const water = nearestWater(osm?.waterPoints, lat, lon, 3);
      let reason, task = t.task;
      if (t.task === "Riegel") {
        task = `Riegel ${label}, Abschnitt ${t.section}/${t.sections}`;
        reason = `Riegel an ${KIND_LABEL[t.line.kind] || t.line.kind} (${label}): Linie ca. ${Math.round(t.line.lengthM / 10) * 10} m, aufgeteilt in ${t.sections} Abschnitt(e) zu ca. ${Math.round(t.sectionM / 10) * 10} m (Annahme ${S.sectionPerVehicleM} m je Fahrzeug). Front („möglich“) an der Linie frühestens in ${fmtMin(t.line.minArrivalMin)}, Einsatzbereitschaft nach ${ctx.readyMin} min. Standort auf der brandabgewandten Seite, frühestens erreicht: ${fmtMin(result.earliest[p.k])}, ${Math.round(ctx.dist1h[p.k])} m vom 1-h-Bereich.`;
      } else if (t.task === "Objektschutz") {
        const o = t.obj;
        reason = `Objektschutz: Bebauung (ca. ${o.areaHa.toFixed(1).replace(".", ",")} ha Gebäude-/Wohnflächenzellen, OSM) liegt im 6-h-Bereich; „möglich“-Front frühestens in ${fmtMin(o.threatMin)}, einzelner Lauf ${fmtMin(o.earliestMin)}. ${o.threatMin < S.anfahrtMin + S.objectSetupMin ? `ACHTUNG: früher als Anfahrt + Aufbau (${S.anfahrtMin + S.objectSetupMin} min). ` : ""}Standort ${Math.round(ctx.dist1h[p.k])} m vom 1-h-Bereich.`;
      } else {
        task = `Wasserversorgung ${label}`;
        reason = t.water
          ? `Wasserversorgung/Pendelverkehr für ${label}: nächste Entnahmestelle (${t.water.kind}, ${t.water.verified ? "verifiziert" : "nicht verifiziert"}) ca. ${Math.round(t.water.distM / 10) * 10} m von der Linienmitte, über der Schlauchreichweite (${S.hoseMaxM} m, Annahme). Fahrzeug mit großem Tank pendelt.`
          : `Wasserversorgung/Pendelverkehr für ${label}: keine Entnahmestelle in den Daten. Entnahmestelle vor Ort klären; Fahrzeug mit großem Tank rückwärtig der Linie.`;
      }
      reason += osm ? (p.drv === 1 ? " Liegt an einer Straße (OSM)." : " Liegt an einem Wirtschaftsweg (OSM): Befahrbarkeit prüfen.") : " Befahrbarkeit nicht geprüft (keine OSM-Daten).";
      reason += " Rückzugsweg nicht geprüft.";
      veh.push({
        id: `fz:${v.id}`, type: "fahrzeug", vehicleId: v.id, vehicle: v, task, taskKind: t.task, lat, lon,
        reason, water, waterInfo: waterText(v, water, P), lineId: t.line?.id || null,
        arrivalMin: result.earliest[p.k], distTo1hM: ctx.dist1h[p.k],
        source: osm ? "Modellprognose + OSM (nicht verifiziert) + Fahrzeugliste" : "Modellprognose + Fahrzeugliste",
      });
    }
    if (unmet) notes.push(`Bedarf übersteigt die verfügbaren Löschfahrzeuge: ${unmet} Aufgabe(n) ohne Fahrzeug (Nachalarmierung/Überlandhilfe prüfen).`);

    // ---------------- Bereitstellungsraum: rückwärtig (Halbebene gegen die Hauptrichtung), sicher, befahrbar,
    // >= 300 m vom 1-h-Bereich; gewählt wird der nächstgelegene geeignete Punkt (Annahme)
    let stage = null;
    {
      const e = result.earliest, step = 1; // Wege sind 1 Zelle breit: jede Zelle prüfen
      for (let j = 0; j < g.ny; j += step) for (let i = 0; i < g.nx; i += step) {
        const k = j * g.nx + i;
        if (!safeCell(ctx, e, k) || ctx.dist1h[k] < 300) continue;
        const drv = osm && osm.drivable ? osm.drivable[k] : 0;
        if (osm && osm.drivable && !drv) continue;
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
    const reserve = pool.map((v) => ({ v, role: "Reserve", why: tasks.length ? `Alle ${tasks.length} ermittelten Aufgaben (Riegelabschnitte, Objektschutz, Wasserversorgung) sind besetzt oder ohne sicheren Standort; Löschfahrzeug bleibt als Reserve.` : `Keine gültige Riegelstellung${osm ? " und keine bedrohte Bebauung" : ""} gefunden; Löschfahrzeug bleibt als Reserve.` }));
    const lead = avail.filter((v) => /^(ELW|KdoW)/.test(String(v.typ))).map((v) => ({ v, role: "Führung", why: "Führungsfahrzeug ohne Löschwasser: Einsatzleitung am Bereitstellungsraum (Annahme)." }));
    const crew = avail.filter((v) => /^(MTF|MTW)/.test(String(v.typ))).map((v) => ({ v, role: "Personalreserve", why: "Mannschaftstransport ohne Löschwasser: Personalreserve/Ablösung (Annahme)." }));
    const staged = [...lead, ...reserve, ...crew];
    let stageInfo = null;
    if (stage && staged.length) {
      const [lat, lon] = G.cellLatLng(g, stage.k);
      const where = `Rückwärtiger Bereitstellungsraum gegen die Hauptausbreitungsrichtung, ${Math.round(ctx.dist1h[stage.k])} m vom 1-h-Bereich${isFinite(result.earliest[stage.k]) ? `, frühestens erreicht in ${fmtMin(result.earliest[stage.k])}` : ", im Horizont nicht erreicht"}.`;
      stageInfo = { lat, lon, reason: where, vehicleIds: staged.map((s) => s.v.id) };
      for (const s of staged) {
        veh.push({
          id: `fz:${s.v.id}`, type: "fahrzeug", vehicleId: s.v.id, vehicle: s.v, task: `Bereitstellung: ${s.role}`, taskKind: "Bereitstellung", role: s.role,
          lat, lon, water: [], waterInfo: s.role === "Reserve" ? waterText(s.v, nearestWater(osm?.waterPoints, lat, lon, 3), P) : "",
          reason: `${s.why} ${where}`, stage: true,
          arrivalMin: result.earliest[stage.k], distTo1hM: ctx.dist1h[stage.k], source: "Modellprognose + Fahrzeugliste",
        });
      }
    } else if (staged.length) notes.push("Kein sicherer Bereitstellungsraum gefunden.");
    const planned = new Set(veh.map((s) => s.vehicleId));
    const unassigned = avail.filter((v) => !planned.has(v.id));
    if (unassigned.length) notes.push(`Nicht eingeplant (kein Löschwasser bzw. Ausstattung offen, für Vegetationsbrand nicht vorgesehen): ${unassigned.map((v) => v.bezeichnung || v.typ).join(", ")}.`);
    if (!supp.length) notes.push("Keine verfügbaren Löschfahrzeuge mit Wasser in der Fahrzeugliste.");
    const lockedVeh = [...locked.values()].filter((s) => s.type === "fahrzeug");
    return { lines: allLines, vehicles: [...lockedVeh, ...veh], notes, stage, stageInfo, lineInfo, objects, demand: { tasks: tasks.length, unmet } };
  }

  function lineName(lines, l) { const q = lines.indexOf(l); return q >= 0 ? `R${q + 1}` : "Linie"; }

  /** Prüft einen manuell verschobenen Standort gegen Prognose und Sicherheitsannahmen. */
  function checkPosition(g, result, ctx, P, lat, lon) {
    const [x, y] = g.proj.toXY(lat, lon);
    const k = G.cellOf(g, x, y);
    if (k < 0) return { ok: false, text: "Außerhalb des Rechengebiets." };
    const e = result.earliest[k];
    const S = P.suggestions;
    const tP = (ctx.tP || possibleTimes(result, P))[k];
    const ready = ctx.readyMin ?? (S.anfahrtMin + S.setupMin);
    const need = ctx.vehicleSafeMin ?? (ready + S.vehicleSafetyMin);
    const okT = tP >= need && e > ready;
    const okD = ctx.dist1h[k] >= S.vehicleMinDistM;
    return {
      ok: okT && okD, arrivalMin: e, distTo1hM: ctx.dist1h[k],
      text: `${okT ? "" : `„Möglich“-Front frühestens in ${fmtMin(tP)}, einzelner Lauf ${fmtMin(e)} (gefordert: „möglich“ ≥ ${need} min = Bereitschaft ${ready} + ${S.vehicleSafetyMin} min Puffer, kein Lauf vor ${ready} min). `}${okD ? "" : `Nur ${Math.round(ctx.dist1h[k])} m vom 1-h-Bereich (Annahme Mindestabstand ${S.vehicleMinDistM} m). `}${okT && okD ? "Sicherheitsannahmen erfüllt." : ""}`,
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

  const Suggest = { compute, checkPosition, context, diff, fmtMin, KIND_LABEL, distanceTo, hasWater, possibleTimes, threatenedObjects };
  root.Suggest = Suggest;
  if (typeof module !== "undefined" && module.exports) module.exports = Suggest;
})(typeof globalThis !== "undefined" ? globalThis : this);
