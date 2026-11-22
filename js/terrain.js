/*
 * Geländeeinfluss auf Wind und Feinbrennstofffeuchte (neu in 0.4.0). Reine Funktionen, deterministisch.
 *
 * VEREINFACHTE, DIAGNOSTISCHE KORREKTUR (keine Strömungsrechnung):
 *  1. Exposition/Abschattung: Faktor auf die Windgeschwindigkeit aus
 *     - Winstral-Sx (Winstral, Elder & Davis 2002): größter Horizontwinkel in Luv-Richtung bis sxMaxDistM
 *       (> 0 = Lee/abgeschattet -> schwächer, < 0 = exponiert -> stärker),
 *     - Topographic Position Index (TPI, Kuppe > 0 -> stärker, Mulde < 0 -> schwächer),
 *     - Hangneigung in Windrichtung (Luvhang stärker, Leehang schwächer; angelehnt an MicroMet,
 *       Liston & Elder 2006; Gewichte eigene Annahme).
 *     Begrenzt auf [factorMin, factorMax] (Annahme 0,5–1,4).
 *  2. Talkanalisierung: in ausgeprägten Tälern (TPI deutlich negativ, Strukturtensor der Hangneigung kohärent)
 *     wird die Windrichtung teilweise zur Talachse gedreht (Gewicht nach Taltiefe, Kohärenz und Winkel),
 *     die Komponente quer zum Tal gedämpft.
 *  3. Hang-/Talwind (thermisch): nur bei schwachem synoptischem Wind; tagsüber hangaufwärts, nachts hangabwärts.
 *     Tageszeit aus Sonnenstand (NOAA-Näherung, siehe solar()). Talwind entlang der Talachse nicht getrennt;
 *     der Hangwind auf dem geglätteten Gelände zeigt in Talsohlen grob talaufwärts.
 *  4. Feinbrennstofffeuchte nach Einstrahlung: tagsüber dM = -k (cos i - cos z), begrenzt (eigene Annahme).
 *
 * Alle Eingangsfelder werden geglättet (Box-Filter), damit keine Rasterartefakte entstehen.
 * NICHT modelliert: Massenerhaltung (WindNinja o. ä. wäre Phase 3), Wirbel/Leewalzen, feuerinduzierte Winde,
 * Inversionen/Kaltluftseen, Föhn, Bewölkung (Einstrahlung wolkenlos angenommen).
 */
(function (root) {
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** Separabler Box-Filter (Radius r Zellen, passes Durchläufe), Ränder abgeschnitten (Mittel über gültige Zellen). */
  function boxBlur(src, nx, ny, r, passes) {
    let a = Float32Array.from(src);
    if (r <= 0 || passes <= 0) return a;
    let b = new Float32Array(a.length);
    for (let p = 0; p < passes; p++) {
      // horizontal
      for (let j = 0; j < ny; j++) {
        const o = j * nx;
        let s = 0, c = 0;
        for (let i = 0; i <= Math.min(r, nx - 1); i++) { s += a[o + i]; c++; }
        for (let i = 0; i < nx; i++) {
          b[o + i] = s / c;
          const add = i + r + 1, rem = i - r;
          if (add < nx) { s += a[o + add]; c++; }
          if (rem >= 0) { s -= a[o + rem]; c--; }
        }
      }
      // vertikal
      for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let j = 0; j <= Math.min(r, ny - 1); j++) { s += b[j * nx + i]; c++; }
        for (let j = 0; j < ny; j++) {
          a[j * nx + i] = s / c;
          const add = j + r + 1, rem = j - r;
          if (add < ny) { s += b[add * nx + i]; c++; }
          if (rem >= 0) { s -= b[rem * nx + i]; c--; }
        }
      }
    }
    return a;
  }

  /** NaN-Zellen (außerhalb DGM) durch Mittel gültiger Nachbarn auffüllen (nur für die Glättung). */
  function fillNaN(elev, nx, ny) {
    const z = Float32Array.from(elev);
    const valid = new Uint8Array(z.length);
    let sum = 0, cnt = 0;
    for (let k = 0; k < z.length; k++) if (!Number.isNaN(z[k])) { valid[k] = 1; sum += z[k]; cnt++; }
    if (cnt === z.length) return { z, valid, any: true };
    if (!cnt) return { z: z.fill(0), valid, any: false };
    const known = Uint8Array.from(valid);
    for (let pass = 0; pass < 24; pass++) {
      let changed = 0;
      const nk = Uint8Array.from(known);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (known[k]) continue;
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          const q = b * nx + a;
          if (known[q]) { s += z[q]; c++; }
        }
        if (c) { z[k] = s / c; nk[k] = 1; changed++; }
      }
      known.set(nk);
      if (!changed) break;
    }
    const mean = sum / cnt;
    for (let k = 0; k < z.length; k++) if (!known[k]) z[k] = mean;
    return { z, valid, any: true };
  }

  /**
   * Statische Geländefelder je Rechenraster (einmal je Raster, gecacht in grid._terrainPrep):
   * geglättete Höhe, Gradient (tan, x Ost / y Nord), TPI, Talachse + Talgewicht, Sx je Sektor (lazy).
   */
  function prepare(grid, P) {
    const T = P.terrain.wind;
    if (grid._terrainPrep && grid._terrainPrep.T === T && grid._terrainPrep.elev === grid.elev) return grid._terrainPrep;
    const { nx, ny, cell } = grid;
    const n = nx * ny;
    const t0 = Date.now();
    const { z, valid } = fillNaN(grid.elev, nx, ny);
    const zs = boxBlur(z, nx, ny, T.smoothRadiusCells, T.smoothPasses);
    const gx = new Float32Array(n), gy = new Float32Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
      gx[k] = (zs[j * nx + i1] - zs[j * nx + i0]) / ((i1 - i0) * cell || 1);
      gy[k] = (zs[j1 * nx + i] - zs[j0 * nx + i]) / ((j1 - j0) * cell || 1);
    }
    // TPI: Höhe minus Mittel im Quadrat ±R (ein Box-Durchlauf), dann leicht geglättet
    const R = Math.max(1, Math.round(T.tpiRadiusM / cell));
    const mean = boxBlur(zs, nx, ny, R, 1);
    let tpi = new Float32Array(n);
    for (let k = 0; k < n; k++) tpi[k] = zs[k] - mean[k];
    // Strukturtensor der Hangneigung: Hauptrichtung = quer zum Tal; Talachse senkrecht dazu
    const W = Math.max(1, Math.round(T.valleyWindowM / cell));
    const jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
    for (let k = 0; k < n; k++) { jxx[k] = gx[k] * gx[k]; jyy[k] = gy[k] * gy[k]; jxy[k] = gx[k] * gy[k]; }
    const sxx = boxBlur(jxx, nx, ny, W, 2), syy = boxBlur(jyy, nx, ny, W, 2), sxy = boxBlur(jxy, nx, ny, W, 2);
    const ax = new Float32Array(n), ay = new Float32Array(n), valleyW = new Float32Array(n), coherence = new Float32Array(n);
    const [d0, d1] = T.valleyDepthM, [c0, c1] = T.valleyCoherence;
    for (let k = 0; k < n; k++) {
      const a = sxx[k], b = syy[k], c = sxy[k];
      const tr = a + b;
      const diff = Math.sqrt((a - b) * (a - b) + 4 * c * c);
      const coh = tr > 1e-12 ? diff / tr : 0;
      coherence[k] = coh;
      const th = 0.5 * Math.atan2(2 * c, a - b); // Richtung quer zum Tal (mathematischer Winkel)
      ax[k] = -Math.sin(th); ay[k] = Math.cos(th); // Talachse = senkrecht dazu
      const depthW = clamp((-tpi[k] - d0) / (d1 - d0), 0, 1);
      const cohW = clamp((coh - c0) / (c1 - c0), 0, 1);
      valleyW[k] = valid[k] ? depthW * cohW : 0;
    }
    const prep = {
      T, elev: grid.elev, nx, ny, cell, valid, zs, gx, gy, tpi, ax, ay, valleyW, coherence,
      sx: new Array(T.sxSectors).fill(null), prepMs: 0,
    };
    prep.prepMs = Date.now() - t0;
    grid._terrainPrep = prep;
    return prep;
  }

  /** Winstral-Sx (Grad) für Wind AUS Sektor s, geglättet; lazy. */
  function sxSector(prep, s) {
    if (prep.sx[s]) return prep.sx[s];
    const { nx, ny, cell, zs, T } = prep;
    const fromDeg = (s * 360) / T.sxSectors;
    const fx = Math.sin(fromDeg * DEG), fy = Math.cos(fromDeg * DEG); // Richtung, aus der der Wind kommt (x Ost, y Nord)
    const steps = Math.max(1, Math.round(T.sxMaxDistM / cell));
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, z0 = zs[k];
      let best = -Infinity;
      for (let d = 1; d <= steps; d++) {
        const a = Math.round(i + fx * d), b = Math.round(j + fy * d);
        if (a < 0 || b < 0 || a >= nx || b >= ny) break;
        const t = (zs[b * nx + a] - z0) / (d * cell);
        if (t > best) best = t;
      }
      out[k] = best === -Infinity ? 0 : Math.atan(best) / DEG;
    }
    prep.sx[s] = boxBlur(out, nx, ny, T.smoothRadiusCells, 2);
    return prep.sx[s];
  }

  // ------------------------------------------------------------------ Sonnenstand (NOAA-Näherung)
  /**
   * Sonnenstand nach den Formeln "General Solar Position Calculations" (NOAA Global Monitoring
   * Laboratory). Formeln aus Literaturkenntnis übertragen, Genauigkeit ca. ±2 min / ±0,5° (zu prüfen).
   * @returns {elevDeg, azDeg (0 = Nord, im Uhrzeigersinn), cosZ, sinZ, sunX, sunY (horizontale Einheitsrichtung zur Sonne)}
   */
  function solar(tMs, lat, lon) {
    const { g, eqt, decl } = solarDay(tMs);
    const d = new Date(tMs);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    const tst = hour * 60 + eqt + 4 * lon; // wahre Sonnenzeit in min
    const ha = (tst / 4 - 180) * DEG;
    const phi = lat * DEG;
    let cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
    cosZ = clamp(cosZ, -1, 1);
    const zen = Math.acos(cosZ);
    const az = (180 + Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / DEG + 360) % 360;
    void g;
    return { elevDeg: 90 - zen / DEG, azDeg: az, cosZ, sinZ: Math.sin(zen), sunX: Math.sin(az * DEG), sunY: Math.cos(az * DEG) };
  }
  function solarDay(tMs) {
    const d = new Date(tMs);
    const year = d.getUTCFullYear();
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const doy = Math.floor((tMs - Date.UTC(year, 0, 1)) / 86400000) + 1;
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    const g = ((2 * Math.PI) / (leap ? 366 : 365)) * (doy - 1 + (hour - 12) / 24);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    return { g, eqt, decl };
  }
  /** Sonnenauf- und -untergang (UTC-ms) am UTC-Tag von tMs (Refraktion 0,833°). null bei Polartag/-nacht. */
  function sunTimes(tMs, lat, lon) {
    const day0 = Date.UTC(new Date(tMs).getUTCFullYear(), new Date(tMs).getUTCMonth(), new Date(tMs).getUTCDate());
    const { eqt, decl } = solarDay(day0 + 12 * 3600000);
    const phi = lat * DEG;
    const x = Math.cos(90.833 * DEG) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
    if (x < -1 || x > 1) return null;
    const ha = Math.acos(x) / DEG;
    return { sunrise: day0 + (720 - 4 * (lon + ha) - eqt) * 60000, sunset: day0 + (720 - 4 * (lon - ha) - eqt) * 60000 };
  }

  // ------------------------------------------------------------------ Windfeld je Lauf und Stunde
  /**
   * Erzeugt ein Feld-Objekt für einen Lauf. opts: {strength, dDir, windFactor, wind, moisture, lat, lon}
   * setHour(h) setzt die Stundenkonstanten; cell(i) schreibt in out.{spd, ux, uy, dM, fac} (Skalare):
   *   spd = lokaler 10-m-Wind (km/h), (ux, uy) = Einheitsrichtung, in die der Wind weht (x Ost, y Nord),
   *   dM = Feuchtekorrektur in %-Punkten (negativ = trockener), fac = Faktor nur aus Exposition/Tal (ohne Thermik).
   */
  function makeRunField(prep, weatherHours, P, opts) {
    const T = P.terrain.wind, MP = P.terrain.moisture;
    const S = opts.strength ?? 1;
    const useWind = opts.wind !== false, useMoist = opts.moisture !== false && MP.enabled !== false;
    const out = { spd: 0, ux: 0, uy: 1, dM: 0, fac: 1, thermal: 0 };
    const H = {};
    const hourInfo = [];
    function setHour(h) {
      const w = weatherHours[Math.min(weatherHours.length - 1, h)];
      const dirFrom = ((((w.windDirDeg + (opts.dDir || 0)) % 360) + 360) % 360);
      const sf = dirFrom / (360 / T.sxSectors);
      H.s0 = Math.floor(sf) % T.sxSectors; H.s1 = (H.s0 + 1) % T.sxSectors; H.f = sf - Math.floor(sf);
      H.sxA = useWind ? sxSector(prep, H.s0) : null; H.sxB = useWind ? sxSector(prep, H.s1) : null;
      const head = (dirFrom + 180) * DEG;
      H.tx = Math.sin(head); H.ty = Math.cos(head);
      H.spd = w.windKmh * (opts.windFactor ?? 1);
      // Tageszeit: Mitte der Stunde; ohne Zeitstempel keine Thermik/Feuchtekorrektur
      H.sun = Number.isFinite(w.t) && Number.isFinite(opts.lat) ? solar(w.t + 1800000, opts.lat, opts.lon) : null;
      H.thW = 0; H.up = 0;
      if (useWind && H.sun && H.spd < T.thermalMaxSynKmh) {
        H.thW = 1 - H.spd / T.thermalMaxSynKmh;
        const e = H.sun.elevDeg;
        const day = clamp(e / T.thermalSunFullDeg, 0, 1), night = clamp(-e / T.thermalNightFullDeg, 0, 1);
        H.up = T.thermalUpKmh * day - T.thermalDownKmh * night; // > 0 hangaufwärts, < 0 hangabwärts
      }
      H.moist = useMoist && H.sun && H.sun.elevDeg > 0;
      hourInfo[h] = { h, dirFrom, spd: H.spd, sunElevDeg: H.sun ? +H.sun.elevDeg.toFixed(1) : null, thermal: H.thW > 0 && H.up !== 0 ? (H.up > 0 ? "hangaufwärts" : "hangabwärts") : null };
      return H;
    }
    function cell(i) {
      if (!prep.valid[i]) { out.spd = H.spd; out.ux = H.tx; out.uy = H.ty; out.dM = 0; out.fac = 1; out.thermal = 0; return out; }
      const gx = prep.gx[i], gy = prep.gy[i];
      let vx = H.tx, vy = H.ty, fac = 1, damp = 1;
      if (useWind) {
        const sx = H.sxA[i] * (1 - H.f) + H.sxB[i] * H.f;
        const sxN = clamp(sx / T.sxScaleDeg, -1, 1);
        const tpiN = clamp(prep.tpi[i] / T.tpiScaleM, -1, 1);
        const slN = clamp((gx * H.tx + gy * H.ty) / T.slopeScaleTan, -1, 1); // weht bergauf = Luvhang
        fac = clamp(1 - T.sxWeight * sxN + T.tpiWeight * tpiN + T.slopeWeight * slN, T.factorMin, T.factorMax);
        fac = clamp(1 + S * (fac - 1), T.factorMin, T.factorMax);
        // Talkanalisierung
        const vw = prep.valleyW[i];
        if (vw > 0) {
          let ax = prep.ax[i], ay = prep.ay[i];
          let d = H.tx * ax + H.ty * ay;
          if (d < 0) { ax = -ax; ay = -ay; d = -d; }
          const cr = H.tx * ay - H.ty * ax;
          const alpha = Math.atan2(cr, d); // Winkel Wind -> Talachse (mathematisch, ccw)
          const w = clamp(S * T.valleyMaxTurn * vw * Math.sqrt(d), 0, 1);
          const phi = w * alpha, c = Math.cos(phi), s = Math.sin(phi);
          vx = H.tx * c - H.ty * s; vy = H.tx * s + H.ty * c;
          damp = clamp(1 - S * T.valleyCrossDamping * vw * (1 - d * d), 0.3, 1);
        }
      }
      let sp = H.spd * fac * damp;
      vx *= sp; vy *= sp;
      out.thermal = 0;
      if (H.thW > 0 && H.up !== 0) {
        const tn = Math.hypot(gx, gy);
        if (tn > 1e-6) {
          const mag = S * H.thW * H.up * Math.min(1, tn / T.thermalFullTan);
          vx += (mag * gx) / tn; vy += (mag * gy) / tn;
          out.thermal = mag;
        }
      }
      sp = Math.hypot(vx, vy);
      if (sp > 1e-9) { out.ux = vx / sp; out.uy = vy / sp; } else { out.ux = H.tx; out.uy = H.ty; }
      out.spd = sp; out.fac = fac * damp;
      out.dM = 0;
      if (H.moist) {
        const tn = Math.hypot(gx, gy);
        if (tn > 1e-6) {
          const cosB = 1 / Math.sqrt(1 + tn * tn), sinB = tn * cosB;
          const fx = -gx / tn, fy = -gy / tn; // Exposition (Hang zeigt bergab)
          const cosI = H.sun.cosZ * cosB + H.sun.sinZ * sinB * (H.sun.sunX * fx + H.sun.sunY * fy);
          const delta = Math.max(0, cosI) - Math.max(0, H.sun.cosZ);
          out.dM = S * clamp(-MP.kPerUnit * delta, -MP.maxDry, MP.maxWet);
        }
      }
      return out;
    }
    return { setHour, cell, out, hourInfo, strength: S };
  }

  /**
   * Feld für die Anzeige (Referenzstärke 1, ohne Ensemble-Störung) an ausgewählten Zellen.
   * @returns [{i, spd, ux, uy, fac, ratio, dM, thermal}]
   */
  function sampleField(grid, weatherHours, P, h, cells, opts = {}) {
    const prep = prepare(grid, P);
    const f = makeRunField(prep, weatherHours, P, { strength: 1, dDir: 0, windFactor: 1, wind: opts.wind !== false, moisture: opts.moisture !== false, lat: grid.proj.lat0, lon: grid.proj.lon0 });
    const Hh = f.setHour(h);
    return {
      hour: f.hourInfo[h],
      synKmh: Hh.spd,
      points: cells.map((i) => { const o = f.cell(i); return { i, spd: o.spd, ux: o.ux, uy: o.uy, fac: o.fac, ratio: o.spd / Math.max(Hh.spd, 1), dM: o.dM, thermal: o.thermal }; }),
    };
  }

  const TerrainWind = { boxBlur, fillNaN, prepare, sxSector, solar, sunTimes, makeRunField, sampleField };
  root.TerrainWind = TerrainWind;
  if (typeof module !== "undefined" && module.exports) module.exports = TerrainWind;
})(typeof globalThis !== "undefined" ? globalThis : this);
