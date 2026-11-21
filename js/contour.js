/*
 * Konturen (Isochronen) und Rasterumrisse aus dem Rechenraster für die Kartenanzeige.
 * Reine Funktionen, UI-unabhängig, in Node testbar.
 *
 *  - isochrone(): Marching Squares auf den Zellmittelpunkten. Feld = Zeit (min), ab der eine Zelle
 *    "wahrscheinlich"/"möglich" ist bzw. vom Referenzlauf erreicht wird; Kontur bei t = Horizont.
 *    Lineare Interpolation zwischen Zellmittelpunkten. Nicht erreichte Zellen (Infinity, z. B.
 *    Barrieren) und der Rasterrand: Kontur auf halbem Weg (= Zellrand, wie im Raster).
 *  - smoothRing(): Chaikin-Glättung, simplifyRing(): Douglas-Peucker-Vereinfachung.
 *  - nestRings(): Außenringe und Löcher zuordnen (mehrere Teilflächen, Löcher).
 *  - cellOutline(): Umriss entlang der Zellränder (Rasteransicht, ungeglättet).
 *  - displayLayers(): Anzeigegeometrie je Horizont für Konturen- und Rasteransicht.
 * Koordinaten: "Zelleinheiten" (x = i + 0,5 ist der Mittelpunkt von Spalte i, y wächst nach Norden).
 * Umrechnung in Meter: X = g.x0 + x * g.cell, Y = g.y0 + y * g.cell.
 */
(function (root) {
  // Segmente je Fall (Bits: unten links 1, unten rechts 2, oben rechts 4, oben links 8),
  // Kanten: 0 = unten, 1 = rechts, 2 = oben, 3 = links. Innen liegt links der Laufrichtung.
  const CASES = {
    1: [[0, 3]], 2: [[1, 0]], 3: [[1, 3]], 4: [[2, 1]], 6: [[2, 0]], 7: [[2, 3]],
    8: [[3, 2]], 9: [[0, 2]], 11: [[1, 2]], 12: [[3, 1]], 13: [[0, 1]], 14: [[3, 0]],
  };
  const SADDLE = {
    5: { inside: [[0, 1], [2, 3]], outside: [[0, 3], [2, 1]] },
    10: { inside: [[3, 0], [1, 2]], outside: [[1, 0], [3, 2]] },
  };

  /**
   * Isochrone/Isolinie per Marching Squares.
   * @param field Werte je Zelle (Länge nx*ny, Zeile j = Süden -> Norden)
   * @param thr Schwelle
   * @param opts {le: true -> innen wenn v <= thr (Zeitfeld), sonst v >= thr; interp: "linear"|"mid";
   *   maxValid: Werte darüber gelten als unsicher (vorläufige Ankunftszeiten jenseits des letzten
   *   Horizonts) -> halber Weg; source: Uint8Array der Brandflächenzellen (Front startet am Zellrand)}
   * @returns Array geschlossener Ringe [[x,y],...] (erster Punkt nicht wiederholt), innen links
   *          (Außenringe gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn).
   */
  function isochrone(field, nx, ny, thr, opts = {}) {
    const le = opts.le !== false;
    const linear = opts.interp !== "mid";
    const inside = (v) => (le ? v <= thr : v >= thr); // NaN -> false
    const val = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? NaN : field[j * nx + i]);
    const idx = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i);
    // Begrenzungsrahmen der Innenzellen (+1), damit nur der relevante Teil abgetastet wird
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (inside(field[j * nx + i])) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    }
    if (i1 < 0) return [];
    const W = nx + 2;
    const key = (edge, i, j) => {
      // eindeutige Kanten-ID: waagerechte Kante (i,j)-(i+1,j) oder senkrechte (i,j)-(i,j+1)
      if (edge === 0) return ((j + 1) * W + (i + 1)) * 2;
      if (edge === 2) return ((j + 2) * W + (i + 1)) * 2;
      if (edge === 3) return ((j + 1) * W + (i + 1)) * 2 + 1;
      return ((j + 1) * W + (i + 2)) * 2 + 1; // rechts
    };
    const maxValid = opts.maxValid ?? Infinity;
    const src = opts.source || null; // Flächenquelle (Brandfläche): ganze Zelle brennt ab t = 0
    // Anteil des Wegs von Mittelpunkt a nach b, an dem die Schwelle erreicht wird
    const frac = (va, vb, ka, kb) => {
      if (!linear || !Number.isFinite(va) || !Number.isFinite(vb) || va === vb || va > maxValid || vb > maxValid) return 0.5;
      const t = Math.min(1, Math.max(0, (thr - va) / (vb - va)));
      // Zelle der Brandfläche: Front startet am Zellrand (halber Weg), nicht am Mittelpunkt
      if (src && ka >= 0 && src[ka] && !(kb >= 0 && src[kb])) return 0.5 + 0.5 * t;
      if (src && kb >= 0 && src[kb] && !(ka >= 0 && src[ka])) return 0.5 * t;
      return t;
    };
    const point = (edge, i, j, v, q) => {
      // v = [BL, BR, TR, TL] Werte, q = Zellindizes (-1 außerhalb); Mittelpunkt BL = (i+0.5, j+0.5)
      const x = i + 0.5, y = j + 0.5;
      if (edge === 0) return [x + frac(v[0], v[1], q[0], q[1]), y];
      if (edge === 1) return [x + 1, y + frac(v[1], v[2], q[1], q[2])];
      if (edge === 2) return [x + frac(v[3], v[2], q[3], q[2]), y + 1];
      return [x, y + frac(v[0], v[3], q[0], q[3])];
    };
    const next = new Map(); // Start-Kante -> {to, p}
    for (let j = j0 - 1; j <= j1; j++) for (let i = i0 - 1; i <= i1; i++) {
      const v = [val(i, j), val(i + 1, j), val(i + 1, j + 1), val(i, j + 1)];
      const q = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
      const c = (inside(v[0]) ? 1 : 0) | (inside(v[1]) ? 2 : 0) | (inside(v[2]) ? 4 : 0) | (inside(v[3]) ? 8 : 0);
      if (c === 0 || c === 15) continue;
      let segs = CASES[c];
      if (!segs) {
        // Sattel: Mittelwert der vier Ecken entscheidet (nicht endliche Werte zählen als außen)
        const fin = v.filter(Number.isFinite);
        const mean = fin.length === 4 ? (v[0] + v[1] + v[2] + v[3]) / 4 : NaN;
        segs = inside(mean) ? SADDLE[c].inside : SADDLE[c].outside;
      }
      for (const [a, b] of segs) {
        next.set(key(a, i, j), { to: key(b, i, j), p: point(a, i, j, v, q) });
      }
    }
    const rings = [];
    for (const startKey of next.keys()) {
      if (!next.has(startKey)) continue;
      const ring = [];
      let k = startKey;
      while (next.has(k)) {
        const s = next.get(k);
        next.delete(k);
        ring.push(s.p);
        k = s.to;
      }
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  }

  /** Vorzeichenbehaftete Fläche (positiv = gegen den Uhrzeigersinn). */
  function ringArea(r) {
    let a = 0;
    for (let k = 0, n = r.length; k < n; k++) {
      const p = r[k], q = r[(k + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  /** Chaikin-Glättung eines geschlossenen Rings. */
  function smoothRing(r, iterations = 2) {
    let cur = r;
    for (let it = 0; it < iterations; it++) {
      const out = [];
      for (let k = 0, n = cur.length; k < n; k++) {
        const p = cur[k], q = cur[(k + 1) % n];
        out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
        out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
      }
      cur = out;
    }
    return cur;
  }

  function segDist2(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
    return x * x + y * y;
  }
  function dpOpen(pts, tol2) {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1, bd = tol2;
      for (let k = a + 1; k < b; k++) {
        const d = segDist2(pts[k], pts[a], pts[b]);
        if (d > bd) { bd = d; best = k; }
      }
      if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter((_, k) => keep[k]);
  }
  /** Douglas-Peucker für geschlossene Ringe (Toleranz in Koordinateneinheiten). */
  function simplifyRing(r, tol) {
    if (r.length < 8 || !(tol > 0)) return r;
    // Anker: Punkt 0 und der davon am weitesten entfernte Punkt
    let far = 0, fd = -1;
    for (let k = 1; k < r.length; k++) {
      const d = (r[k][0] - r[0][0]) ** 2 + (r[k][1] - r[0][1]) ** 2;
      if (d > fd) { fd = d; far = k; }
    }
    const tol2 = tol * tol;
    const a = dpOpen(r.slice(0, far + 1), tol2);
    const b = dpOpen([...r.slice(far), r[0]], tol2);
    const out = [...a, ...b.slice(1, -1)];
    return out.length >= 3 ? out : r;
  }

  function pointInRing(p, r) {
    let inside = false;
    for (let k = 0, n = r.length, m = n - 1; k < n; m = k++) {
      const a = r[k], b = r[m];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  /**
   * Ordnet Ringe zu Polygonen: [{outer, holes:[...], area}] (Fläche netto, Zelleinheiten²).
   * Außenringe: positive Fläche; Löcher: negative Fläche, dem kleinsten umgebenden Außenring zugeordnet.
   */
  function nestRings(rings) {
    const outers = [], holes = [];
    for (const r of rings) {
      const a = ringArea(r);
      if (Math.abs(a) < 1e-9) continue;
      (a > 0 ? outers : holes).push({ r, a });
    }
    outers.sort((x, y) => x.a - y.a);
    const polys = outers.map((o) => ({ outer: o.r, holes: [], area: o.a }));
    for (const h of holes) {
      const p = polys.find((q) => q.area >= -h.a && pointInRing(h.r[0], q.outer));
      if (p) { p.holes.push(h.r); p.area += h.a; }
    }
    return polys;
  }

  /**
   * Komplette Kette: Isochrone -> Glättung -> Vereinfachung -> Polygone.
   * opts: {smooth: Iterationen (0 = aus), simplify: Toleranz in Zelleinheiten, interp, maxValid, source}
   * @returns {polygons, area (Zelleinheiten²), rawArea (vor Glättung), rings}
   */
  function contourPolygons(field, nx, ny, thr, opts = {}) {
    const raw = isochrone(field, nx, ny, thr, { le: true, interp: opts.interp, maxValid: opts.maxValid, source: opts.source });
    const it = opts.smooth ?? 2, tol = opts.simplify ?? 0;
    const rawArea = raw.reduce((s, r) => s + ringArea(r), 0);
    const rings = raw.map((r) => simplifyRing(it > 0 ? smoothRing(r, it) : r, tol)).filter((r) => r.length >= 3);
    const polygons = nestRings(rings);
    const area = polygons.reduce((s, p) => s + p.area, 0);
    return { polygons, area, rawArea, rings };
  }

  /** Anzahl der Zellen mit field <= thr (Rasterfläche in Zellen). */
  function rasterCount(field, thr) {
    let n = 0;
    for (let k = 0; k < field.length; k++) if (field[k] <= thr) n++;
    return n;
  }

  /**
   * Umriss einer Zellmaske entlang der Zellränder (Treppenlinie), als geschlossene Ringe.
   * inside(k) -> bool. Eckpunkte in Zelleinheiten (Zellecke (i,j) = (i, j)).
   */
  function cellOutline(nx, ny, inside) {
    const isIn = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && inside(j * nx + i);
    const out = new Map(); // Startecke -> Liste von Endecken
    const W = nx + 1;
    const add = (x1, y1, x2, y2) => {
      const k = y1 * W + x1;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(y2 * W + x2);
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!isIn(i, j)) continue;
      if (!isIn(i, j - 1)) add(i, j, i + 1, j); // unten, innen links -> nach Osten
      if (!isIn(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!isIn(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!isIn(i - 1, j)) add(i, j + 1, i, j);
    }
    const rings = [];
    for (const start of [...out.keys()]) {
      while (out.has(start) && out.get(start).length) {
        const ring = [];
        let k = start;
        while (out.has(k) && out.get(k).length) {
          const list = out.get(k);
          const nk = list.pop();
          if (!list.length) out.delete(k);
          ring.push([k % W, Math.floor(k / W)]);
          k = nk;
        }
        if (ring.length >= 4) rings.push(ring);
      }
    }
    return rings;
  }

  /** Entfernt Zwischenpunkte auf geraden Strecken (Treppenlinien kompakter). */
  function dropCollinear(r) {
    const out = [];
    for (let k = 0, n = r.length; k < n; k++) {
      const a = r[(k - 1 + n) % n], p = r[k], b = r[(k + 1) % n];
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      if (Math.abs(cross) > 1e-12) out.push(p);
    }
    return out.length >= 3 ? out : r;
  }

  /**
   * Zeitfelder für die Anzeige: Zeit (min), ab der eine Zelle "wahrscheinlich" bzw. "möglich" ist.
   * Bevorzugt die exakten Felder aus runEnsemble (tLikely/tPossible). Fallback für Modelle ohne diese
   * Felder: grob aus den Zählern je Horizont (Zeit = erster Horizont mit Anteil >= Schwelle).
   */
  function timeFields(result, P) {
    if (result.tLikely && result.tPossible) return { likely: result.tLikely, possible: result.tPossible, exact: true };
    const n = result.counts[0].length;
    const mk = (thr) => {
      const t = new Float32Array(n).fill(Infinity);
      for (let i = 0; i < n; i++) for (let h = 0; h < result.horizons.length; h++) {
        if (result.counts[h][i] / result.runs >= thr) { t[i] = result.horizons[h] * 60; break; }
      }
      return t;
    };
    return { likely: mk(P.ensemble.likely), possible: mk(P.ensemble.possible), exact: false };
  }

  /**
   * Anzeigegeometrie je Horizont, rein geometrisch (ohne Leaflet), für beide Darstellungen:
   *  mode "kontur": Isochronen (Marching Squares) + Chaikin + Douglas-Peucker
   *  mode "raster": Umrisse entlang der Zellränder (ungeglättet, 25-m-Kästchen)
   * Ergebnis: [{H, likely, possible, reference, stats}] mit Ringen in Zelleinheiten.
   * likely/possible sind Flächen (Polygone mit Löchern), reference ist nur eine LINIE (keine Fläche,
   * keine gefüllten Zellen; Ursache der früheren schwarzen Kästchen, siehe docs/assumptions.md).
   * stats: Rasterfläche und dargestellte Fläche in Zellen (für Flächenabweichung).
   */
  function displayLayers(nx, ny, result, P, opts = {}) {
    const mode = opts.mode === "raster" ? "raster" : "kontur";
    const D = (P.display && P.display.contour) || {};
    const it = opts.smooth ?? D.chaikinIterations ?? 2;
    const tol = opts.simplify ?? D.simplifyCells ?? 0.2;
    const tf = timeFields(result, P);
    const fields = { likely: tf.likely, possible: tf.possible, reference: result.reference };
    const tMax = Math.max(...result.horizons) * 60;
    let source = null;
    if (opts.ignition && opts.ignition.length) { source = new Uint8Array(nx * ny); for (const k of opts.ignition) source[k] = 1; }
    return result.horizons.map((H) => {
      const T = H * 60;
      const layer = { H, stats: {} };
      for (const [name, f] of Object.entries(fields)) {
        const rasterCells = rasterCount(f, T);
        if (mode === "raster") {
          const rings = cellOutline(nx, ny, (k) => f[k] <= T).map(dropCollinear);
          const polygons = nestRings(rings);
          layer[name] = { rings, polygons };
          layer.stats[name] = { rasterCells, shownCells: polygons.reduce((s, p) => s + p.area, 0) };
        } else {
          const c = contourPolygons(f, nx, ny, T, { smooth: it, simplify: tol, maxValid: tMax, source });
          layer[name] = { rings: c.rings, polygons: c.polygons };
          layer.stats[name] = { rasterCells, shownCells: c.area, rawCells: c.rawArea };
        }
      }
      return layer;
    });
  }

  const Contour = {
    isochrone, ringArea, smoothRing, simplifyRing, nestRings, pointInRing, contourPolygons, rasterCount, cellOutline, dropCollinear,
    timeFields, displayLayers,
  };
  root.Contour = Contour;
  if (typeof module !== "undefined" && module.exports) module.exports = Contour;
})(typeof globalThis !== "undefined" ? globalThis : this);
