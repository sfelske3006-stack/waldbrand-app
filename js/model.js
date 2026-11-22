/*
 * Ausbreitungsmodell (Berechnungskern). Reine Funktionen, deterministisch bei festem Seed,
 * unabhängig von der UI. Austauschbar über die Schnittstelle FireModel.runEnsemble().
 *
 * Bestandteile:
 *  1. Rothermel (1972) Oberflächenfeuer-Ausbreitungsrate, mit Lebend-Extinktionsfeuchte nach
 *     Albini (1976). Englische Einheiten intern (ft, lb, Btu, min).
 *     VEREINFACHUNGEN (bewusst, im Modellgrenzen-Dialog benannt):
 *       - Gewichtung innerhalb der Kategorien nur über Oberflächenanteile f_i
 *         (keine Größenklassen-Gewichtung g_i nach Albini 1976b).
 *       - Hangeffekt (phiS = 5.275 * beta^-0.3 * tan^2) wird je Rasterkante in travelTime()
         ergänzt, wenn ein DGM geladen ist (siehe dort). Ohne DGM: eben (tanSlope = 0).
 *       - Windbegrenzung U <= 0.9 * I_R (Rothermel 1972), ohne spätere Korrekturen.
 *     WICHTIG: Gleichungen aus der Literatur übertragen (Rothermel 1972, INT-115; Albini 1976,
 *     INT-30; Andrews 2018, RMRS-GTR-371). Abgleich mit Referenzwerten der Primärquelle
 *     (z. B. BehavePlus-Tabellen) ist OFFEN. tests/model.test.mjs prüft nur Plausibilität.
 *  2. Ellipsenform nach Anderson (1983): Längen-Breiten-Verhältnis aus Wind in Flammenhöhe.
 *     Ausbreitung in Richtung theta vom Zündpunkt (hinterer Brennpunkt):
 *     R(theta) = R_head * (1 - e) / (1 - e * cos(theta)).
 *  3. Raster-Umsetzung als Minimum-Travel-Time (Dijkstra) auf 16er-Nachbarschaft,
 *     zeitabhängiges Wetter stündlich (Wetter zum Ankunftszeitpunkt der Quellzelle).
 *  4. Ensemble mit Variation von Windrichtung, Windgeschwindigkeit, Tote-Brennstoff-Feuchte
 *     (mit Geländewind zusätzlich Stärke der Geländekorrektur).
 *  5. Geländewind (ab 0.4.0, js/terrain.js): lokaler Wind (Richtung/Stärke) und Feuchtekorrektur je Zelle
 *     und Stunde; travelTimeTerrain() nutzt sie je Kante. Ausgeschaltet: unveränderter Pfad travelTime()
 *     (Ergebnis bitgenau wie 0.3.0).
 *
 * Koordinaten: lokale, winkeltreue Näherung (äquidistante Projektion um den Brandschwerpunkt)
 * in Metern. ABWEICHUNG von der Spezifikation (EPSG:25832): Für ein Gebiet von 10 x 10 km ist der
 * Fehler gegenüber UTM klein (< 0,1 %); Umstellung auf UTM32 ist eine offene Aufgabe.
 */
(function (root) {
  const RHO_P = 32; // lb/ft³ Partikeldichte
  const HEAT = 8000; // Btu/lb
  const S_T = 0.0555; // Gesamtmineralgehalt
  const S_E = 0.01; // effektiver Mineralgehalt
  const FTMIN_PER_KMH = 54.6807; // 1 km/h = 54.68 ft/min
  const M_PER_FT = 0.3048;

  function moistureDamping(m, mx) {
    if (mx <= 0 || m >= mx) return 0;
    const r = m / mx;
    const eta = 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r;
    return Math.max(0, eta);
  }

  /**
   * Rothermel-Ausbreitungsrate.
   * @param fm Brennstoffmodell aus PARAMS.fuelModels
   * @param M Feuchten als Anteile {d1,d10,d100,lh,lw}
   * @param uMidFtMin Wind in Flammenhöhe in ft/min
   * @param tanSlope Tangens der Hangneigung (Rasterrechnung: 0, Hang wird in travelTime je Kante ergänzt)
   * @param tpa Umrechnung ton/acre -> lb/ft²
   * @returns {R (ft/min Kopffeuer), R0 (ohne Wind/Hang), IR, phiW, phiS, effWindFtMin, beta, slopeK}
   */
  function rothermel(fm, M, uMidFtMin, tanSlope, tpa) {
    const parts = [
      { live: false, w: fm.w[0] * tpa, s: fm.sav1, m: M.d1 },
      { live: false, w: fm.w[1] * tpa, s: 109, m: M.d10 },
      { live: false, w: fm.w[2] * tpa, s: 30, m: M.d100 },
      { live: true, w: fm.w[3] * tpa, s: fm.savLH, m: M.lh },
      { live: true, w: fm.w[4] * tpa, s: fm.savLW, m: M.lw },
    ].filter((p) => p.w > 0);
    const zero = { R: 0, R0: 0, IR: 0, phiW: 0, phiS: 0, effWindFtMin: 0, beta: 0, slopeK: 0, C: 0, B: 0, E: 0, ratio: 1 };
    if (!parts.length) return zero;
    const depth = fm.depth;
    const mxDead = fm.mx / 100;

    // Oberflächen je Partikelklasse
    for (const p of parts) p.a = (p.s * p.w) / RHO_P;
    const cats = [false, true].map((live) => {
      const ps = parts.filter((p) => p.live === live);
      const A = ps.reduce((s, p) => s + p.a, 0);
      for (const p of ps) p.f = A > 0 ? p.a / A : 0;
      return { live, ps, A };
    });
    const AT = cats[0].A + cats[1].A;
    for (const c of cats) {
      c.f = AT > 0 ? c.A / AT : 0;
      c.sigma = c.ps.reduce((s, p) => s + p.f * p.s, 0);
      c.wn = c.ps.reduce((s, p) => s + p.f * p.w * (1 - S_T), 0);
      c.mf = c.ps.reduce((s, p) => s + p.f * p.m, 0);
    }

    // Extinktionsfeuchte lebend (Albini 1976)
    let mxLive = mxDead;
    if (cats[1].ps.length) {
      const deadFine = cats[0].ps.reduce((s, p) => s + p.w * Math.exp(-138 / p.s), 0);
      const liveFine = cats[1].ps.reduce((s, p) => s + p.w * Math.exp(-500 / p.s), 0);
      const mfDeadFine = deadFine > 0
        ? cats[0].ps.reduce((s, p) => s + p.w * Math.exp(-138 / p.s) * p.m, 0) / deadFine : 0;
      const W = liveFine > 0 ? deadFine / liveFine : 0;
      mxLive = Math.max(mxDead, 2.9 * W * (1 - mfDeadFine / mxDead) - 0.226);
    }
    cats[0].mx = mxDead;
    cats[1].mx = mxLive;

    const sigma = cats[0].f * cats[0].sigma + cats[1].f * cats[1].sigma;
    const wTotal = parts.reduce((s, p) => s + p.w, 0);
    const rhoB = wTotal / depth;
    const beta = rhoB / RHO_P;
    const betaOp = 3.348 * Math.pow(sigma, -0.8189);
    const ratio = beta / betaOp;
    const gMax = Math.pow(sigma, 1.5) / (495 + 0.0594 * Math.pow(sigma, 1.5));
    const Aexp = 133 * Math.pow(sigma, -0.7913);
    const gamma = gMax * Math.pow(ratio, Aexp) * Math.exp(Aexp * (1 - ratio));
    const etaS = Math.min(1, 0.174 * Math.pow(S_E, -0.19));

    let IR = 0;
    for (const c of cats) {
      if (!c.ps.length) continue;
      IR += gamma * c.wn * HEAT * moistureDamping(c.mf, c.mx) * etaS;
    }
    if (IR <= 0) return zero;

    const xi = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192 + 0.2595 * sigma);
    // Wärmesenke
    let heatSink = 0;
    for (const c of cats) {
      let s = 0;
      for (const p of c.ps) s += p.f * Math.exp(-138 / p.s) * (250 + 1116 * p.m);
      heatSink += c.f * s;
    }
    heatSink *= rhoB;

    const C = 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55));
    const B = 0.02526 * Math.pow(sigma, 0.54);
    const E = 0.715 * Math.exp(-3.59e-4 * sigma);
    const U = Math.min(Math.max(0, uMidFtMin), 0.9 * IR); // Windbegrenzung
    const phiW = U > 0 ? C * Math.pow(U, B) * Math.pow(ratio, -E) : 0;
    const slopeK = 5.275 * Math.pow(beta, -0.3); // Hangkoeffizient (Rothermel 1972)
    const phiS = slopeK * (tanSlope || 0) * (tanSlope || 0);
    const R0 = (IR * xi) / heatSink;
    const R = R0 * (1 + phiW + phiS);
    return { R, R0, IR, phiW, phiS, effWindFtMin: U, beta, slopeK, C, B, E, ratio };
  }

  /** Längen-Breiten-Verhältnis nach Anderson (1983), Wind in Flammenhöhe in mi/h. */
  function lengthToWidth(uMidMph) {
    const lw = 0.936 * Math.exp(0.2566 * uMidMph) + 0.461 * Math.exp(-0.1548 * uMidMph) - 0.397;
    return Math.min(Math.max(lw, 1), 8);
  }
  function eccentricity(lw) {
    return lw <= 1 ? 0 : Math.sqrt(lw * lw - 1) / lw;
  }

  /**
   * Tote-Brennstoff-Feuchte (ANNAHME, vereinfachter Ansatz):
   * Gleichgewichtsfeuchte nach Simard (1968) aus Temperatur und rel. Feuchte, plus Regenzuschlag.
   * Rückgabe in Prozent.
   */
  function equilibriumMoisture(tempC, rh) {
    const T = tempC * 9 / 5 + 32;
    const H = Math.max(0, Math.min(100, rh));
    if (H < 10) return 0.03229 + 0.281073 * H - 0.000578 * H * T;
    if (H < 50) return 2.22749 + 0.160107 * H - 0.01478 * T;
    return 21.0606 + 0.005565 * H * H - 0.00035 * H * T - 0.483199 * H;
  }
  function deadMoisture(w, mp) {
    const emc = equilibriumMoisture(w.tempC, w.rh);
    const clamp = (v) => Math.max(mp.min, Math.min(mp.max, v));
    const rainAdd = Math.min(mp.rainMaxAdd, (w.rain24 || 0) * mp.rain24hFactor);
    const d1 = clamp(emc + rainAdd);
    return {
      emc,
      d1,
      d10: clamp(d1 + mp.add10h),
      d100: clamp(d1 + mp.add100h + (w.rain72 || 0) * mp.rain72hFactor100h),
    };
  }

  // Deterministischer Zufallsgenerator (mulberry32)
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

  const OFFSETS = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
  ];

  /**
   * Berechnet je Stunde und Brennstoffklasse die Ausbreitungsraten für alle 16 Richtungen.
   * @returns {rates: Float32Array[hours][classes*16] in m/min (eben),
   *           r0: Float32Array[hours][classes] Grundrate ohne Wind/Hang in m/min,
   *           slopeK: Float32Array[classes] Hangkoeffizient 5.275*beta^-0.3,
   *           info: [{hour, headRos per class}]}
   */
  function precomputeRates(weatherHours, classList, P, pert) {
    const hours = weatherHours.length;
    const nc = classList.length;
    const rates = [];
    const info = [];
    const r0 = [];
    const slopeK = new Float32Array(nc);
    for (let h = 0; h < hours; h++) {
      const w = weatherHours[h];
      const dm = deadMoisture(w, P.moisture);
      const M = {
        d1: Math.max(1, dm.d1 + pert.dMoist) / 100,
        d10: Math.max(1, dm.d10 + pert.dMoist) / 100,
        d100: Math.max(1, dm.d100 + pert.dMoist) / 100,
        lh: P.moisture.liveHerb / 100,
        lw: P.moisture.liveWoody / 100,
      };
      const wind10Kmh = w.windKmh * pert.windFactor;
      const headDeg = (w.windDirDeg + pert.dDir + 180) % 360; // Wind KOMMT aus windDirDeg
      const headRad = (headDeg * Math.PI) / 180;
      const arr = new Float32Array(nc * 16);
      const r0h = new Float32Array(nc);
      const heads = [];
      for (let c = 0; c < nc; c++) {
        const cls = P.fuelClasses[classList[c]];
        if (!cls || !cls.model) { heads.push(0); continue; }
        const fm = P.fuelModels[cls.model];
        const waf = P.waf[cls.waf] ?? 0.4;
        const uMidKmh = wind10Kmh * waf;
        const r = rothermel(fm, M, uMidKmh * FTMIN_PER_KMH, 0, P.tonPerAcreToLbFt2);
        const headMMin = r.R * M_PER_FT;
        r0h[c] = r.R0 * M_PER_FT;
        slopeK[c] = r.slopeK;
        const e = eccentricity(lengthToWidth(uMidKmh / 1.609344));
        heads.push(headMMin);
        for (let k = 0; k < 16; k++) {
          const [di, dj] = OFFSETS[k];
          const bearing = Math.atan2(di, dj); // Kompassrichtung der Bewegung (x Ost, y Nord)
          const cosT = Math.cos(bearing - headRad);
          arr[c * 16 + k] = headMMin > 0 ? (headMMin * (1 - e)) / (1 - e * cosT) : 0;
        }
      }
      rates.push(arr);
      r0.push(r0h);
      info.push({ hour: h, headDeg, moisture: dm, heads });
    }
    return { rates, info, r0, slopeK };
  }

  /**
   * Minimum-Travel-Time auf dem Raster.
   * grid: {nx, ny, cell, fuel: Uint8Array (Index in classList), elev?: Float32Array (m, NaN = fehlt)}
   * ignition: Int32Array der Zündzellen
   * slope (optional): {r0, slopeK, maxTan} aus precomputeRates + PARAMS.dem.maxTanSlope.
   *   Hang je Kante (VEREINFACHTE ANNAHME): tan = Höhendifferenz / Kantenlänge in Laufrichtung.
   *   Bergauf (tan > 0): Rate(Richtung) + R0 * slopeK * min(tan, maxTan)^2, d. h. der Hangzuschlag
   *   nach Rothermel wird zur Wind-Ellipsenrate ADDIERT (keine vektorielle Wind/Hang-Kombination,
   *   Phase 2). Bergab und quer: Grundrate (keine Verlangsamung, konservativ).
   *   Fehlende Höhe (NaN) an einer der beiden Zellen: eben.
   * @returns Float64Array Ankunftszeit in Minuten (Infinity = nicht erreicht)
   */
  function travelTime(grid, classList, rates, ignition, tMaxMin, slope) {
    const { nx, ny, cell, fuel } = grid;
    const elev = slope && grid.elev ? grid.elev : null;
    const sK = elev ? slope.slopeK : null;
    const maxTan = elev ? (slope.maxTan ?? Infinity) : 0;
    const n = nx * ny;
    const arrival = new Float64Array(n).fill(Infinity);
    const burnable = new Uint8Array(classList.length);
    // Klasse brennbar, wenn in Stunde 0 irgendeine Rate > 0 (Modell 0 = nicht brennbar)
    for (let c = 0; c < classList.length; c++) burnable[c] = rates.some((r) => r[c * 16] > 0 || r[c * 16 + 4] > 0) ? 1 : 0;
    const dist = OFFSETS.map(([a, b]) => Math.hypot(a, b) * cell);
    // Binärer Heap mit verzögertem Löschen
    let hIdx = new Int32Array(1024), hKey = new Float64Array(1024), size = 0;
    function push(i, k) {
      if (size >= hIdx.length) {
        const ni = new Int32Array(hIdx.length * 2); ni.set(hIdx); hIdx = ni;
        const nk = new Float64Array(hKey.length * 2); nk.set(hKey); hKey = nk;
      }
      let p = size++;
      while (p > 0) {
        const q = (p - 1) >> 1;
        if (hKey[q] <= k) break;
        hIdx[p] = hIdx[q]; hKey[p] = hKey[q]; p = q;
      }
      hIdx[p] = i; hKey[p] = k;
    }
    function pop() {
      const top = hIdx[0];
      const last = --size;
      const li = hIdx[last], lk = hKey[last];
      let p = 0;
      while (true) {
        let c = 2 * p + 1;
        if (c >= last) break;
        if (c + 1 < last && hKey[c + 1] < hKey[c]) c++;
        if (hKey[c] >= lk) break;
        hIdx[p] = hIdx[c]; hKey[p] = hKey[c]; p = c;
      }
      hIdx[p] = li; hKey[p] = lk;
      return top;
    }
    for (const i of ignition) { arrival[i] = 0; push(i, 0); }
    const hours = rates.length;
    while (size > 0) {
      const t0 = hKey[0];
      const i = pop();
      if (t0 > arrival[i]) continue;
      if (t0 > tMaxMin) break;
      const ci = i % nx, cj = (i - ci) / nx;
      const h = Math.min(hours - 1, Math.floor(t0 / 60));
      const R = rates[h];
      const fs = fuel[i];
      const srcBurn = burnable[fs];
      for (let k = 0; k < 16; k++) {
        const ni = ci + OFFSETS[k][0], nj = cj + OFFSETS[k][1];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nIdx = nj * nx + ni;
        const fd = fuel[nIdx];
        if (!burnable[fd]) continue;
        if (k >= 8) {
          // Springerzug: beide durchquerten Zellen müssen brennbar sein (kein Überspringen von Barrieren)
          const di = OFFSETS[k][0], dj = OFFSETS[k][1];
          let a, b;
          if (Math.abs(di) === 1) { a = (cj + Math.sign(dj)) * nx + ci; b = (cj + Math.sign(dj)) * nx + ni; }
          else { a = cj * nx + ci + Math.sign(di); b = nj * nx + ci + Math.sign(di); }
          if (!burnable[fuel[a]] || !burnable[fuel[b]]) continue;
        } else if (k >= 4) {
          // Diagonale: nicht zwischen zwei nicht brennbaren Zellen hindurch
          const a = cj * nx + ni, b = nj * nx + ci;
          if (!burnable[fuel[a]] && !burnable[fuel[b]]) continue;
        }
        let rd = R[fd * 16 + k];
        let rs = srcBurn ? R[fs * 16 + k] : rd;
        if (rd <= 0 || rs <= 0) continue;
        if (elev) {
          const dz = elev[nIdx] - elev[i]; // NaN, wenn eine Höhe fehlt -> Vergleich falsch -> eben
          if (dz > 0) {
            let tn = dz / dist[k];
            if (tn > maxTan) tn = maxTan;
            const t2 = tn * tn, R0h = slope.r0[h];
            const addD = R0h[fd] * sK[fd] * t2;
            rd += addD;
            rs += srcBurn ? R0h[fs] * sK[fs] * t2 : addD;
          }
        }
        const dt = dist[k] * 0.5 / rs + dist[k] * 0.5 / rd;
        const tn = t0 + dt;
        if (tn < arrival[nIdx]) { arrival[nIdx] = tn; push(nIdx, tn); }
      }
    }
    return arrival;
  }

  // Kompassrichtungen der 16 Nachbarn als Einheitsvektoren (x Ost, y Nord)
  const OFF_BX = OFFSETS.map(([a, b]) => a / Math.hypot(a, b));
  const OFF_BY = OFFSETS.map(([a, b]) => b / Math.hypot(a, b));

  /**
   * Minimum-Travel-Time mit lokalem Wind und lokaler Feuchte je Zelle (Geländewind).
   * field: TerrainWind.makeRunField(...); weatherHours, P, pert wie precomputeRates.
   * Rate von Zelle i in Richtung k: Kopfrate(lokaler Wind, lokale Feuchte) * (1-e)/(1-e*cos(Winkel)),
   * Kopfrate = R0 * (1 + phiW(U)), phiW = C U^B ratio^-E (Rothermel 1972, Windbegrenzung U <= 0,9 I_R),
   * e aus dem lokalen Wind in Flammenhöhe (Anderson 1983). Hangzuschlag wie travelTime() (R0 der Zelle).
   * Da Dijkstra die Zellen in nicht fallender Zeit abarbeitet, wächst die Stunde monoton: lokale Werte
   * werden je Stunde lazy berechnet und beim Stundenwechsel verworfen.
   */
  function travelTimeTerrain(grid, classList, weatherHours, P, pert, field, ignition, tMaxMin, slopeOpt) {
    const { nx, ny, cell, fuel } = grid;
    const n = nx * ny;
    const nc = classList.length;
    const elev = slopeOpt && grid.elev ? grid.elev : null;
    const maxTan = elev ? (slopeOpt.maxTan ?? Infinity) : 0;
    const MP = P.terrain.moisture;
    const bin = MP.binPct || 0.25;
    const nb = Math.ceil((MP.maxDry * 2 + MP.maxWet * 2) / bin) + 3; // Stärke bis 2 abgedeckt
    const off = Math.ceil((MP.maxDry * 2) / bin) + 1;
    const ap = MP.apply || { d1: 1, d10: 1, d100: 0 };
    const cls = classList.map((k) => P.fuelClasses[k]);
    const fms = cls.map((c) => (c && c.model ? P.fuelModels[c.model] : null));
    const wafs = cls.map((c) => (c ? P.waf[c.waf] ?? 0.4 : 0.4));
    const hours = weatherHours.length;
    const dms = weatherHours.map((w) => deadMoisture(w, P.moisture));
    const moistOf = (h, dM) => {
      const dm = dms[h];
      return {
        d1: Math.max(1, dm.d1 + pert.dMoist + dM * ap.d1) / 100,
        d10: Math.max(1, dm.d10 + pert.dMoist + dM * ap.d10) / 100,
        d100: Math.max(1, dm.d100 + pert.dMoist + dM * ap.d100) / 100,
        lh: P.moisture.liveHerb / 100,
        lw: P.moisture.liveWoody / 100,
      };
    };
    // brennbar wie travelTime(): Klasse mit Rate > 0 in Stunde 0 (ohne Geländekorrektur)
    const burnable = new Uint8Array(nc);
    const slopeK = new Float32Array(nc);
    for (let c = 0; c < nc; c++) {
      if (!fms[c]) continue;
      const r = rothermel(fms[c], moistOf(0, 0), 0, 0, P.tonPerAcreToLbFt2);
      burnable[c] = r.R0 > 0 ? 1 : 0;
      slopeK[c] = r.slopeK;
    }
    // Tabelle je Stunde: [c * nb + bin] -> R0 (ft/min), IR, C, B, E, ratio (lazy)
    const tR0 = new Float64Array(nc * nb), tIR = new Float64Array(nc * nb), tK = new Float64Array(nc * nb), tB = new Float64Array(nc * nb);
    const tStamp = new Int32Array(nc * nb).fill(-1);
    // lokale Werte je Zelle für die aktuelle Stunde
    const cHead = new Float32Array(n), cEcc = new Float32Array(n), cUx = new Float32Array(n), cUy = new Float32Array(n), cR0 = new Float32Array(n);
    const stamp = new Int32Array(n).fill(-1);
    let curH = -1;
    function ensure(i) {
      if (stamp[i] === curH) return;
      stamp[i] = curH;
      const c = fuel[i];
      if (!burnable[c]) { cHead[i] = 0; cR0[i] = 0; cEcc[i] = 0; cUx[i] = 0; cUy[i] = 1; return; }
      const o = field.cell(i);
      let b = Math.round(o.dM / bin) + off;
      if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
      const key = c * nb + b;
      if (tStamp[key] !== curH) {
        const r = rothermel(fms[c], moistOf(curH, (b - off) * bin), 0, 0, P.tonPerAcreToLbFt2);
        tR0[key] = r.R0; tIR[key] = r.IR; tK[key] = r.C * Math.pow(r.ratio, -r.E); tB[key] = r.B; tStamp[key] = curH;
      }
      const uMidKmh = o.spd * wafs[c];
      const U = Math.min(Math.max(0, uMidKmh * FTMIN_PER_KMH), 0.9 * tIR[key]);
      const phiW = U > 0 ? tK[key] * Math.pow(U, tB[key]) : 0;
      cR0[i] = tR0[key] * M_PER_FT;
      cHead[i] = tR0[key] * (1 + phiW) * M_PER_FT;
      cEcc[i] = eccentricity(lengthToWidth(uMidKmh / 1.609344));
      cUx[i] = o.ux; cUy[i] = o.uy;
    }
    const rateAt = (i, k) => {
      const hd = cHead[i];
      if (hd <= 0) return 0;
      const e = cEcc[i];
      return (hd * (1 - e)) / (1 - e * (OFF_BX[k] * cUx[i] + OFF_BY[k] * cUy[i]));
    };
    const arrival = new Float64Array(n).fill(Infinity);
    const dist = OFFSETS.map(([a, b]) => Math.hypot(a, b) * cell);
    let hIdx = new Int32Array(1024), hKey = new Float64Array(1024), size = 0;
    function push(i, k) {
      if (size >= hIdx.length) {
        const ni = new Int32Array(hIdx.length * 2); ni.set(hIdx); hIdx = ni;
        const nk = new Float64Array(hKey.length * 2); nk.set(hKey); hKey = nk;
      }
      let p = size++;
      while (p > 0) {
        const q = (p - 1) >> 1;
        if (hKey[q] <= k) break;
        hIdx[p] = hIdx[q]; hKey[p] = hKey[q]; p = q;
      }
      hIdx[p] = i; hKey[p] = k;
    }
    function pop() {
      const top = hIdx[0];
      const last = --size;
      const li = hIdx[last], lk = hKey[last];
      let p = 0;
      while (true) {
        let c = 2 * p + 1;
        if (c >= last) break;
        if (c + 1 < last && hKey[c + 1] < hKey[c]) c++;
        if (hKey[c] >= lk) break;
        hIdx[p] = hIdx[c]; hKey[p] = hKey[c]; p = c;
      }
      hIdx[p] = li; hKey[p] = lk;
      return top;
    }
    for (const i of ignition) { arrival[i] = 0; push(i, 0); }
    while (size > 0) {
      const t0 = hKey[0];
      const i = pop();
      if (t0 > arrival[i]) continue;
      if (t0 > tMaxMin) break;
      const h = Math.min(hours - 1, Math.floor(t0 / 60));
      if (h !== curH) { curH = h; field.setHour(h); }
      const ci = i % nx, cj = (i - ci) / nx;
      const fs = fuel[i];
      const srcBurn = burnable[fs];
      if (srcBurn) ensure(i);
      for (let k = 0; k < 16; k++) {
        const ni = ci + OFFSETS[k][0], nj = cj + OFFSETS[k][1];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nIdx = nj * nx + ni;
        const fd = fuel[nIdx];
        if (!burnable[fd]) continue;
        if (k >= 8) {
          const di = OFFSETS[k][0], dj = OFFSETS[k][1];
          let a, b;
          if (Math.abs(di) === 1) { a = (cj + Math.sign(dj)) * nx + ci; b = (cj + Math.sign(dj)) * nx + ni; }
          else { a = cj * nx + ci + Math.sign(di); b = nj * nx + ci + Math.sign(di); }
          if (!burnable[fuel[a]] || !burnable[fuel[b]]) continue;
        } else if (k >= 4) {
          const a = cj * nx + ni, b = nj * nx + ci;
          if (!burnable[fuel[a]] && !burnable[fuel[b]]) continue;
        }
        ensure(nIdx);
        let rd = rateAt(nIdx, k);
        let rs = srcBurn ? rateAt(i, k) : rd;
        if (rd <= 0 || rs <= 0) continue;
        if (elev) {
          const dz = elev[nIdx] - elev[i];
          if (dz > 0) {
            let tn = dz / dist[k];
            if (tn > maxTan) tn = maxTan;
            const t2 = tn * tn;
            const addD = cR0[nIdx] * slopeK[fd] * t2;
            rd += addD;
            rs += srcBurn ? cR0[i] * slopeK[fs] * t2 : addD;
          }
        }
        const dt = dist[k] * 0.5 / rs + dist[k] * 0.5 / rd;
        const tn = t0 + dt;
        if (tn < arrival[nIdx]) { arrival[nIdx] = tn; push(nIdx, tn); }
      }
    }
    return arrival;
  }

  /** Geländewind-Optionen für runEnsemble (input.terrain: undefined = PARAMS, false = aus, {wind, moisture}). */
  function terrainOptions(input, P) {
    const T = P.terrain;
    if (!T || !input.grid.elev || input.terrain === false || !root.TerrainWind) return null;
    const o = input.terrain && typeof input.terrain === "object" ? input.terrain : {};
    const wind = !!(o.wind ?? T.wind.enabled);
    const moisture = !!(o.moisture ?? T.moisture.enabled);
    if (!wind && !moisture) return null;
    return { wind, moisture };
  }

  /**
   * Ensemble-Rechnung. Schnittstelle des Modells.
   * input: {grid, classList, ignition, weatherHours[{windKmh, windDirDeg, tempC, rh, rain24, rain72}],
   *         horizonsH, P, runs?, seed?}
   * onProgress(doneRuns, totalRuns) wird nach jedem Lauf aufgerufen; Rückgabe ist ein Promise.
   */
  async function runEnsemble(input, onProgress) {
    const { grid, classList, ignition, weatherHours, P } = input;
    const horizons = input.horizonsH || P.horizonsH;
    const tMax = Math.max(...horizons) * 60;
    const E = P.ensemble;
    const runs = input.runs ?? E.runs;
    const rand = rng(input.seed ?? E.seed);
    const n = grid.nx * grid.ny;
    const counts = horizons.map(() => new Uint16Array(n));
    const earliest = new Float32Array(n).fill(Infinity);
    // Ordnungsstatistik je Zelle: die m kleinsten Ankunftszeiten über alle Läufe (aufsteigend).
    // tPossible = Zeit, ab der >= E.possible der Läufe die Zelle erreicht haben (m-te kleinste Zeit),
    // tLikely entsprechend für E.likely. Damit gilt exakt: counts[h]/runs >= Schwelle <=> t <= Horizont.
    const need = (thr) => Math.min(runs, Math.max(1, Math.ceil(thr * runs - 1e-9)));
    const mP = need(E.possible), mL = need(E.likely), mMax = Math.max(mP, mL);
    const ord = new Float32Array(n * mMax).fill(Infinity);
    const t0 = Date.now();

    // Hang nur mit Höhenraster und wenn nicht ausdrücklich abgeschaltet
    const useSlope = !!grid.elev && input.slope !== false;
    const maxTan = P.dem && P.dem.maxTanSlope !== undefined ? P.dem.maxTanSlope : Infinity;
    const slopeOf = (pre) => (useSlope ? { r0: pre.r0, slopeK: pre.slopeK, maxTan } : null);

    // Geländewind (lokaler Wind + Feuchte je Zelle). Aus: unveränderter Pfad (bitgenau wie 0.3.0).
    const tOpt = terrainOptions(input, P);
    const TW = root.TerrainWind;
    const prep = tOpt ? TW.prepare(grid, P) : null;
    const tStr = tOpt ? P.terrain.wind.ensembleStrength : null;
    let terrainHours = null;
    const runOne = (pert, pre) => {
      if (!tOpt) return travelTime(grid, classList, pre.rates, ignition, tMax, slopeOf(pre));
      const field = TW.makeRunField(prep, weatherHours, P, { strength: pert.terrainStrength, dDir: pert.dDir, windFactor: pert.windFactor, wind: tOpt.wind, moisture: tOpt.moisture, lat: grid.proj ? grid.proj.lat0 : NaN, lon: grid.proj ? grid.proj.lon0 : NaN });
      const arr = travelTimeTerrain(grid, classList, weatherHours, P, pert, field, ignition, tMax, useSlope ? { maxTan } : null);
      if (!terrainHours) terrainHours = field.hourInfo.filter(Boolean);
      return arr;
    };

    // Referenzlauf (unveränderte Eingangswerte)
    const refPert = { dDir: 0, windFactor: 1, dMoist: 0 };
    if (tOpt) refPert.terrainStrength = 1;
    const refPre = precomputeRates(weatherHours, classList, P, refPert);
    const reference = runOne(refPert, refPre);
    const perturbations = [];
    for (let r = 0; r < runs; r++) {
      const pert = {
        dDir: (rand() * 2 - 1) * E.windDirDeg,
        windFactor: E.windSpeedFactor[0] + rand() * (E.windSpeedFactor[1] - E.windSpeedFactor[0]),
        dMoist: (rand() * 2 - 1) * E.deadMoistureAbs,
      };
      // Stärke der Geländekorrektur nur ziehen, wenn aktiv (sonst bleibt die Zufallsfolge wie 0.3.0)
      if (tOpt) pert.terrainStrength = tStr[0] + rand() * (tStr[1] - tStr[0]);
      perturbations.push(pert);
      const pre = precomputeRates(weatherHours, classList, P, pert);
      const arr = runOne(pert, pre);
      for (let i = 0; i < n; i++) {
        const a = arr[i];
        if (a === Infinity) continue;
        if (a < earliest[i]) earliest[i] = a;
        for (let h = 0; h < horizons.length; h++) if (a <= horizons[h] * 60) counts[h][i]++;
        const base = i * mMax;
        if (a < ord[base + mMax - 1]) {
          let q = base + mMax - 1;
          while (q > base && ord[q - 1] > a) { ord[q] = ord[q - 1]; q--; }
          ord[q] = a;
        }
      }
      if (onProgress) await onProgress(r + 1, runs);
    }
    const tPossible = new Float32Array(n), tLikely = new Float32Array(n);
    for (let i = 0; i < n; i++) { tPossible[i] = ord[i * mMax + mP - 1]; tLikely[i] = ord[i * mMax + mL - 1]; }
    return {
      horizons, runs, counts, earliest, reference, perturbations, tPossible, tLikely, quantileRuns: { possible: mP, likely: mL },
      refInfo: refPre.info, durationMs: Date.now() - t0, slopeUsed: useSlope, maxTanSlope: useSlope ? maxTan : null,
      terrainWind: tOpt ? {
        active: true, wind: tOpt.wind, moisture: tOpt.moisture, strengthRange: tStr.slice(), prepMs: prep.prepMs,
        hours: terrainHours, thermalHours: (terrainHours || []).filter((x) => x.thermal).length,
        timeKnown: weatherHours.every((w) => Number.isFinite(w.t)),
      } : { active: false, reason: !grid.elev ? "kein Geländemodell" : input.terrain === false ? "ausgeschaltet" : "ausgeschaltet (Parameter)" },
    };
  }

  /** Kennzahlen aus dem Ensemble-Ergebnis. */
  function metrics(result, grid, ignition, P) {
    const cellArea = grid.cell * grid.cell;
    const { horizons, counts, runs, reference } = result;
    const ign = new Set(ignition);
    const initialHa = (ignition.length * cellArea) / 1e4;
    const perH = horizons.map((H, h) => {
      let ref = 0, likely = 0, possible = 0;
      for (let i = 0; i < reference.length; i++) {
        if (reference[i] <= H * 60) ref++;
        const p = counts[h][i] / runs;
        if (p >= P.ensemble.likely) likely++;
        if (p >= P.ensemble.possible) possible++;
      }
      return { H, refHa: (ref * cellArea) / 1e4, likelyHa: (likely * cellArea) / 1e4, possibleHa: (possible * cellArea) / 1e4 };
    });
    // Hauptausbreitungsrichtung: Schwerpunkt Zündfläche -> Schwerpunkt Referenzfläche am letzten Horizont
    const Hmax = horizons[horizons.length - 1] * 60;
    let sx = 0, sy = 0, s = 0, ix = 0, iy = 0;
    for (let i = 0; i < reference.length; i++) {
      if (reference[i] <= Hmax && !ign.has(i)) {
        sx += i % grid.nx; sy += Math.floor(i / grid.nx); s++;
      }
    }
    for (const i of ignition) { ix += i % grid.nx; iy += Math.floor(i / grid.nx); }
    ix /= ignition.length || 1; iy /= ignition.length || 1;
    let dirDeg = null;
    if (s > 0) {
      const dx = sx / s - ix, dy = sy / s - iy;
      if (Math.hypot(dx, dy) > 0.3) dirDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    }
    // Spitzen-Ausbreitungsrate (Kopffeuer) über alle Stunden und vorkommenden Brennstoffklassen
    const present = new Set();
    for (let i = 0; i < reference.length; i++) if (reference[i] <= Hmax) present.add(grid.fuel[i]);
    let peak = 0;
    for (const inf of result.refInfo) for (const c of present) peak = Math.max(peak, inf.heads[c] || 0);
    return { initialHa, perH, mainDirDeg: dirDeg, peakRosMMin: peak };
  }

  /** Früheste Erreichzeit einer Objektmaske (Nachbarzellen eingeschlossen). */
  function reachTime(mask, arrival, grid) {
    const { nx, ny } = grid;
    let best = Infinity;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const ci = i % nx, cj = (i - ci) / nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = ci + di, b = cj + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const t = arrival[b * nx + a];
        if (t < best) best = t;
      }
    }
    return best;
  }

  const FireModel = {
    rothermel, lengthToWidth, eccentricity, equilibriumMoisture, deadMoisture,
    precomputeRates, travelTime, travelTimeTerrain, terrainOptions, runEnsemble, metrics, reachTime, rng, OFFSETS,
  };
  root.FireModel = FireModel;
  if (typeof module !== "undefined" && module.exports) module.exports = FireModel;
})(typeof globalThis !== "undefined" ? globalThis : this);
