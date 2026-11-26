/*
 * Safe Areas (Rückzugsflächen) und Fluchtwege – Berechnungskern, ohne DOM.
 *
 * Zweck: Zu jeder Lage dauerhaft Rückzugsflächen einplanen, je eingesetztem Fahrzeug einen
 * Fluchtweg dorthin mit geschätzter Zeit angeben und warnen, wenn die Fluchtzeit plus
 * Sicherheitspuffer größer ist als die Zeit, bis die „möglich“-Front den Standort erreichen kann.
 *
 * FACHLICHE GRUNDLAGE (Belege siehe ASSUMPTIONS.md; alles andere ist ausdrücklich Annahme):
 *  - Butler & Cohen (1998), Int. J. Wildland Fire 7(2):73–77 (doi:10.1071/WF9980073):
 *    Strahlungsmodell, Grenzwert 7,0 kW/m² (Verbrennung 2. Grades an unbedeckter Haut in < 90 s);
 *    Faustregel Radius der Sicherheitsfläche >= 4 x maximale Flammenhöhe; die meisten Flächen
 *    müssen breiter als 20 m sein. Gilt für EBENES Gelände ohne Wind.
 *  - Butler (2014), Int. J. Wildland Fire 23(3):295–308 (doi:10.1071/WF13021): Überblick,
 *    Forschungsbedarf; daraus abgeleitete, vom Autor selbst als VORLÄUFIG bezeichnete Regel
 *    SSD = 8 * Δ * H_Vegetation mit einem Hang-/Wind-Faktor Δ aus einer Tabelle (Δ zwischen 1 und
 *    10; Butler hält 1 bis 5 für wahrscheinlicher). Die Tabelle selbst lag hier NICHT vor.
 *  - Page & Butler (2017), Int. J. Wildland Fire 26:655–667 (doi:10.1071/WF16213): empirisch aus
 *    Entrapments; ohne Feuerschutzzelt und bei Hang < 25 % rund 20–50 m bei Flammen unter 10 m,
 *    darüber das 1- bis 4-fache der Flammenhöhe (Timber/Brush/Grass).
 *  - Byram (1959), metrische Form nach Alexander (1982): Flammenlänge L[m] = 0,0775 * I[kW/m]^0,46.
 *  - Tobler (1993) Hiking Function: v = 6 * exp(-3,5 * |s + 0,05|) km/h, abseits der Wege * 3/5.
 *  - LACES (Lookout, Anchor point, Communication, Escape route, Safety zone) ist in Deutschland
 *    die eingeführte Sicherheitsregel (ersetzte „FRAU“). Sicherheitsbereich: bekanntgeben, frei von
 *    Brandlast, keine Gefährdungen, Sammelplatz beim Rückzug. Eine ZAHLENMÄSSIGE Mindestgröße ist
 *    in den eingesehenen deutschen Regelwerken NICHT genannt (zu prüfen).
 *
 * WICHTIG: Dieses Modul erfindet keine Flächen. Ohne Landnutzungsdaten (OSM) werden nur Flächen
 * gemeldet, die sich aus den Eingaben der Einsatzleitung selbst ergeben (bereits abgebrannte
 * Fläche), zusammen mit einem deutlichen Hinweis.
 */
(function (root) {
  const G = root.Grid;
  const FTMIN_PER_KMH = 54.6807; // 1 km/h = 54,6807 ft/min (wie js/model.js)
  const M_PER_FT = 0.3048;
  const BTU_FT_S_TO_KW_M = 3.46414; // 1 Btu/(ft·s) = 3,46414 kW/m

  // ------------------------------------------------------------------ Parameter (Vorschlag für PARAMS.safearea)
  const DEFAULTS = {
    // --- Flammenlänge aus dem Rothermel-Kern (js/model.js) ---
    // Abbrandzeit der Flammenfront t_res = residenceTimeConst / sigma (min), sigma = charakteristische
    // Oberfläche/Volumen in 1/ft. Üblicherweise Anderson (1969) zugeschrieben – PRIMÄRQUELLE NICHT
    // GEPRÜFT (Host gesperrt), deshalb „zu prüfen“.
    residenceTimeConst: 384,
    byramA: 0.0775, byramB: 0.46, // Byram (1959), metrisch nach Alexander (1982)

    // --- Sicherheitsabstand (Safe Separation Distance) ---
    ssdFlameFactor: 4,  // Butler & Cohen (1998)
    minSsdM: 10,        // Butler & Cohen (1998): Flächen müssen breiter als 20 m sein -> Radius 10 m
    // Hang-/Windzuschlag Δ. ANNAHME: Δ = Δ_Hang * Δ_Wind, linear interpoliert über zwei Stützstellen
    // aus der USFS-Zusammenfassung zu Butlers Regel (20 % Hang + 10 mph Wind -> Δ = 4; über 40 % Hang
    // 6- bis 10-fach). Die Originaltabelle lag nicht vor (siehe ASSUMPTIONS.md).
    deltaSlopePerTan: 7.5,   // Δ_Hang = 1 + 7,5 * Steigung(tan)
    deltaWindPerRef: 0.6,    // Δ_Wind = 1 + 0,6 * (Wind / windRefKmh)
    windRefKmh: 16.09344,    // 10 mph
    deltaMax: 10,            // NWCG: Δ zwischen 1 und 10
    // Zuschlag für Personal und Fahrzeuge auf dem Radius (USFS-Zusammenfassung 2019:
    // 10 ft je 20 Einsatzkräfte, 5 ft je Fahrzeug)
    addPer20PersonsM: 3.048,
    addPerVehicleM: 1.524,
    defaultPersons: 9,       // ANNAHME: Gruppe (1/8) je Fahrzeug
    defaultVehicles: 1,
    conditionalFactor: 0.7,  // ANNAHME: ab 70 % des Soll-Radius „bedingt geeignet“

    // --- Kandidatensuche ---
    minAreaCells: 4,         // ANNAHME: kleiner als 4 Zellen (2500 m²) gar nicht erst prüfen
    maxAreas: 12,            // ANNAHME: Anzeigegrenze
    maxAreaDistM: 3000,      // ANNAHME: nur Flächen bis 3 km um den Brandschwerpunkt vorschlagen
    blackAfterMin: 30,       // ANNAHME: abgebrannte Fläche erst nach 30 min Abkühlung als Rückzugsfläche
    edgeShareMin: 0.05,      // ANNAHME: Randbrennstoffklasse zählt ab 5 % des Umfangs

    // --- Fluchtwege ---
    roadKmh: 40,             // ANNAHME (kein Beleg): Löschfahrzeug auf befestigter Straße im Einsatz
    trackKmh: 20,            // ANNAHME (kein Beleg): Löschfahrzeug auf Wirtschafts-/Waldweg
    slopeSlowK: 4,           // ANNAHME: v = v0 / (1 + k * Steigung bergauf)
    footOffPath: 0.6,        // Tobler (1993): abseits der Wege Faktor 3/5
    reactionMin: 2,          // ANNAHME: Erkennen, Rückzugsbefehl, Aufsitzen
    maxRouteMin: 60,         // ANNAHME: längere Fluchtwege nicht mehr sinnvoll

    // --- Warnung ---
    bufferMin: 15,           // ANNAHME: Sicherheitspuffer auf die Fluchtzeit
    warnReserveMin: 10,      // ANNAHME: unter 10 min Reserve = „knapp“
  };

  /** Kandidatentypen: Brandlast auf der Fläche entscheidet über die erreichbare Höchstbewertung. */
  const TYPES = {
    gewaesser:  { label: "Gewässer",            brandlast: false, befahrbar: false, osm: "natural=water / landuse=reservoir|basin" },
    abgebrannt: { label: "Abgebrannte Fläche",  brandlast: false, befahrbar: true,  osm: "aus der Lage (Brandfläche)" },
    steinbruch: { label: "Steinbruch / Abbau",  brandlast: false, befahrbar: true,  osm: "landuse=quarry" },
    parkplatz:  { label: "Parkplatz",           brandlast: false, befahrbar: true,  osm: "amenity=parking" },
    sportplatz: { label: "Sportfläche",         brandlast: false, befahrbar: true,  osm: "leisure=pitch|track|sports_centre" },
    hoffläche:  { label: "Hof-/Betriebsfläche", brandlast: false, befahrbar: true,  osm: "landuse=farmyard" },
    acker:      { label: "Acker",               brandlast: true,  befahrbar: true,  osm: "landuse=farmland" },
    gruenland:  { label: "Grünland / Wiese",    brandlast: true,  befahrbar: true,  osm: "landuse=meadow|grass / natural=grassland" },
  };

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const r1 = (v) => Math.round(v * 10) / 10;
  function fmtMin(m) {
    if (!isFinite(m)) return "nicht im Prognosehorizont";
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return h > 0 ? `${h} h ${String(mm).padStart(2, "0")} min` : `${mm} min`;
  }
  const de = (v, d = 1) => Number(v).toFixed(d).replace(".", ",");

  function params(P) {
    return Object.assign({}, DEFAULTS, (P && P.safearea) || {});
  }

  // ------------------------------------------------------------------ Flammenlänge
  /**
   * Charakteristische Oberfläche/Volumen sigma (1/ft) aus dem Rückgabewert von FireModel.rothermel().
   * rothermel() liefert B = 0,02526 * sigma^0,54 (Rothermel 1972); die Umkehrung ist exakt und
   * erspart eine zweite Implementierung der Flächenanteilsgewichtung.
   */
  function sigmaFromRothermel(r) {
    if (!r || !(r.B > 0)) return 0;
    return Math.pow(r.B / 0.02526, 1 / 0.54);
  }

  /**
   * Byram-Flammenlänge aus einem Rothermel-Ergebnis.
   * I = (IR * t_res) * R / 60  [Btu/(ft·s)],  L = a * (I * 3,46414)^b  [m]
   * @returns {sigma, tResMin, hpaBtuFt2, intensityKwM, flameM}
   */
  function flameFromRothermel(r, sp) {
    // sp darf PARAMS (mit .safearea) oder bereits der flache Parametersatz sein
    const cfg = sp && sp.residenceTimeConst !== undefined ? sp : params(sp);
    const sigma = sigmaFromRothermel(r);
    if (!(sigma > 0) || !(r.IR > 0) || !(r.R > 0)) {
      return { sigma, tResMin: 0, hpaBtuFt2: 0, intensityKwM: 0, flameM: 0 };
    }
    const tResMin = cfg.residenceTimeConst / sigma;
    const hpa = r.IR * tResMin;                       // Btu/ft²
    const iBtu = (hpa * r.R) / 60;                    // Btu/(ft·s), R in ft/min
    const iKw = iBtu * BTU_FT_S_TO_KW_M;              // kW/m
    const flameM = cfg.byramA * Math.pow(iKw, cfg.byramB);
    return { sigma, tResMin, hpaBtuFt2: hpa, intensityKwM: iKw, flameM };
  }

  /**
   * Flammenlänge einer Brennstoffklasse über alle Wetterstunden (ungünstigste Stunde).
   * Hang bleibt 0: der Hang geht über den Zuschlag Δ in den Sicherheitsabstand ein (sonst doppelt).
   * @returns {flameM, windKmh, hour, intensityKwM, rosMMin} oder null (nicht brennbar)
   */
  function flameForClass(classKey, weatherHours, P) {
    const FM = root.FireModel;
    const cls = P.fuelClasses[classKey];
    if (!FM || !cls || !cls.model) return null;
    const fm = P.fuelModels[cls.model];
    const waf = P.waf[cls.waf] ?? 0.4;
    let best = null;
    for (let h = 0; h < weatherHours.length; h++) {
      const w = weatherHours[h];
      const dm = FM.deadMoisture(w, P.moisture);
      const M = {
        d1: Math.max(1, dm.d1) / 100, d10: Math.max(1, dm.d10) / 100, d100: Math.max(1, dm.d100) / 100,
        lh: P.moisture.liveHerb / 100, lw: P.moisture.liveWoody / 100,
      };
      const r = FM.rothermel(fm, M, w.windKmh * waf * FTMIN_PER_KMH, 0, P.tonPerAcreToLbFt2);
      const f = flameFromRothermel(r, params(P));
      if (!best || f.flameM > best.flameM) {
        best = { flameM: f.flameM, windKmh: w.windKmh, hour: h, intensityKwM: f.intensityKwM, rosMMin: r.R * M_PER_FT };
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ Sicherheitsabstand
  /** Hang-/Windfaktor Δ (ANNAHME, Stützstellen siehe ASSUMPTIONS.md). */
  function deltaFactor(slopeTan, windKmh, sp) {
    const s = params(sp);
    const up = Math.max(0, Number.isFinite(slopeTan) ? slopeTan : 0);
    const u = Math.max(0, Number.isFinite(windKmh) ? windKmh : 0);
    const dSlope = 1 + s.deltaSlopePerTan * up;
    const dWind = 1 + s.deltaWindPerRef * (u / s.windRefKmh);
    return { deltaSlope: dSlope, deltaWind: dWind, delta: clamp(dSlope * dWind, 1, s.deltaMax) };
  }

  /**
   * Erforderlicher Radius der Rückzugsfläche.
   * SSD = max(minSsdM, ssdFlameFactor * Flammenlänge * Δ), dazu Zuschlag für Personal und Fahrzeuge.
   */
  function requiredRadius(flameM, slopeTan, windKmh, opt = {}, sp) {
    const s = params(sp);
    const d = deltaFactor(slopeTan, windKmh, sp);
    const base = s.ssdFlameFactor * Math.max(0, flameM) * d.delta;
    const ssdM = Math.max(s.minSsdM, base);
    const persons = opt.persons ?? s.defaultPersons;
    const vehicles = opt.vehicles ?? s.defaultVehicles;
    const addM = s.addPer20PersonsM * (persons / 20) + s.addPerVehicleM * vehicles;
    return {
      ...d, flameM, ssdM, addM, radiusM: ssdM + addM, persons, vehicles,
      limitedByMin: base < s.minSsdM,
    };
  }

  // ------------------------------------------------------------------ Hilfsfunktionen Raster
  /** Steigung (tan) zwischen zwei Zellen, positiv = von a nach b bergauf. NaN-sicher. */
  function slopeBetween(grid, a, b) {
    if (!grid.elev) return 0;
    const za = grid.elev[a], zb = grid.elev[b];
    if (!Number.isFinite(za) || !Number.isFinite(zb)) return 0;
    const ai = a % grid.nx, aj = (a - ai) / grid.nx;
    const bi = b % grid.nx, bj = (b - bi) / grid.nx;
    const len = Math.hypot(bi - ai, bj - aj) * grid.cell;
    return len > 0 ? (zb - za) / len : 0;
  }

  /** Zusammenhangskomponenten (4er-Nachbarschaft) über eine Zellklassifizierung code[i] (0 = keine). */
  function components(grid, code, minCells) {
    const n = grid.nx * grid.ny, seen = new Uint8Array(n), out = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (seen[start] || !code[start]) continue;
      const c = code[start];
      let sp = 0; stack[sp++] = start; seen[start] = 1;
      const cells = [];
      while (sp > 0) {
        const k = stack[--sp];
        cells.push(k);
        const i = k % grid.nx, j = (k - i) / grid.nx;
        if (i > 0 && !seen[k - 1] && code[k - 1] === c) { seen[k - 1] = 1; stack[sp++] = k - 1; }
        if (i < grid.nx - 1 && !seen[k + 1] && code[k + 1] === c) { seen[k + 1] = 1; stack[sp++] = k + 1; }
        if (j > 0 && !seen[k - grid.nx] && code[k - grid.nx] === c) { seen[k - grid.nx] = 1; stack[sp++] = k - grid.nx; }
        if (j < grid.ny - 1 && !seen[k + grid.nx] && code[k + grid.nx] === c) { seen[k + grid.nx] = 1; stack[sp++] = k + grid.nx; }
      }
      if (cells.length >= minCells) out.push({ code: c, cells: Int32Array.from(cells.sort((a, b) => a - b)) });
    }
    return out;
  }

  /**
   * Abstand jeder Zelle der Menge zum Flächenrand (Chamfer-Distanz) im Umgriff der Fläche.
   * @returns {d, i0, j0, w, h, radiusM, centerIdx, freeAt(k)}
   */
  function distanceInside(grid, cells) {
    let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    for (const k of cells) {
      const i = k % grid.nx, j = (k - i) / grid.nx;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
    }
    i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1);
    i1 = Math.min(grid.nx - 1, i1 + 1); j1 = Math.min(grid.ny - 1, j1 + 1);
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    const INF = 1e9, a = grid.cell, b = grid.cell * Math.SQRT2;
    const d = new Float32Array(w * h).fill(0);
    const inSet = new Uint8Array(w * h);
    for (const k of cells) {
      const i = k % grid.nx, j = (k - i) / grid.nx;
      inSet[(j - j0) * w + (i - i0)] = 1;
    }
    for (let q = 0; q < d.length; q++) d[q] = inSet[q] ? INF : 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i; let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) {
        v = Math.min(v, d[k - w] + a);
        if (i > 0) v = Math.min(v, d[k - w - 1] + b);
        if (i < w - 1) v = Math.min(v, d[k - w + 1] + b);
      }
      d[k] = v;
    }
    let bestV = -1, bestIdx = cells[0];
    for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i; let v = d[k];
      if (i < w - 1) v = Math.min(v, d[k + 1] + a);
      if (j < h - 1) {
        v = Math.min(v, d[k + w] + a);
        if (i < w - 1) v = Math.min(v, d[k + w + 1] + b);
        if (i > 0) v = Math.min(v, d[k + w - 1] + b);
      }
      d[k] = v;
      if (inSet[k] && v > bestV) { bestV = v; bestIdx = (j + j0) * grid.nx + (i + i0); }
    }
    // Chamfer-Distanz misst bis zum Mittelpunkt der nächsten Außenzelle; der freie Radius ab
    // Zellmitte ist um eine halbe Zellbreite kleiner (konservativ).
    const half = grid.cell / 2;
    const freeAt = (k) => {
      const i = k % grid.nx, j = (k - i) / grid.nx;
      if (i < i0 || j < j0 || i > i1 || j > j1) return 0;
      return Math.max(0, d[(j - j0) * w + (i - i0)] - half);
    };
    return { d, i0, j0, w, h, freeAt, radiusM: Math.max(0, bestV - half), centerIdx: bestIdx };
  }

  /** Größter einbeschriebener Kreis (Kurzform von distanceInside). */
  function inscribedCircle(grid, cells) {
    const r = distanceInside(grid, cells);
    return { radiusM: r.radiusM, centerIdx: r.centerIdx };
  }

  /** Außenanlieger (4er) einer Zellmenge mit Anteil je Brennstoffklasse. */
  function edgeClasses(grid, cells, classList) {
    const set = new Set(cells);
    const count = new Map();
    let total = 0;
    for (const k of cells) {
      const i = k % grid.nx, j = (k - i) / grid.nx;
      const nb = [];
      if (i > 0) nb.push(k - 1);
      if (i < grid.nx - 1) nb.push(k + 1);
      if (j > 0) nb.push(k - grid.nx);
      if (j < grid.ny - 1) nb.push(k + grid.nx);
      for (const q of nb) {
        if (set.has(q)) continue;
        const c = classList[grid.fuel[q]];
        count.set(c, (count.get(c) || 0) + 1);
        total++;
      }
    }
    const out = [...count.entries()].map(([cls, n]) => ({ cls, n, share: total ? n / total : 0 }));
    out.sort((a, b) => b.n - a.n || (a.cls < b.cls ? -1 : 1));
    return { list: out, total };
  }

  /**
   * Steigung (tan) von der Brandseite zur Fläche: > 0 = Fläche liegt OBERHALB des Brandes
   * (das Feuer läuft bergauf auf die Fläche zu, deshalb gefährlicher).
   * @param anchorIdx Bezugszelle der Fläche (Mittelpunkt des einbeschriebenen Kreises)
   */
  function slopeToFire(grid, anchorIdx, fireXY) {
    if (!grid.elev) return { tan: 0, known: false };
    const cz = grid.elev[anchorIdx];
    if (!Number.isFinite(cz)) return { tan: 0, known: false };
    const [cx, cy] = G.cellCenter(grid, anchorIdx);
    const dx = fireXY[0] - cx, dy = fireXY[1] - cy;
    const dist = Math.hypot(dx, dy);
    if (!(dist > grid.cell)) return { tan: 0, known: false };
    // Höhe auf halbem Weg zum Brand als Bezug (robuster als nur der Brandschwerpunkt)
    const mk = G.cellOf(grid, cx + dx * 0.5, cy + dy * 0.5);
    const zf = mk >= 0 && Number.isFinite(grid.elev[mk]) ? grid.elev[mk] : NaN;
    if (!Number.isFinite(zf)) return { tan: 0, known: false };
    return { tan: (cz - zf) / (dist * 0.5), known: true, deltaZ: cz - zf, distM: dist * 0.5 };
  }

  // ------------------------------------------------------------------ Kandidatensuche und Bewertung
  /**
   * Findet und bewertet Rückzugsflächen.
   * @param inp {grid, result, osm, ignition, weatherHours, P, state?, extra?}
   *   osm: Ergebnis von Osm.applyOsm (oder null). extra: optionales Uint8Array mit Zusatztypen
   *        (siehe SafeArea.rasterExtra) für Parkplätze/Steinbrüche/Sportflächen/Hofflächen.
   */
  function findAreas(inp) {
    const { grid, result, P } = inp;
    const s = params(P);
    const classList = grid.classList;
    const notes = [];
    const n = grid.nx * grid.ny;
    const osm = inp.osm || null;
    const ignition = inp.ignition || [];
    const weatherHours = inp.weatherHours || [];
    const dismissed = new Set(inp.state && inp.state.dismissed ? inp.state.dismissed : []);

    // 1) Zellklassifizierung -> Kandidatencode
    const TYPE_KEYS = Object.keys(TYPES);
    const codeOf = (t) => TYPE_KEYS.indexOf(t) + 1;
    const code = new Uint8Array(n);
    const extra = inp.extra || (osm && osm.safeAreaExtra) || null;
    if (osm) {
      for (let i = 0; i < n; i++) {
        const c = classList[grid.fuel[i]];
        if (c === "wasser") code[i] = codeOf("gewaesser");
        else if (c === "acker") code[i] = codeOf("acker");
        else if (c === "gruenland") code[i] = codeOf("gruenland");
      }
    }
    if (extra) {
      // extra[i] = 1..4 für steinbruch/parkplatz/sportplatz/hoffläche (hat Vorrang: keine Brandlast)
      const map = { 1: "steinbruch", 2: "parkplatz", 3: "sportplatz", 4: "hoffläche" };
      for (let i = 0; i < n; i++) if (extra[i] && map[extra[i]]) code[i] = codeOf(map[extra[i]]);
    }
    // Zellen mit Brandlast (Acker/Grünland), die die „möglich“-Zone im Prognosehorizont erreicht,
    // sind KEINE Rückzugsfläche: über sie läuft das Feuer hinweg.
    const tPmask = result && result.tPossible ? result.tPossible : null;
    const tMaxH = result && result.horizons ? Math.max(...result.horizons) * 60 : Infinity;
    if (tPmask) {
      const fuelCodes = new Set(TYPE_KEYS.filter((t) => TYPES[t].brandlast).map(codeOf));
      for (let i = 0; i < n; i++) if (code[i] && fuelCodes.has(code[i]) && tPmask[i] <= tMaxH) code[i] = 0;
    }
    // bereits abgebrannte Fläche: die von der Einsatzleitung gezeichnete Brandfläche (Ankunftszeit
    // liegt in der Vergangenheit). ANNAHME: erst nach blackAfterMin als Rückzugsfläche brauchbar.
    const blackCode = codeOf("abgebrannt");
    for (const i of ignition) code[i] = blackCode;

    if (!osm) {
      notes.push("Keine OSM-Daten geladen: Landnutzung (Acker, Wiese, Parkplatz, Steinbruch, Gewässer, Sportfläche) ist unbekannt. " +
        "Es werden KEINE Flächen erfunden. Vorgeschlagen wird nur, was sich aus Ihren eigenen Eingaben ergibt (bereits abgebrannte Fläche). " +
        "Rückzugsflächen bitte vor Ort erkunden und über LACES festlegen.");
    }
    if (osm && !extra) {
      notes.push("Parkplätze, Steinbrüche, Sportflächen und Hofflächen sind in der Overpass-Abfrage der App (js/osm.js) nicht enthalten und fehlen deshalb als Kandidaten. " +
        "Erweiterung der Abfrage siehe INTEGRATION.md.");
    }

    // 2) Komponenten
    const comps = components(grid, code, s.minAreaCells);

    // 3) Brandbezug
    const tP = result && result.tPossible ? result.tPossible : null;
    const earliest = result && result.earliest ? result.earliest : null;
    let fx = 0, fy = 0;
    for (const i of ignition) { const [x, y] = G.cellCenter(grid, i); fx += x; fy += y; }
    if (ignition.length) { fx /= ignition.length; fy /= ignition.length; }
    const fireXY = [fx, fy];

    // Flammenlänge je Brennstoffklasse (Cache)
    const flameCache = new Map();
    const flameOf = (cls) => {
      if (!flameCache.has(cls)) flameCache.set(cls, weatherHours.length ? flameForClass(cls, weatherHours, P) : null);
      return flameCache.get(cls);
    };
    const maxWind = weatherHours.reduce((m, w) => Math.max(m, w.windKmh || 0), 0);

    const areas = [];
    let skippedFar = 0;
    for (const comp of comps) {
      const type = TYPE_KEYS[comp.code - 1];
      const def = TYPES[type];
      const cells = comp.cells;
      const areaHa = (cells.length * grid.cell * grid.cell) / 1e4;
      const ins = distanceInside(grid, cells);
      const edge = edgeClasses(grid, cells, classList);

      // Abstand zum Brandschwerpunkt: weit entfernte Flächen sind operativ nicht relevant
      let distFire = Infinity;
      for (const k of cells) {
        const [x, y] = G.cellCenter(grid, k);
        const d = Math.hypot(x - fireXY[0], y - fireXY[1]);
        if (d < distFire) distFire = d;
      }
      if (distFire > s.maxAreaDistM) { skippedFar++; continue; }

      // Randbrennstoff: ungünstigste Klasse mit nennenswertem Anteil am Umfang (konservativ).
      // Bei Flächen mit eigener Brandlast (Acker/Grünland) zählt auch die eigene Klasse mit,
      // weil ein nicht abgeerntetes Feld selbst brennt.
      const cand = edge.list.filter((e) => e.share >= s.edgeShareMin).map((e) => e.cls);
      if (def.brandlast) cand.push(type === "acker" ? "acker" : "gruenland");
      let worst = null;
      for (const cls of cand) {
        const f = flameOf(cls);
        if (!f) continue;
        if (!worst || f.flameM > worst.f.flameM) worst = { cls, f };
      }
      const flameM = worst ? worst.f.flameM : 0;
      const sl = slopeToFire(grid, ins.centerIdx, fireXY);
      const req = requiredRadius(flameM, sl.tan, maxWind, {}, P);
      // Kernbereich: Zellen mit ausreichendem Abstand zum Flächenrand (Ziel der Fluchtwege)
      const coreCells = [];
      for (const k of cells) if (ins.freeAt(k) >= req.radiusM) coreCells.push(k);

      // Erreichbarkeit: befahrbare Zelle in oder direkt an der Fläche
      let drv = 0;
      if (osm && osm.drivable) {
        for (const k of cells) {
          const i = k % grid.nx, j = (k - i) / grid.nx;
          for (const q of [k, i > 0 ? k - 1 : -1, i < grid.nx - 1 ? k + 1 : -1, j > 0 ? k - grid.nx : -1, j < grid.ny - 1 ? k + grid.nx : -1]) {
            if (q >= 0 && osm.drivable[q]) drv = Math.max(drv, osm.drivable[q] === 1 ? 2 : 1);
          }
          if (drv === 2) break;
        }
      }

      // Zeitbezug: wann kann die „möglich“-Front die Fläche erreichen
      let arrivalMin = Infinity, earliestMin = Infinity;
      if (tP) for (const k of cells) if (tP[k] < arrivalMin) arrivalMin = tP[k];
      if (earliest) for (const k of cells) if (earliest[k] < earliestMin) earliestMin = earliest[k];

      // Bewertung
      const hinweise = [];
      let status = ins.radiusM >= req.radiusM ? "geeignet"
        : ins.radiusM >= req.radiusM * s.conditionalFactor ? "bedingt" : "ungeeignet";
      let grund;
      const sizeTxt = `freier Radius ca. ${Math.round(ins.radiusM)} m, erforderlich ca. ${Math.round(req.radiusM)} m ` +
        `(${s.ssdFlameFactor} × Flammenlänge ${de(flameM, 1)} m × Hang-/Windfaktor ${de(req.delta, 1)} + ${de(req.addM, 1)} m für Personal/Fahrzeug)`;

      if (status === "ungeeignet") {
        grund = `Zu klein: ${sizeTxt}.`;
      } else if (def.brandlast) {
        // Acker/Grünland tragen selbst Brennstoff -> nie besser als „bedingt geeignet“
        if (status === "geeignet") status = "bedingt";
        grund = `${def.label} ist groß genug (${sizeTxt}), trägt aber selbst Vegetation: nur brauchbar, wenn abgeerntet bzw. kurz und grün – vor Ort prüfen.`;
        hinweise.push("OSM kennt keinen Erntezustand; Brandlast auf der Fläche ist nicht geprüft.");
      } else if (type === "gewaesser") {
        if (status === "geeignet") status = "bedingt";
        grund = `Gewässer ohne Brandlast (${sizeTxt}), aber nicht befahrbar: nur als Rückzugsraum für Personal, Fahrzeuge brauchen eine andere Fläche.`;
      } else if (type === "abgebrannt") {
        grund = status === "geeignet"
          ? `Bereits abgebrannte Fläche ohne verbleibende Brandlast (${sizeTxt}).`
          : `Bereits abgebrannte Fläche, aber knapp bemessen: ${sizeTxt}.`;
        hinweise.push(`ANNAHME: erst ab ${s.blackAfterMin} min nach Durchzug der Front nutzbar; Glutnester, Rauch, Stammbrüche und Rückzündung vor Ort prüfen.`);
      } else {
        grund = status === "geeignet"
          ? `${def.label} ohne Brandlast und groß genug (${sizeTxt}).`
          : `${def.label} ohne Brandlast, aber knapp bemessen: ${sizeTxt}.`;
      }
      if (osm && osm.drivable) {
        if (!drv) { hinweise.push("Keine befahrbare Zufahrt in den OSM-Daten: Zufahrt vor Ort prüfen."); if (status === "geeignet") status = "bedingt"; }
        else if (drv === 1) hinweise.push("Zufahrt nur über einen Wirtschafts-/Waldweg (OSM): Befahrbarkeit prüfen.");
      } else {
        hinweise.push("Befahrbarkeit nicht geprüft (keine OSM-Wegedaten).");
      }
      if (isFinite(arrivalMin) && type !== "abgebrannt" && def.brandlast) {
        hinweise.push(`Die „möglich“-Front kann die Fläche selbst ab ${fmtMin(arrivalMin)} erreichen.`);
      }
      if (!sl.known) hinweise.push(grid.elev
          ? "Hangneigung zur Brandseite nicht bestimmbar (Fläche liegt am Brandschwerpunkt): Hangzuschlag = 1,0."
          : "Hangneigung zur Brandseite unbekannt (kein Geländemodell): Hangzuschlag = 1,0.");

      const id = `sa:${type}:${ins.centerIdx}`;
      const [clat, clon] = G.cellLatLng(grid, ins.centerIdx);
      areas.push({
        id, type, typLabel: def.label, cells, cellCount: cells.length, areaHa,
        coreCells: Int32Array.from(coreCells), distFireM: distFire,
        inscribedRM: ins.radiusM, centerIdx: ins.centerIdx, lat: clat, lon: clon,
        edge: edge.list, edgeClass: worst ? worst.cls : null, flameM, flameInfo: worst ? worst.f : null,
        slopeTan: sl.tan, slopeKnown: sl.known, windKmh: maxWind,
        delta: req.delta, deltaSlope: req.deltaSlope, deltaWind: req.deltaWind,
        ssdM: req.ssdM, addM: req.addM, requiredRM: req.radiusM, minSsdLimited: req.limitedByMin,
        drivable: drv, arrivalMin, earliestMin, status, reason: grund, hinweise,
        dismissed: dismissed.has(id),
        source: osm ? "OSM-Landnutzung (nicht verifiziert) + Modellprognose" : "Brandfläche der Einsatzleitung + Modellprognose",
      });
    }

    // Reihenfolge: deterministisch – Status, dann Nähe zum Brand, dann Zellindex
    const rank = { geeignet: 0, bedingt: 1, ungeeignet: 2 };
    areas.sort((a, b) => rank[a.status] - rank[b.status] || a.distFireM - b.distFireM || a.centerIdx - b.centerIdx);
    if (skippedFar) notes.push(`${skippedFar} Fläche(n) weiter als ${s.maxAreaDistM} m vom Brandschwerpunkt nicht berücksichtigt (Annahme).`);
    const kept = areas.slice(0, s.maxAreas);
    if (areas.length > kept.length) notes.push(`${areas.length - kept.length} weitere Flächen nicht angezeigt (Anzeigegrenze ${s.maxAreas}, Annahme).`);
    if (!kept.length) {
      notes.push(osm
        ? "Keine Fläche in den Daten erfüllt die Mindestgröße. Rückzugsfläche vor Ort festlegen (LACES)."
        : "Keine Rückzugsfläche aus den vorhandenen Daten ableitbar.");
    }
    return { areas: kept, notes, allCount: areas.length, maxWind };
  }

  // ------------------------------------------------------------------ Fluchtwege (Dijkstra, rückwärts von den Flächen)
  const OFF8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  /**
   * Zeitfeld „schnellster Weg bis zur nächsten geeigneten Fläche“ (min) und Nachfolgerzelle.
   * Rückwärtssuche: beim Entspannen von u nach v wird die Fahrtzeit v -> u angesetzt
   * (Hangwirkung ist richtungsabhängig).
   * @param speedAt (i) -> km/h in Zelle i, 0 = nicht passierbar
   * @param speedEdge (v, u, lenM) -> km/h für die Fahrt v -> u
   */
  function timeField(grid, targets, speedAt, speedEdge, maxMin) {
    const n = grid.nx * grid.ny;
    const time = new Float64Array(n).fill(Infinity);
    const next = new Int32Array(n).fill(-1);
    let hIdx = new Int32Array(1024), hKey = new Float64Array(1024), size = 0;
    function push(i, k) {
      if (size === hIdx.length) {
        const a = new Int32Array(size * 2), b = new Float64Array(size * 2);
        a.set(hIdx); b.set(hKey); hIdx = a; hKey = b;
      }
      let q = size++;
      hIdx[q] = i; hKey[q] = k;
      while (q > 0) {
        const p = (q - 1) >> 1;
        if (hKey[p] <= hKey[q]) break;
        const ti = hIdx[p], tk = hKey[p]; hIdx[p] = hIdx[q]; hKey[p] = hKey[q]; hIdx[q] = ti; hKey[q] = tk;
        q = p;
      }
    }
    function pop() {
      const top = hIdx[0], tk = hKey[0];
      size--;
      if (size > 0) {
        hIdx[0] = hIdx[size]; hKey[0] = hKey[size];
        let q = 0;
        for (;;) {
          const l = 2 * q + 1, r = l + 1;
          let m = q;
          if (l < size && hKey[l] < hKey[m]) m = l;
          if (r < size && hKey[r] < hKey[m]) m = r;
          if (m === q) break;
          const ti = hIdx[m], tkk = hKey[m]; hIdx[m] = hIdx[q]; hKey[m] = hKey[q]; hIdx[q] = ti; hKey[q] = tkk;
          q = m;
        }
      }
      return [top, tk];
    }
    for (const t of targets) { if (time[t] > 0) { time[t] = 0; push(t, 0); } }
    const cell = grid.cell;
    while (size > 0) {
      const [u, k] = pop();
      if (k > time[u]) continue;
      if (k > maxMin) break;
      const ui = u % grid.nx, uj = (u - ui) / grid.nx;
      for (const [di, dj] of OFF8) {
        const vi = ui + di, vj = uj + dj;
        if (vi < 0 || vj < 0 || vi >= grid.nx || vj >= grid.ny) continue;
        const v = vj * grid.nx + vi;
        if (!(speedAt(v) > 0)) continue;
        const len = Math.hypot(di, dj) * cell;
        const kmh = speedEdge(v, u, len);
        if (!(kmh > 0)) continue;
        const t = k + (len / 1000 / kmh) * 60;
        if (t < time[v] && t <= maxMin) { time[v] = t; next[v] = u; push(v, t); }
      }
    }
    return { time, next };
  }

  /** Tobler (1993): Gehgeschwindigkeit in km/h bei Steigung s (tan, positiv = bergauf). */
  function toblerKmh(s) { return 6 * Math.exp(-3.5 * Math.abs(s + 0.05)); }

  /**
   * Fluchtwege aller Standorte zu den geeigneten/bedingt geeigneten Flächen.
   * @param inp {grid, osm, areas, positions, P}
   *   positions: [{id, lat, lon, label?, vehicleId?, taskKind?}]
   * @returns {routes, fields}
   */
  function escapeRoutes(inp) {
    const { grid, P } = inp;
    const s = params(P);
    const osm = inp.osm || null;
    const areas = (inp.areas || []).filter((a) => !a.dismissed && a.status !== "ungeeignet");
    const positions = inp.positions || [];
    const drv = osm && osm.drivable ? osm.drivable : null;

    // Ziele sind NICHT die ganze Fläche, sondern ihr Kernbereich: Zellen mit ausreichendem Abstand
    // zum Flächenrand (dort ist der Sicherheitsabstand nach Butler & Cohen eingehalten).
    // Für Fahrzeuge zählen nur befahrbare Flächentypen, zu Fuß alle.
    const targetsVeh = [], targetsFoot = [];
    const areaOf = new Int32Array(grid.nx * grid.ny).fill(-1);
    areas.forEach((a, q) => {
      const core = a.coreCells && a.coreCells.length ? a.coreCells : a.cells;
      for (const k of core) { if (areaOf[k] < 0) areaOf[k] = q; }
      if (TYPES[a.type].befahrbar) for (const k of core) targetsVeh.push(k);
      for (const k of core) targetsFoot.push(k);
    });

    // Innerhalb einer befahrbaren Rückzugsfläche darf das Fahrzeug abseits der Wege fahren
    // (ANNAHME: abgeerntetes Feld, Steinbruchsohle, Parkplatz, abgebrannte Fläche).
    const inArea = new Uint8Array(grid.nx * grid.ny);
    const anyArea = new Uint8Array(grid.nx * grid.ny);
    for (const a of areas) {
      for (const k of a.cells) { anyArea[k] = 1; if (TYPES[a.type].befahrbar) inArea[k] = 1; }
    }
    // Zu Fuß: alles außer Bebauung; Wasser nur, wenn es selbst die Rückzugsfläche ist (ANNAHME)
    const footOk = (i) => {
      const c = grid.classList[grid.fuel[i]];
      if (c === "siedlung") return false;
      if (c === "wasser") return anyArea[i] === 1;
      return true;
    };
    const onPath = (i) => (drv ? drv[i] > 0 : false);

    const vehSpeedAt = (i) => (drv
      ? (drv[i] === 1 ? s.roadKmh : drv[i] === 2 ? s.trackKmh : inArea[i] ? s.trackKmh : 0)
      : (inArea[i] ? s.trackKmh : 0));
    const vehSpeedEdge = (v, u, len) => {
      const base = Math.min(vehSpeedAt(v), vehSpeedAt(u));
      if (!(base > 0)) return 0;
      const up = Math.max(0, slopeBetween(grid, v, u));
      return base / (1 + s.slopeSlowK * up);
    };
    const footSpeedAt = (i) => (footOk(i) ? 1 : 0);
    const footSpeedEdge = (v, u) => {
      if (!footOk(v) || !footOk(u)) return 0;
      const sl = slopeBetween(grid, v, u);
      const f = onPath(v) && onPath(u) ? 1 : s.footOffPath;
      return toblerKmh(sl) * f;
    };

    const fields = {};
    if (targetsVeh.length) fields.fahrzeug = timeField(grid, targetsVeh, vehSpeedAt, vehSpeedEdge, s.maxRouteMin);
    if (targetsFoot.length) fields.fuss = timeField(grid, targetsFoot, footSpeedAt, footSpeedEdge, s.maxRouteMin);

    const routes = [];
    for (const p of positions) {
      const [x, y] = grid.proj.toXY(p.lat, p.lon);
      const start = G.cellOf(grid, x, y);
      const entry = { positionId: p.id, label: p.label || "", vehicleId: p.vehicleId || null, lat: p.lat, lon: p.lon, fahrzeug: null, fuss: null };
      if (start < 0) { entry.error = "Standort außerhalb des Rechengebiets"; routes.push(entry); continue; }
      for (const mode of ["fahrzeug", "fuss"]) {
        const f = fields[mode];
        if (!f) continue;
        let from = start;
        // Fahrzeug steht evtl. nicht exakt auf einem Weg: nächstgelegene erreichbare Zelle im Umkreis
        if (!isFinite(f.time[from])) {
          let best = -1, bd = Infinity;
          const r = Math.ceil(100 / grid.cell);
          const si = start % grid.nx, sj = (start - si) / grid.nx;
          for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            const a = si + di, b = sj + dj;
            if (a < 0 || b < 0 || a >= grid.nx || b >= grid.ny) continue;
            const q = b * grid.nx + a;
            if (!isFinite(f.time[q])) continue;
            const d = Math.hypot(di, dj);
            if (d < bd || (d === bd && q < best)) { bd = d; best = q; }
          }
          if (best < 0) continue;
          from = best;
        }
        const path = [];
        let k = from, guard = 0;
        while (k >= 0 && guard++ < grid.nx * grid.ny) {
          path.push(k);
          if (f.time[k] === 0) break;
          k = f.next[k];
        }
        if (!path.length) continue;
        const target = path[path.length - 1];
        const aIdx = areaOf[target];
        const latlngs = [[p.lat, p.lon], ...path.map((q) => G.cellLatLng(grid, q))];
        let lengthM = 0, ascentM = 0;
        for (let q = 1; q < path.length; q++) {
          const [ax, ay] = G.cellCenter(grid, path[q - 1]), [bx, by] = G.cellCenter(grid, path[q]);
          lengthM += Math.hypot(bx - ax, by - ay);
          if (grid.elev) {
            const za = grid.elev[path[q - 1]], zb = grid.elev[path[q]];
            if (Number.isFinite(za) && Number.isFinite(zb) && zb > za) ascentM += zb - za;
          }
        }
        const approachM = Math.hypot(...grid.proj.toXY(p.lat, p.lon).map((v, ii) => v - G.cellCenter(grid, from)[ii]));
        const extraMin = mode === "fuss" ? (approachM / 1000) / 5 * 60 : (approachM / 1000) / s.trackKmh * 60;
        const atArea = from === start && f.time[start] === 0;
        entry[mode] = {
          mode, areaId: aIdx >= 0 ? areas[aIdx].id : null, area: aIdx >= 0 ? areas[aIdx] : null,
          travelMin: f.time[from] + extraMin,
          timeMin: atArea ? 0 : f.time[from] + extraMin + s.reactionMin,
          reactionMin: atArea ? 0 : s.reactionMin, lengthM, ascentM, latlngs, cells: path,
          offRoadStartM: approachM, atArea,
        };
      }
      routes.push(entry);
    }
    return { routes, fields, areasUsed: areas };
  }

  // ------------------------------------------------------------------ Warnung
  /**
   * Prüft je Standort: Fluchtzeit + Puffer gegen die früheste Zeit, zu der die „möglich“-Front
   * den Standort erreichen kann.
   */
  function checkRoutes(inp) {
    const { grid, result, P } = inp;
    const s = params(P);
    const tP = result && result.tPossible ? result.tPossible : null;
    const out = [];
    for (const r of inp.routes || []) {
      const [x, y] = grid.proj.toXY(r.lat, r.lon);
      const k = G.cellOf(grid, x, y);
      const frontMin = k >= 0 && tP ? tP[k] : Infinity;
      const best = r.fahrzeug || r.fuss;
      const o = {
        positionId: r.positionId, vehicleId: r.vehicleId, label: r.label,
        frontMin, bufferMin: s.bufferMin,
        escapeMin: best ? best.timeMin : Infinity,
        mode: best ? best.mode : null,
        areaId: best ? best.areaId : null,
      };
      if (!best) {
        o.status = "kritisch";
        o.reserveMin = -Infinity;
        o.text = `Kein Fluchtweg zu einer geeigneten Rückzugsfläche gefunden (Umkreis ${s.maxRouteMin} min). Rückzugsweg und Sicherheitsbereich vor Ort festlegen (LACES).`;
      } else {
        o.reserveMin = frontMin - (best.timeMin + s.bufferMin);
        o.atArea = !!best.atArea;
        if (best.atArea) {
          o.status = "ok";
          o.text = `Standort liegt bereits im Kernbereich einer Rückzugsfläche (${best.areaId}): kein Fluchtweg nötig.`;
        } else if (!isFinite(frontMin)) {
          o.status = "ok";
          o.text = `Fluchtweg ${best.mode === "fuss" ? "zu Fuß" : "mit Fahrzeug"} ca. ${Math.round(best.timeMin)} min; die „möglich“-Front erreicht den Standort im Prognosehorizont nicht.`;
        } else if (o.reserveMin <= 0) {
          o.status = "kritisch";
          o.text = `WARNUNG: Fluchtzeit ${Math.round(best.timeMin)} min + ${s.bufferMin} min Puffer übersteigt die Zeit bis zur „möglich“-Front (${fmtMin(frontMin)}) um ${Math.round(-o.reserveMin)} min. Standort so nicht halten.`;
        } else if (o.reserveMin < s.warnReserveMin) {
          o.status = "knapp";
          o.text = `Knapp: Fluchtzeit ${Math.round(best.timeMin)} min + ${s.bufferMin} min Puffer, „möglich“-Front ab ${fmtMin(frontMin)} – Reserve nur ${Math.round(o.reserveMin)} min.`;
        } else {
          o.status = "ok";
          o.text = `Fluchtweg ${best.mode === "fuss" ? "zu Fuß" : "mit Fahrzeug"} ca. ${Math.round(best.timeMin)} min, „möglich“-Front ab ${fmtMin(frontMin)}, Reserve ${Math.round(o.reserveMin)} min.`;
        }
        if (r.fahrzeug && r.fuss && r.fuss.timeMin > r.fahrzeug.timeMin) {
          o.footMin = r.fuss.timeMin;
          o.text += ` Zu Fuß (Fahrzeug bleibt stehen): ca. ${Math.round(r.fuss.timeMin)} min.`;
        } else if (!r.fahrzeug && r.fuss) {
          o.text += " Kein befahrbarer Weg zu einer Fläche: nur Fußweg geprüft.";
        }
      }
      out.push(o);
    }
    return out;
  }

  // ------------------------------------------------------------------ Gesamtlauf
  /**
   * Vollständige Planung: Flächen, Fluchtwege, Warnungen.
   * @param inp {grid, result, osm, ignition, weatherHours, positions, P, state?, extra?}
   */
  function plan(inp) {
    const t0 = Date.now();
    const P = inp.P;
    const s = params(P);
    const found = findAreas(inp);
    const er = escapeRoutes({ grid: inp.grid, osm: inp.osm, areas: found.areas, positions: inp.positions || [], P });
    const warnings = checkRoutes({ grid: inp.grid, result: inp.result, routes: er.routes, P });
    const notes = [...found.notes];
    const alerts = warnings.filter((w) => w.status === "kritisch").map((w) => `ACHTUNG Rückzug – ${w.label || w.positionId}: ${w.text}`);
    if (!inp.grid.elev) notes.push("Kein Geländemodell geladen: Hangzuschlag auf den Sicherheitsabstand und die Hangwirkung auf die Fluchtzeit entfallen (Fluchtzeiten eher zu kurz).");
    if (!(inp.weatherHours || []).length) notes.push("Keine Wetterdaten: Flammenlänge nicht berechenbar, es gilt nur der Mindestabstand (Radius " + s.minSsdM + " m, Butler & Cohen 1998).");
    return {
      areas: found.areas, routes: er.routes, warnings, notes, alerts,
      params: s, allAreaCount: found.allCount, durationMs: Date.now() - t0,
      meta: {
        osm: !!inp.osm, dem: !!inp.grid.elev, positions: (inp.positions || []).length,
        version: "0.1.0-safearea",
        quellen: [
          "Butler & Cohen (1998), Int. J. Wildland Fire 7(2):73–77, doi:10.1071/WF9980073",
          "Butler (2014), Int. J. Wildland Fire 23(3):295–308, doi:10.1071/WF13021",
          "Page & Butler (2017), Int. J. Wildland Fire 26:655–667, doi:10.1071/WF16213",
          "Byram (1959), metrische Form nach Alexander (1982)",
          "Tobler (1993) Hiking Function",
        ],
      },
    };
  }

  /**
   * Hilfsfunktion: zusätzliche OSM-Flächen (Parkplatz, Steinbruch, Sportfläche, Hoffläche) auf das
   * Raster übertragen. Erwartet Overpass-Elemente wie in js/osm.js (way/relation mit geometry).
   * @returns Uint8Array mit 1=steinbruch, 2=parkplatz, 3=sportplatz, 4=hoffläche
   */
  function rasterExtra(grid, json) {
    const n = grid.nx * grid.ny;
    const out = new Uint8Array(n);
    if (!json || !json.elements) return out;
    const codeOf = (t) => {
      if (t.landuse === "quarry") return 1;
      if (t.amenity === "parking") return 2;
      if (t.leisure === "pitch" || t.leisure === "track" || t.leisure === "sports_centre") return 3;
      if (t.landuse === "farmyard") return 4;
      return 0;
    };
    for (const el of json.elements) {
      const t = el.tags || {};
      const c = codeOf(t);
      if (!c) continue;
      const segs = [];
      if (el.type === "way" && el.geometry && el.geometry.length > 2) {
        G.ringToSegs(el.geometry.filter(Boolean).map((p) => grid.proj.toXY(p.lat, p.lon)), segs);
      } else if (el.type === "relation" && el.members) {
        for (const m of el.members) {
          if (m.type !== "way" || !m.geometry || m.geometry.length < 2) continue;
          const pts = m.geometry.map((p) => grid.proj.toXY(p.lat, p.lon));
          for (let k = 0; k + 1 < pts.length; k++) segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
        }
      }
      if (segs.length) G.fillSegments(grid, segs, (i) => { out[i] = c; });
    }
    return out;
  }

  /** Overpass-Ergänzung für js/osm.js (siehe INTEGRATION.md). */
  const OVERPASS_EXTRA = `
  way["landuse"~"^(quarry|farmyard)$"]({{bbox}});
  relation["landuse"~"^(quarry|farmyard)$"]["type"="multipolygon"]({{bbox}});
  way["amenity"="parking"]({{bbox}});
  way["leisure"~"^(pitch|track|sports_centre)$"]({{bbox}});`;

  /** Umrisse einer Fläche als Leaflet-Ringe [[lat,lon],...]. Nutzt Contour.cellOutline, wenn vorhanden. */
  function areaRings(grid, area) {
    const set = new Set(area.cells);
    if (!root.Contour || !root.Contour.cellOutline) return [];
    const rings = root.Contour.cellOutline(grid.nx, grid.ny, (k) => set.has(k));
    const drop = root.Contour.dropCollinear || ((r) => r);
    return rings.map((r) => drop(r).map(([i, j]) => grid.proj.toLatLng(grid.x0 + i * grid.cell, grid.y0 + j * grid.cell)));
  }

  /** Protokoll-/Exportdarstellung (kompakt, ohne Zellenlisten). */
  function forProtocol(res) {
    return {
      flaechen: res.areas.map((a) => ({
        id: a.id, typ: a.typLabel, status: a.status, flaeche_ha: r1(a.areaHa),
        freier_radius_m: Math.round(a.inscribedRM), erforderlicher_radius_m: Math.round(a.requiredRM),
        flammenlaenge_m: r1(a.flameM), randbrennstoff: a.edgeClass,
        hang_tan: r1(a.slopeTan * 100) / 100, wind_kmh: Math.round(a.windKmh), faktor_hang_wind: r1(a.delta),
        befahrbar: a.drivable === 2 ? "Straße" : a.drivable === 1 ? "Weg" : "nicht geprüft/keine",
        lat: +a.lat.toFixed(6), lon: +a.lon.toFixed(6),
        begruendung: a.reason, hinweise: a.hinweise, verworfen: !!a.dismissed, quelle: a.source,
      })),
      fluchtwege: res.routes.map((r) => ({
        standort: r.positionId, fahrzeug: r.vehicleId, aufgabe: r.label,
        fahrzeugweg_min: r.fahrzeug ? Math.round(r.fahrzeug.timeMin) : null,
        fahrzeugweg_m: r.fahrzeug ? Math.round(r.fahrzeug.lengthM) : null,
        fussweg_min: r.fuss ? Math.round(r.fuss.timeMin) : null,
        ziel: (r.fahrzeug || r.fuss || {}).areaId || null,
        anstieg_m: r.fahrzeug ? Math.round(r.fahrzeug.ascentM) : r.fuss ? Math.round(r.fuss.ascentM) : null,
      })),
      warnungen: res.warnings.map((w) => ({
        standort: w.positionId, fahrzeug: w.vehicleId, status: w.status,
        fluchtzeit_min: isFinite(w.escapeMin) ? Math.round(w.escapeMin) : null,
        puffer_min: w.bufferMin,
        front_moeglich_min: isFinite(w.frontMin) ? Math.round(w.frontMin) : null,
        reserve_min: isFinite(w.reserveMin) ? Math.round(w.reserveMin) : null,
        text: w.text,
      })),
      hinweise: res.notes, quellen: res.meta.quellen,
    };
  }

  const SafeArea = {
    DEFAULTS, TYPES, OVERPASS_EXTRA,
    params, sigmaFromRothermel, flameFromRothermel, flameForClass,
    deltaFactor, requiredRadius, toblerKmh,
    components, inscribedCircle, edgeClasses, slopeToFire, slopeBetween,
    findAreas, escapeRoutes, checkRoutes, plan, rasterExtra, areaRings, forProtocol, fmtMin,
  };
  root.SafeArea = SafeArea;
  if (typeof module !== "undefined" && module.exports) module.exports = SafeArea;
})(typeof globalThis !== "undefined" ? globalThis : this);
