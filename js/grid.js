/*
 * Rechenraster, lokale Projektion und Rasterisierung (Polygone/Linien).
 * Lokale äquidistante Projektion um (lat0, lon0) in Metern - siehe Hinweis in model.js.
 */
(function (root) {
  const R_EARTH = 6371008.8;

  function makeProjection(lat0, lon0) {
    const k = Math.cos((lat0 * Math.PI) / 180);
    return {
      lat0, lon0,
      toXY(lat, lon) {
        return [((lon - lon0) * Math.PI / 180) * R_EARTH * k, ((lat - lat0) * Math.PI / 180) * R_EARTH];
      },
      toLatLng(x, y) {
        return [lat0 + (y / R_EARTH) * 180 / Math.PI, lon0 + (x / (R_EARTH * k)) * 180 / Math.PI];
      },
    };
  }

  /**
   * Raster mit Mittelpunkt (lat0, lon0), quadratisch, halfSizeM, cellM. Zeile j wächst nach Norden.
   * dem (optional, js/dem.js): füllt g.elev (Höhe der Zellmitte in m, NaN = keine Daten),
   * g.elevMissing (Anzahl Zellen ohne Höhe) sowie g.slope/g.aspect (Horn, siehe terrain()).
   */
  function makeGrid(lat0, lon0, halfSizeM, cellM, classList, dem) {
    const proj = makeProjection(lat0, lon0);
    const n = Math.round((2 * halfSizeM) / cellM);
    const g = {
      proj, cell: cellM, nx: n, ny: n, x0: -halfSizeM, y0: -halfSizeM,
      classList,
      fuel: new Uint8Array(n * n).fill(classList.indexOf("unbekannt")),
    };
    const [s, w] = proj.toLatLng(-halfSizeM, -halfSizeM);
    const [nn, e] = proj.toLatLng(halfSizeM, halfSizeM);
    g.bounds = { south: s, west: w, north: nn, east: e };
    if (dem && typeof dem.sample === "function") {
      const elev = new Float32Array(n * n);
      let missing = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const [la, lo] = proj.toLatLng(g.x0 + (i + 0.5) * cellM, g.y0 + (j + 0.5) * cellM);
        const v = dem.sample(la, lo);
        if (v === null || v === undefined || Number.isNaN(v)) { elev[j * n + i] = NaN; missing++; }
        else elev[j * n + i] = v;
      }
      g.elev = elev;
      g.elevMissing = missing;
      terrain(g);
    }
    return g;
  }

  /**
   * Hangneigung und Exposition nach Horn (1981) aus g.elev (3x3-Fenster).
   * g.slope = tan(Neigung) (dimensionslos), g.aspect = Richtung des Gefälles (bergab) in Grad
   * (0 = Nord, 90 = Ost), NaN wo keine Höhe vorliegt. Fehlende Nachbarn werden durch die
   * Mittelzelle ersetzt. Nur Anzeige/Kennzahlen; das Modell nutzt Höhendifferenzen je Kante.
   */
  function terrain(g) {
    const { nx, ny, cell, elev } = g;
    if (!elev) return g;
    const slope = new Float32Array(nx * ny), aspect = new Float32Array(nx * ny);
    let sum = 0, cnt = 0, max = 0, zmin = Infinity, zmax = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, e = elev[k];
      if (Number.isNaN(e)) { slope[k] = NaN; aspect[k] = NaN; continue; }
      const z = (di, dj) => {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) return e;
        const v = elev[b * nx + a];
        return Number.isNaN(v) ? e : v;
      };
      // Zeile j wächst nach Norden
      const dzdx = ((z(1, 1) + 2 * z(1, 0) + z(1, -1)) - (z(-1, 1) + 2 * z(-1, 0) + z(-1, -1))) / (8 * cell);
      const dzdy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * cell);
      const t = Math.hypot(dzdx, dzdy);
      slope[k] = t;
      aspect[k] = t > 0 ? ((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI + 360) % 360 : NaN;
      sum += t; cnt++; if (t > max) max = t;
      if (e < zmin) zmin = e; if (e > zmax) zmax = e;
    }
    g.slope = slope; g.aspect = aspect;
    g.terrainStats = cnt ? { meanTan: sum / cnt, maxTan: max, elevMin: zmin, elevMax: zmax, cells: cnt } : null;
    return g;
  }

  function cellCenter(g, i) {
    const ci = i % g.nx, cj = (i - ci) / g.nx;
    return [g.x0 + (ci + 0.5) * g.cell, g.y0 + (cj + 0.5) * g.cell];
  }
  function cellLatLng(g, i) {
    const [x, y] = cellCenter(g, i);
    return g.proj.toLatLng(x, y);
  }
  function cellOf(g, x, y) {
    const ci = Math.floor((x - g.x0) / g.cell), cj = Math.floor((y - g.y0) / g.cell);
    if (ci < 0 || cj < 0 || ci >= g.nx || cj >= g.ny) return -1;
    return cj * g.nx + ci;
  }

  /**
   * Füllt Zellen, deren Mittelpunkt innerhalb der durch Segmente beschriebenen Fläche liegt
   * (Even-Odd-Regel). Segmente müssen zusammen geschlossene Ringe bilden; innere Ringe
   * (Löcher) werden dadurch automatisch ausgespart. Ruft cb(index) für jede Zelle.
   */
  function fillSegments(g, segs, cb) {
    if (!segs.length) return;
    let minY = Infinity, maxY = -Infinity;
    for (const s of segs) { minY = Math.min(minY, s[1], s[3]); maxY = Math.max(maxY, s[1], s[3]); }
    const j0 = Math.max(0, Math.floor((minY - g.y0) / g.cell - 0.5));
    const j1 = Math.min(g.ny - 1, Math.ceil((maxY - g.y0) / g.cell - 0.5));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const yc = g.y0 + (j + 0.5) * g.cell;
      xs.length = 0;
      for (const s of segs) {
        const [x1, y1, x2, y2] = s;
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
          xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell - 0.5));
        const i1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / g.cell - 0.5));
        for (let i = i0; i <= i1; i++) cb(j * g.nx + i);
      }
    }
  }

  function ringToSegs(ringXY, out) {
    for (let k = 0; k + 1 < ringXY.length; k++) {
      out.push([ringXY[k][0], ringXY[k][1], ringXY[k + 1][0], ringXY[k + 1][1]]);
    }
    const a = ringXY[0], b = ringXY[ringXY.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([b[0], b[1], a[0], a[1]]);
    return out;
  }

  /** Linie 4-zusammenhängend rastern (keine diagonalen Lücken), cb(index). */
  function rasterLine(g, ptsXY, cb) {
    let last = -1, lastI = -1, lastJ = -1;
    for (let k = 0; k + 1 < ptsXY.length; k++) {
      const [x1, y1] = ptsXY[k], [x2, y2] = ptsXY[k + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const steps = Math.max(1, Math.ceil(len / (g.cell / 3)));
      for (let s = 0; s <= steps; s++) {
        const x = x1 + ((x2 - x1) * s) / steps, y = y1 + ((y2 - y1) * s) / steps;
        const ci = Math.floor((x - g.x0) / g.cell), cj = Math.floor((y - g.y0) / g.cell);
        if (ci < 0 || cj < 0 || ci >= g.nx || cj >= g.ny) { last = -1; continue; }
        const idx = cj * g.nx + ci;
        if (idx === last) continue;
        if (last >= 0 && ci !== lastI && cj !== lastJ) {
          const mid = lastJ * g.nx + ci; // Zwischenzelle, damit die Linie 4-zusammenhängend ist
          cb(mid);
        }
        cb(idx);
        last = idx; lastI = ci; lastJ = cj;
      }
    }
  }

  function polygonCells(g, latlngs) {
    const ring = latlngs.map(([lat, lon]) => g.proj.toXY(lat, lon));
    const cells = [];
    fillSegments(g, ringToSegs(ring, []), (i) => cells.push(i));
    if (!cells.length) {
      // sehr kleines Polygon: mindestens die Zelle des Schwerpunkts
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const c = cellOf(g, cx, cy);
      if (c >= 0) cells.push(c);
    }
    return Int32Array.from(cells);
  }

  const Grid = { makeProjection, makeGrid, terrain, cellCenter, cellLatLng, cellOf, fillSegments, ringToSegs, rasterLine, polygonCells };
  root.Grid = Grid;
  if (typeof module !== "undefined" && module.exports) module.exports = Grid;
})(typeof globalThis !== "undefined" ? globalThis : this);
