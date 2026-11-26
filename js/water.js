/*
 * Modul Wasserversorgung (Entwurf 0.1.0): Planung und zeitdiskrete Simulation der Löschwasserversorgung
 * für Riegel/Objektschutz mit Pufferbecken (Faltbehälter), Schlauchleitungen (Förderstrecke) und Pendelverkehr.
 * Reine Funktionen ohne DOM, deterministisch (keine Zufallszahlen, feste Reihenfolgen).
 *
 * SIMULATION MIT ANNAHMEN, KEINE EINSATZPLANUNG. Alle Zahlen stehen in PARAMS.wasser (js/water-params.js)
 * und sind Annahmen (siehe docs/assumptions.md). Fahrwege: Luftlinie x Umwegfaktor, KEIN Routing.
 *
 * Schnittstelle:
 *   Water.planSupply(input) -> plan
 *   Water.simulate(plan)    -> sim
 *   Water.run(input)        -> {plan, sim, iterations}  (Nachplanung mit Reservefahrzeugen bei Defizit)
 *
 * input = {
 *   W: PARAMS.wasser,
 *   consumers: [{id, label, lat, lon, readyMin, tankL, kind: "Riegel"|"Objektschutz", mode?: "wenderohr", demandLpm?}],
 *   vehicles:  [{id, typ, bezeichnung, kommune, wache, tank_l, pumpe_lpm, anfahrtMin, originLat?, originLon?}]
 *              (verfügbare Fahrzeuge; Ausschlüsse siehe exclude, werden zusätzlich geprüft)
 *   exclude:   {grundschutzIds: [], pflichtIds: [], assignedIds: [], ids: []},
 *   sources:   [{id, lat, lon, kind, tags, source, verified, areaM2?, wasserTyp?, lpm?, volumeM3?}],
 *   basins:    null (automatisch) | [{id, lat, lon}] (vom Nutzer gesetzt/verschoben),
 *   terrain:   {elevation(lat, lon) -> m | null} | null,
 *   hazard:    {possibleMinAt(lat, lon) -> min | Infinity, center: {lat, lon}} | null,
 *   roads:     Water.roadNet(...) | null,
 *   extraShuttle: 0 (intern, Nachplanung)
 * }
 */
(function (root) {
  "use strict";

  const M_PER_DEG = 111195;
  const STATES = ["anfahrt", "rueckfahrt", "warten_quelle", "fuellen", "fahrt_beladen", "warten_becken", "entleeren", "pumpen", "reserve"];
  const STATE_LABEL = {
    anfahrt: "Anfahrt", rueckfahrt: "Rückfahrt (leer)", warten_quelle: "Warten an Entnahmestelle", fuellen: "Füllen",
    fahrt_beladen: "Fahrt beladen", warten_becken: "Warten am Becken", entleeren: "Entleeren", pumpen: "Pumpen (Förderstrecke)",
    reserve: "nicht benötigt",
  };
  const SI = Object.fromEntries(STATES.map((s, i) => [s, i]));
  const ROLE_LABEL = { pendel: "Pendelverkehr", pumpe: "Pumpe Förderstrecke", verstaerker: "Verstärkerpumpe", reserve: "nicht benötigt" };

  // ------------------------------------------------------------------ Geometrie (lokal äquidistant)
  function distM(a, b) {
    const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.hypot((b.lon - a.lon) * M_PER_DEG * k, (b.lat - a.lat) * M_PER_DEG);
  }
  function makeProj(lat0, lon0) {
    const k = Math.cos((lat0 * Math.PI) / 180);
    return {
      toXY: (lat, lon) => [(lon - lon0) * M_PER_DEG * k, (lat - lat0) * M_PER_DEG],
      toLL: (x, y) => [lat0 + y / M_PER_DEG, lon0 + x / (M_PER_DEG * k)],
    };
  }
  const lerpLL = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const r1 = (v) => Math.round(v * 10) / 10;

  // ------------------------------------------------------------------ Wegenetz (befahrbar)
  /**
   * Wegenetz aus Linien [{latlngs: [[lat, lon], ...], kind: 1 (Straße) | 2 (Wald-/Wirtschaftsweg), name?}]
   * oder aus Punkten [{lat, lon, kind}] (z. B. befahrbare Rasterzellen der App). Punkte im Abstand sampleM.
   */
  function roadNet(lines, opt) {
    const o = Object.assign({ sampleM: 25, points: null, cellM: 200 }, opt || {});
    const pts = [];
    if (o.points) for (const p of o.points) pts.push({ lat: p.lat, lon: p.lon, kind: p.kind || 1 });
    for (const ln of lines || []) {
      const ll = ln.latlngs || [];
      for (let q = 0; q + 1 < ll.length; q++) {
        const a = { lat: ll[q][0], lon: ll[q][1] }, b = { lat: ll[q + 1][0], lon: ll[q + 1][1] };
        const n = Math.max(1, Math.ceil(distM(a, b) / o.sampleM));
        for (let s = 0; s < n; s++) pts.push({ ...lerpLL(a, b, s / n), kind: ln.kind || 1 });
        if (q + 2 === ll.length) pts.push({ ...b, kind: ln.kind || 1 });
      }
    }
    if (!pts.length) return null;
    const lat0 = pts[0].lat, lon0 = pts[0].lon, pr = makeProj(lat0, lon0);
    const grid = new Map();
    const key = (gx, gy) => gx + "," + gy;
    pts.forEach((p, i) => {
      const [x, y] = pr.toXY(p.lat, p.lon);
      p.x = x; p.y = y; p.i = i;
      const k = key(Math.floor(x / o.cellM), Math.floor(y / o.cellM));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    });
    function near(lat, lon, radiusM, filter) {
      const [x, y] = pr.toXY(lat, lon);
      const c = Math.ceil(radiusM / o.cellM), gx = Math.floor(x / o.cellM), gy = Math.floor(y / o.cellM);
      const out = [];
      for (let dx = -c; dx <= c; dx++) for (let dy = -c; dy <= c; dy++) {
        for (const p of grid.get(key(gx + dx, gy + dy)) || []) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d <= radiusM && (!filter || filter(p))) out.push({ p, d });
        }
      }
      out.sort((a, b) => a.d - b.d || a.p.i - b.p.i);
      return out;
    }
    function nearest(lat, lon, maxM, filter) {
      let r = Math.min(100, maxM);
      for (;;) {
        const n = near(lat, lon, r, filter);
        if (n.length) return n[0];
        if (r >= maxM) return null;
        r = Math.min(maxM, r * 2);
      }
    }
    /** Abstand (m, Luftlinie) zur nächsten Straße (kind 1); 0 = an der Straße; maxM wenn keine gefunden. */
    function slowDistM(lat, lon, maxM = 3000) {
      const n = nearest(lat, lon, maxM, (p) => p.kind === 1);
      return n ? n.d : maxM;
    }
    return { points: pts, near, nearest, slowDistM, count: pts.length };
  }

  // ------------------------------------------------------------------ Entnahmestellen
  function parseFlow(tags) {
    for (const k of ["flow_rate", "fire_hydrant:flow_capacity", "fire_hydrant:flow_rate", "flow_capacity"]) {
      const raw = tags && tags[k];
      if (raw === undefined || raw === null || raw === "") continue;
      const s = String(raw).replace(",", ".").toLowerCase();
      const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (!m) continue;
      let v = Number(m[1]);
      if (/m3\/h|m³\/h|cbm\/h/.test(s)) v = (v * 1000) / 60;
      else if (/l\/s/.test(s)) v = v * 60;
      if (v >= 50 && v <= 20000) return { lpm: v, key: k, raw: String(raw) };
    }
    return null;
  }
  function parseDiameter(tags) {
    for (const k of ["fire_hydrant:diameter", "diameter"]) {
      const raw = tags && tags[k];
      if (raw === undefined || raw === null) continue;
      const m = String(raw).match(/([0-9]+)/);
      if (m && Number(m[1]) >= 25 && Number(m[1]) <= 1000) return { mm: Number(m[1]), key: k };
    }
    return null;
  }
  function parseVolumeM3(tags) {
    for (const k of ["water_volume", "volume"]) {
      const raw = tags && tags[k];
      if (raw === undefined || raw === null) continue;
      const s = String(raw).replace(",", ".").toLowerCase();
      const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (!m) continue;
      let v = Number(m[1]);
      if (/\bl\b|liter/.test(s) && !/m3|m³/.test(s)) v = v / 1000;
      if (v > 0 && v < 100000) return { m3: v, key: k };
    }
    return null;
  }

  /**
   * Einstufung einer Entnahmestelle (OSM oder manuell, Format von osm.js/app.js waterPoints).
   * @returns {id, lat, lon, typ: hydrant|offen|behaelter|unbekannt, label, capLpm (null = durch Pumpe begrenzt),
   *           needsPump, volumeL (Infinity = unbegrenzt), maxConcurrent, ruestMin, status, verified, source, annahmen[]}
   */
  function classifySource(p, W) {
    const Q = W.quellen;
    const tags = p.tags || {};
    const em = p.wasserTyp || tags.emergency || null;
    const kindTxt = String(p.kind || "");
    const base = { id: String(p.id), lat: Number(p.lat), lon: Number(p.lon), verified: !!p.verified, source: p.source || "OSM", annahmen: [], usable: true };
    const pumpOpen = (o) => Object.assign(base, { needsPump: true, capLpm: null, maxConcurrent: Q.offen.maxGleichzeitig, ruestMin: Q.offen.ruestMin }, o);
    if (em === "fire_hydrant" || em === "hydrant") {
      let cap = num(p.lpm), why;
      if (cap !== null) why = "Angabe am Punkt (manuell)";
      else {
        const f = parseFlow(tags);
        if (f) { cap = f.lpm; why = `OSM-Tag ${f.key}=${f.raw} (ungeprüft)`; }
        else {
          const d = parseDiameter(tags);
          if (d) {
            const row = Q.hydrant.nachDurchmesserLpm.find(([mm]) => d.mm <= mm) || Q.hydrant.nachDurchmesserLpm[Q.hydrant.nachDurchmesserLpm.length - 1];
            cap = row[1]; why = `ANNAHME nach ${d.key}=${d.mm} mm`;
            base.annahmen.push("Ergiebigkeit");
          } else { cap = Q.hydrant.defaultLpm; why = "ANNAHME (keine OSM-Angabe)"; base.annahmen.push("Ergiebigkeit"); }
        }
      }
      const t = tags["fire_hydrant:type"];
      const tl = t === "underground" ? "Unterflurhydrant" : t === "pillar" ? "Überflurhydrant" : t === "wall" ? "Wandhydrant" : "Hydrant";
      return Object.assign(base, { typ: "hydrant", label: tl, capLpm: cap, capWhy: why, needsPump: false, volumeL: Infinity, maxConcurrent: Q.hydrant.maxGleichzeitig, ruestMin: Q.hydrant.ruestMin, status: why.startsWith("ANNAHME") ? "Annahme" : "Angabe" });
    }
    if (em === "suction_point") return pumpOpen({ typ: "offen", label: "Saugstelle", volumeL: Infinity, status: "ausreichend", statusWhy: "ANNAHME: ausgewiesene Saugstelle (Wasserstand prüfen)" });
    if (em === "fire_water_pond" || em === "water_tank") {
      const v = num(p.volumeM3) !== null ? { m3: num(p.volumeM3), key: "Angabe" } : parseVolumeM3(tags);
      if (!v) base.annahmen.push("Volumen");
      const m3 = v ? v.m3 : Q.behaelter.defaultM3;
      return pumpOpen({ typ: "behaelter", label: em === "fire_water_pond" ? "Löschwasserteich" : "Löschwasserbehälter", volumeL: m3 * 1000, status: v ? "Angabe" : "Annahme", statusWhy: v ? `${v.key} ${m3} m³ (ungeprüft)` : `ANNAHME ${m3} m³ (kein OSM-Tag water_volume)` });
    }
    if (em === "waterway_river" || tags.waterway === "river") return pumpOpen({ typ: "offen", label: "Fluss (Zugang am Weg)", volumeL: Infinity, status: W.quellen.gewaesser.fluss, statusWhy: "ANNAHME nach Gewässertyp" });
    if (em === "waterway_stream" || tags.waterway === "stream") return pumpOpen({ typ: "offen", label: "Bach (Zugang am Weg)", volumeL: Infinity, status: W.quellen.gewaesser.bach, statusWhy: "ANNAHME: Bach, Wasserführung/Stauung vor Ort prüfen" });
    if (em === "natural_water" || tags.natural === "water" || /^Gewässer/.test(kindTxt)) {
      const a = num(p.areaM2);
      const G = W.quellen.gewaesser;
      if (a !== null && a < G.flaecheMinM2) return Object.assign(base, { typ: "offen", label: "Gewässer (zu klein)", usable: false, why: `Fläche ${Math.round(a)} m² < ${G.flaecheMinM2} m²`, needsPump: true });
      const st = a !== null && a >= G.flaecheAusreichendM2 ? "ausreichend" : "unsicher";
      return pumpOpen({ typ: "offen", label: "Stillgewässer", volumeL: Infinity, status: st, statusWhy: a !== null ? `ANNAHME nach Fläche ca. ${Math.round(a)} m²` : "ANNAHME: Größe unbekannt" });
    }
    // manuell erfasst oder unbekannter Typ
    const cap = num(p.lpm) ?? Q.unbekannt.defaultLpm;
    base.annahmen.push("Typ", "Ergiebigkeit");
    return Object.assign(base, { typ: "unbekannt", label: p.source === "manuell" ? "manuell erfasst (Typ offen)" : `Entnahmestelle (${kindTxt || "Typ offen"})`, capLpm: cap, capWhy: num(p.lpm) !== null ? "Angabe am Punkt" : "ANNAHME (Typ unbekannt, wie Hydrant)", needsPump: false, volumeL: Infinity, maxConcurrent: Q.hydrant.maxGleichzeitig, ruestMin: Q.hydrant.ruestMin, status: "Annahme" });
  }

  /**
   * Entnahmestellen aus einer Overpass-Antwort (out geom/center): emergency-Objekte, natural=water (Fläche,
   * Zugang am nächsten befahrbaren Weg), waterway=stream/river (Zugangspunkte, wo ein Weg das Gewässer berührt).
   * Ergebnis im Punktformat der App (ungeprüft, source "OSM"). roads: Water.roadNet(...) oder null.
   */
  function sourcesFromOsm(json, roads, W) {
    const G = W.quellen.gewaesser;
    const out = [], rejected = [];
    for (const el of (json && json.elements) || []) {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (t.emergency && /^(fire_hydrant|water_tank|suction_point|fire_water_pond)$/.test(t.emergency) && lat !== undefined) {
        out.push({ id: `${el.type}/${el.id}`, lat, lon, kind: t.emergency, tags: t, source: "OSM", verified: false });
        continue;
      }
      if (t.natural === "water" && el.type === "way" && el.geometry && el.geometry.length > 3) {
        const g = el.geometry.filter(Boolean);
        const pr = makeProj(g[0].lat, g[0].lon);
        const xy = g.map((q) => pr.toXY(q.lat, q.lon));
        let a = 0;
        for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) a += (xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1]) / 2;
        a = Math.abs(a);
        if (a < G.flaecheMinM2) { rejected.push({ id: `way/${el.id}`, why: `Fläche ${Math.round(a)} m² zu klein` }); continue; }
        let best = null;
        if (roads) for (const q of g) { const n = roads.nearest(q.lat, q.lon, G.zugangMaxM); if (n && (!best || n.d < best.d)) best = { d: n.d, q }; }
        if (roads && !best) { rejected.push({ id: `way/${el.id}`, why: `kein befahrbarer Weg innerhalb ${G.zugangMaxM} m` }); continue; }
        const q = best ? best.q : g[0];
        out.push({ id: `way/${el.id}`, lat: q.lat, lon: q.lon, kind: t.water ? `Gewässer (${t.water})` : "Gewässer", wasserTyp: "natural_water", areaM2: a, tags: t, source: "OSM", verified: false, zugang: best ? `Weg ${Math.round(best.d)} m` : "Zugang nicht geprüft (kein Wegenetz)" });
        continue;
      }
      if ((t.waterway === "stream" || t.waterway === "river") && el.type === "way" && el.geometry && roads) {
        const acc = [];
        const g = el.geometry.filter(Boolean);
        for (let q = 0; q + 1 < g.length; q++) {
          const n = Math.max(1, Math.ceil(distM(g[q], g[q + 1]) / 20));
          for (let s = 0; s <= n; s++) {
            const p = lerpLL(g[q], g[q + 1], s / n);
            const r = roads.nearest(p.lat, p.lon, G.zugangMaxM);
            if (r && !acc.some((x) => distM(x, p) < G.zugangAbstandM)) acc.push({ ...p, d: r.d });
          }
        }
        acc.forEach((p, k) => out.push({ id: `way/${el.id}#${k + 1}`, lat: p.lat, lon: p.lon, kind: t.waterway === "river" ? "Fluss" : "Bach", wasserTyp: t.waterway === "river" ? "waterway_river" : "waterway_stream", tags: t, source: "OSM", verified: false, zugang: `Weg ${Math.round(p.d)} m` }));
      }
    }
    return { points: out, rejected };
  }

  // ------------------------------------------------------------------ Fahrzeuge
  const up = (s) => String(s || "").toUpperCase();
  const startsWithAny = (typ, list) => list.some((t) => { const T = up(t); const x = up(typ); return x === T || x.startsWith(T + " ") || x.startsWith(T + "-") || x.startsWith(T + "(") || x.startsWith(T); });
  function vehicleClass(v, W) {
    const P = W.pendel, tank = num(v.tank_l) || 0;
    if (tank >= P.grosstankerMinL || startsWithAny(v.typ, P.grosstankerTypen)) return { stufe: 1, label: "Großtanker" };
    if (startsWithAny(v.typ, P.tlfTypen) || tank >= P.tlfMinL) return { stufe: 2, label: "Tanklöschfahrzeug" };
    return { stufe: 3, label: "Löschfahrzeug" };
  }
  const hasPump = (v) => (num(v.pumpe_lpm) || 0) > 0;

  /**
   * Prüft, welche Fahrzeuge für die Wasserversorgung eingeplant werden dürfen (Vorgabe Auftraggeber):
   * nicht Grundschutz, nicht Pflichtfahrzeuge, nicht Fahrzeuge der eigenen Kommune, nicht bereits an Riegel/Objektschutz,
   * nur wasserführend mit bekanntem Tank und bekannter Anfahrt bis pendel.maxAnfahrtMin.
   * @returns {eligible: [], excluded: [{id, label, reason}]}
   */
  function eligibleSupplyVehicles(vehicles, exclude, W) {
    const ex = exclude || {};
    const set = (a) => new Set((a || []).map(String));
    const gs = set(ex.grundschutzIds), pf = set(ex.pflichtIds), as = set(ex.assignedIds), ids = set(ex.ids);
    const own = up(W.fahrzeuge.ausschlussKommune);
    const eligible = [], excluded = [];
    for (const v of vehicles || []) {
      const id = String(v.id);
      const label = v.bezeichnung || v.typ || id;
      let reason = null;
      if (v.verfuegbar === false) reason = "nicht verfügbar";
      else if (gs.has(id)) reason = "Grundschutz an einem Gerätehaus";
      else if (pf.has(id) || v.pflicht === true) reason = "Pflichtfahrzeug (Riegel/Objektschutz)";
      else if (own && up(v.kommune) === own) reason = `Fahrzeug der eigenen Kommune (${W.fahrzeuge.ausschlussKommune})`;
      else if (as.has(id)) reason = "bereits Riegel/Objektschutz zugeordnet";
      else if (ids.has(id)) reason = "manuell ausgeschlossen";
      else if (W.fahrzeuge.keinWasserTypen.some((t) => up(v.typ) === up(t) || up(v.typ).startsWith(up(t) + " ") || up(v.typ).startsWith(up(t) + "-"))) reason = "kein Löschwasser (Fahrzeugtyp)";
      else if (!(num(v.tank_l) > 0)) reason = "Tankvolumen unbekannt oder 0";
      else if (num(v.anfahrtMin) === null) reason = "Anfahrt nicht schätzbar";
      else if (num(v.anfahrtMin) > W.pendel.maxAnfahrtMin) reason = `Anfahrt über ${W.pendel.maxAnfahrtMin} min`;
      if (reason) excluded.push({ id, label, reason });
      else eligible.push(v);
    }
    return { eligible, excluded };
  }

  // ------------------------------------------------------------------ Zeiten, Raten
  function fillRate(v, s, W) {
    const pump = hasPump(v) ? num(v.pumpe_lpm) : null;
    if (s.needsPump) return pump ? Math.min(pump * W.quellen.offen.saugFaktor, W.pendel.fuellMaxLpm) : 0;
    return Math.min(s.capLpm, pump ?? W.pendel.fuellOhnePumpeLpm, W.pendel.fuellMaxLpm);
  }
  const unloadRate = (v, W) => (hasPump(v) ? Math.min(W.pendel.entleerLpm, num(v.pumpe_lpm)) : W.pendel.entleerOhnePumpeLpm);

  /** Fahrzeit (min) zwischen zwei Orten {lat, lon, slowM}: Luftlinie x Umweg; Anteil Waldweg langsamer. */
  function driveMin(a, b, W) {
    const P = W.pendel;
    const d = distM(a, b) * P.umwegFaktor;
    const slow = Math.min(d, ((a.slowM || 0) + (b.slowM || 0)) * P.umwegFaktor);
    return ((slow / 1000) / P.kmhWaldweg + ((d - slow) / 1000) / P.kmhStrasse) * 60;
  }

  /**
   * Analytischer Pendelumlauf eines Fahrzeugs zwischen Entnahmestelle s und Becken b (ohne Warten).
   * Umlauf = Rüsten + Füllen (tank / Füllrate) + Fahrt beladen + Rüsten + Entleeren (tank / Entleerrate) + Rückfahrt.
   */
  function cycle(v, s, b, W) {
    const tank = num(v.tank_l);
    const fr = fillRate(v, s, W), ur = unloadRate(v, W);
    if (!(fr > 0)) return { ok: false, reason: s.needsPump ? "Fahrzeug ohne Pumpe kann aus offenem Gewässer nicht füllen" : "keine Füllrate" };
    const drive = driveMin(s, b, W);
    const fillMin = s.ruestMin + tank / fr;
    const unloadMin = W.pendel.entleerRuestMin + tank / ur;
    const cycleMin = fillMin + drive + unloadMin + drive;
    return { ok: true, driveMin: drive, fillMin, unloadMin, cycleMin, fillLpm: fr, unloadLpm: ur, lpm: tank / cycleMin, distM: distM(s, b) };
  }

  // ------------------------------------------------------------------ Förderstrecke
  function hoseProfile(s, b, terrain, W) {
    const S = W.schlauch;
    const luft = distM(s, b);
    if (!terrain || typeof terrain.elevation !== "function") return { luft, dhMax: 0, dhEnd: 0, z0: null, z1: null, ok: false };
    const n = Math.max(1, Math.ceil(luft / S.profilSchrittM));
    const z0 = terrain.elevation(s.lat, s.lon);
    if (z0 === null || z0 === undefined || Number.isNaN(z0)) return { luft, dhMax: 0, dhEnd: 0, z0: null, z1: null, ok: false };
    let dhMax = 0, z1 = z0, missing = 0;
    for (let k = 1; k <= n; k++) {
      const p = lerpLL(s, b, k / n);
      const z = terrain.elevation(p.lat, p.lon);
      if (z === null || z === undefined || Number.isNaN(z)) { missing++; continue; }
      dhMax = Math.max(dhMax, z - z0);
      if (k === n) z1 = z;
    }
    return { luft, dhMax, dhEnd: z1 - z0, z0, z1, ok: missing === 0 };
  }

  /**
   * Auslegung einer Schlauchleitung (B) von Entnahmestelle s zum Becken b für den Durchfluss qWanted.
   * Druckbedarf = Reibung (k x (Q/800)² je 100 m) x Länge + Höhe (höchster Punkt über der Entnahme) x 0,1 bar/m.
   * Je Pumpe nutzbar: Ausgangsdruck - Mindesteingangsdruck. pumpsAvail begrenzt die Pumpenzahl (sonst Q reduziert).
   */
  function hoseDesign(s, b, terrain, W, qWanted, pumpsAvail) {
    const S = W.schlauch;
    const pf = hoseProfile(s, b, terrain, W);
    const L = pf.luft * S.umwegFaktor;
    const usable = S.pumpenAusgangBar - S.eingangMinBar;
    const hBar = Math.max(0, pf.dhMax) * S.barJeMeterHoehe;
    const loss = (q) => S.reibungBarJe100mBei800 * (q / 800) ** 2 * (L / 100);
    let q = qWanted;
    let pumps = Math.max(1, Math.ceil((loss(q) + hBar) / usable - 1e-9));
    let reduced = false;
    const maxP = pumpsAvail === undefined ? Infinity : pumpsAvail;
    if (pumps > maxP) {
      reduced = true;
      pumps = maxP;
      const head = pumps * usable - hBar;
      q = head > 0 ? 800 * Math.sqrt(head / (S.reibungBarJe100mBei800 * (L / 100))) : 0;
      q = Math.min(q, qWanted);
    }
    const setupMin = S.aufbauGrundMin + (S.aufbauMinJe100m * L) / 100;
    // Pumpenstandorte: gleichmäßig entlang der Leitung (Näherung bei gleichmäßigem Druckverlust)
    const pumpPos = Array.from({ length: pumps }, (_, k) => lerpLL(s, b, k / pumps));
    return {
      lengthM: L, luftM: pf.luft, dhMaxM: pf.dhMax, dhEndM: pf.dhEnd, terrainOk: pf.ok, flowLpm: Math.max(0, q), wantedLpm: qWanted,
      pumps, boosters: pumps - 1, lossBar: loss(Math.max(q, 1)), heightBar: hBar, usableBar: usable, setupMin, reduced, pumpPos,
      feasible: q >= 100,
    };
  }

  // ------------------------------------------------------------------ Becken: Standortwahl
  function siteSafety(lat, lon, hazard, W, horizonMin, latestStart) {
    if (!hazard || typeof hazard.possibleMinAt !== "function") return { level: 0, text: "keine Prognose: Sicherheit nicht geprüft", untilMin: null };
    const B = W.becken;
    const pts = [{ lat, lon }];
    const pr = makeProj(lat, lon);
    for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; const [la, lo] = pr.toLL(Math.cos(a) * B.sicherheitM, Math.sin(a) * B.sicherheitM); pts.push({ lat: la, lon: lo }); }
    let tmin = Infinity;
    for (const p of pts) tmin = Math.min(tmin, hazard.possibleMinAt(p.lat, p.lon));
    if (tmin > horizonMin) return { level: 1, text: `außerhalb der „möglich“-Zone bis Ende des Prognosezeitraums (${horizonMin / 60} h), Abstand ≥ ${B.sicherheitM} m`, untilMin: Infinity };
    if (tmin >= latestStart + B.ersatzVorlaufMin) return { level: 2, text: `ACHTUNG: „möglich“-Zone erreicht den Standort (± ${B.sicherheitM} m) nach ca. ${Math.round(tmin)} min – nur bis dahin nutzbar, Räumung einplanen`, untilMin: tmin };
    return { level: 3, text: `UNSICHER: „möglich“-Zone nach ca. ${Math.round(tmin)} min am Standort`, untilMin: tmin };
  }

  function clusterConsumers(cons, W) {
    const n = cons.length, parent = cons.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (distM(cons[i], cons[j]) <= W.becken.clusterM) parent[find(j)] = find(i);
    const groups = new Map();
    cons.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
    return [...groups.values()];
  }

  function autoBasins(cons, input, W, notes) {
    const B = W.becken;
    const center = input.hazard && input.hazard.center ? input.hazard.center : null;
    const latestStart = Math.max(0, ...cons.map((c) => c.readyMin));
    const basins = [];
    clusterConsumers(cons, W).forEach((grp, gi) => {
      const lat = grp.reduce((s, c) => s + c.lat, 0) / grp.length, lon = grp.reduce((s, c) => s + c.lon, 0) / grp.length;
      const D = grp.reduce((s, c) => s + c.demandLpm, 0);
      const extra = (input.basinExtra && input.basinExtra[gi + 1]) || 0;
      const nB = Math.max(1, Math.min(B.maxJeGruppe, Math.ceil(D / B.bedarfJeBeckenLpm - 1e-9) + extra));
      // Zielpunkt: vom Brand weg hinter den Abnehmern
      const pr = makeProj(lat, lon);
      let tx = 0, ty = 0;
      if (center) { const [fx, fy] = pr.toXY(center.lat, center.lon); const d = Math.hypot(fx, fy) || 1; tx = (-fx / d) * B.abstandHinterAbnehmerM; ty = (-fy / d) * B.abstandHinterAbnehmerM; }
      const [tLat, tLon] = pr.toLL(tx, ty);
      const target = { lat: tLat, lon: tLon };
      let cands = [];
      if (input.roads) cands = input.roads.near(lat, lon, B.suchRadiusM).map(({ p }) => ({ lat: p.lat, lon: p.lon, kind: p.kind }));
      if (!cands.length) { // ohne Wegenetz: Zielpunkt und Raster im Abstand versatzM (Befahrbarkeit nicht geprüft)
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const [la, lo] = pr.toLL(tx + dx * B.versatzM, ty + dy * B.versatzM); cands.push({ lat: la, lon: lo, kind: 0 }); }
      }
      const scored = cands.map((c, k) => {
        const s = siteSafety(c.lat, c.lon, input.hazard, W, W.horizonMin, latestStart);
        return { ...c, k, safety: s, score: distM(c, target) + (c.kind === 2 ? B.waldwegStrafM : 0) + (s.level === 2 ? 1e5 : s.level === 3 ? 1e7 : 0) };
      }).sort((a, b) => a.score - b.score || a.k - b.k);
      const chosen = [];
      for (const c of scored) {
        if (chosen.length >= nB) break;
        if (chosen.some((x) => distM(x, c) < B.versatzM)) continue;
        if (chosen.length && distM(chosen[0], c) > 150) continue; // Becken einer Gruppe nahe beieinander
        chosen.push(c);
      }
      chosen.forEach((c, k) => basins.push({ id: `B${basins.length + 1}`, lat: c.lat, lon: c.lon, group: gi + 1, groupExtra: extra, manual: false, roadKind: c.kind, safety: c.safety, siteNote: c.kind === 0 ? "kein Wegenetz: Befahrbarkeit nicht geprüft" : c.kind === 2 ? "an Wald-/Wirtschaftsweg: Befahrbarkeit prüfen" : "an Straße (Daten ungeprüft)" }));
      if (chosen.length < nB) notes.push(`Beckengruppe ${gi + 1}: nur ${chosen.length} statt ${nB} Standorte gefunden.`);
    });
    return basins;
  }

  // ------------------------------------------------------------------ Planung
  function consumerDemand(c, W) {
    if (num(c.demandLpm) !== null) return num(c.demandLpm);
    const Bd = W.bedarf;
    if (c.mode === "wenderohr") return Bd.wenderohrLpm * Bd.einsatzAnteil;
    const k = c.kind === "Objektschutz" ? Bd.objektschutz : Bd.riegel;
    return k.rohre * k.lpmJeRohr * Bd.einsatzAnteil;
  }

  function planSupply(input) {
    const W = input.W;
    const notes = [], warnings = [];
    const consumers = (input.consumers || []).map((c, i) => ({
      id: String(c.id ?? `A${i + 1}`), label: c.label || String(c.id), lat: Number(c.lat), lon: Number(c.lon), kind: c.kind || "Riegel", mode: c.mode || null,
      readyMin: Math.max(0, num(c.readyMin) ?? 0), tankL: Math.max(0, num(c.tankL) ?? 0), demandLpm: consumerDemand(c, W),
    }));
    // Entnahmestellen
    const allSources = (input.sources || []).filter((p) => !p.deleted).map((p) => classifySource(p, W));
    const sources = allSources.filter((s) => s.usable);
    for (const s of allSources) if (!s.usable) notes.push(`Entnahmestelle ${s.id} nicht berücksichtigt: ${s.why}.`);
    // Fahrzeuge
    const el = eligibleSupplyVehicles(input.vehicles, input.exclude, W);
    const veh = el.eligible.map((v) => ({ v, id: String(v.id), cls: vehicleClass(v, W), pump: hasPump(v), anf: num(v.anfahrtMin) }));
    // Becken
    const manual = Array.isArray(input.basins);
    const basins = manual
      ? input.basins.map((b, i) => {
        const latestStart = Math.max(0, ...consumers.map((c) => c.readyMin));
        const near = input.roads ? input.roads.nearest(b.lat, b.lon, 50) : null;
        return { id: String(b.id || `B${i + 1}`), lat: Number(b.lat), lon: Number(b.lon), group: null, manual: true, roadKind: near ? near.p.kind : 0, safety: siteSafety(b.lat, b.lon, input.hazard, W, W.horizonMin, latestStart), siteNote: input.roads ? (near ? (near.p.kind === 2 ? "manuell, an Wald-/Wirtschaftsweg" : "manuell, an Straße") : "manuell, KEIN befahrbarer Weg innerhalb 50 m") : "manuell, Befahrbarkeit nicht geprüft" };
      })
      : autoBasins(consumers, input, W, notes);
    for (const b of basins) {
      b.slowM = input.roads ? input.roads.slowDistM(b.lat, b.lon) : 0;
      b.consumerIds = []; b.demandLpm = 0; b.reserve = false;
      if (b.safety && b.safety.level >= 2) warnings.push(`Becken ${b.id}: ${b.safety.text}.`);
    }
    for (const s of sources) s.slowM = input.roads ? input.roads.slowDistM(s.lat, s.lon) : 0;
    // Abnehmer -> nächstes Becken (bei gleich nahen Becken das mit dem geringsten Bedarf)
    for (const c of consumers) {
      if (!basins.length) { c.basinId = null; continue; }
      const ds = basins.map((b) => distM(b, c));
      const dmin = Math.min(...ds);
      let best = null;
      basins.forEach((b, k) => { if (ds[k] <= dmin + 30 && (!best || b.demandLpm < best.demandLpm)) best = b; });
      c.basinId = best.id; c.basinDistM = distM(best, c);
      best.consumerIds.push(c.id); best.demandLpm += c.demandLpm;
      if (c.basinDistM > W.bedarf.maxAbstandBeckenM) warnings.push(`${c.label}: Becken ${best.id} ist ${Math.round(c.basinDistM)} m entfernt (> ${W.bedarf.maxAbstandBeckenM} m, Annahme).`);
    }
    if (!basins.length && consumers.length) warnings.push("Kein Becken: Abnehmer nur aus dem eigenen Tank.");

    // ---------------- Versorgungsart je Becken: Schlauchleitung bis maxSchlauchwegM, sonst Pendelverkehr
    const used = new Set();
    const pumpPool = veh.filter((x) => x.pump && x.cls.stufe >= 2).sort((a, b) => b.cls.stufe - a.cls.stufe || a.anf - b.anf || (a.id < b.id ? -1 : 1));
    const takePump = () => { const x = pumpPool.find((p) => !used.has(p.id)); if (x) used.add(x.id); return x || null; };
    const roles = new Map(); // id -> {role, basinId, at}
    const sortedBasins = [...basins].sort((a, b) => b.demandLpm - a.demandLpm || (a.id < b.id ? -1 : 1));
    const hoseUseAtSource = new Map();
    for (const b of sortedBasins) {
      b.supply = { kind: "pendel", hose: null, sourceId: null };
      // Becken ohne zugeordneten Abnehmer: Die Dimensionierungsregel (Bedarf / bedarfJeBeckenLpm) kann mehr
      // Becken erzeugen, als die Zuordnung "Abnehmer -> nächstes Becken" nutzt. Solche Becken werden NICHT
      // stillschweigend eingeplant, sondern als Reservestandort gekennzeichnet (kein Bedarf, keine Versorgung,
      // keine Pendelfahrzeuge). Ob sie aufgebaut werden, entscheidet die Einsatzleitung (siehe ASSUMPTIONS).
      if (!b.demandLpm) { b.supply.kind = "keine"; b.reserve = true; continue; }
      const cands = sources.map((s) => ({ s, L: distM(s, b) * W.schlauch.umwegFaktor })).filter((x) => x.L <= W.schlauch.maxSchlauchwegM)
        .map((x) => {
          const capFree = (x.s.capLpm ?? Infinity) - (hoseUseAtSource.get(x.s.id) || 0);
          const pumpCap = 2000; // grobe Obergrenze; Fahrzeugpumpe wird unten berücksichtigt
          const qWanted = Math.min(capFree, W.schlauch.maxLeitungLpm, pumpCap, Math.max(400, Math.ceil(b.demandLpm * W.schlauch.bedarfsReserve)));
          return { ...x, qWanted, pref: (x.s.status === "unsicher" ? 1 : 0) + (x.s.typ === "behaelter" ? 0.5 : 0) };
        })
        .filter((x) => x.qWanted >= 100)
        .sort((a, b2) => a.pref - b2.pref || b2.qWanted - a.qWanted || a.L - b2.L || (a.s.id < b2.s.id ? -1 : 1));
      if (!cands.length) continue;
      const c = cands[0];
      const freePumps = pumpPool.filter((p) => !used.has(p.id)).length;
      if (!freePumps) { warnings.push(`Becken ${b.id}: Entnahmestelle ${c.s.label} (${Math.round(c.L)} m Schlauchweg) in Reichweite, aber kein Fahrzeug mit Pumpe frei – Pendelverkehr.`); continue; }
      let h = hoseDesign(c.s, b, input.terrain, W, c.qWanted, freePumps);
      if (!h.feasible) { warnings.push(`Becken ${b.id}: Förderstrecke von ${c.s.label} nicht möglich (Höhe ${Math.round(h.dhMaxM)} m, Pumpen ${freePumps}) – Pendelverkehr.`); continue; }
      const pumps = [];
      for (let k = 0; k < h.pumps; k++) pumps.push(takePump());
      // Fahrzeugpumpe begrenzt den Förderstrom
      const pmin = Math.min(...pumps.map((p) => num(p.v.pumpe_lpm)));
      if (pmin < h.flowLpm) h = Object.assign(h, { flowLpm: pmin, pumpLimited: true });
      pumps.forEach((p, k) => roles.set(p.id, { role: k === 0 ? "pumpe" : "verstaerker", basinId: b.id, sourceId: c.s.id, at: h.pumpPos[k] }));
      b.supply = { kind: "schlauch", sourceId: c.s.id, hose: h, pumpIds: pumps.map((p) => p.id) };
      hoseUseAtSource.set(c.s.id, (hoseUseAtSource.get(c.s.id) || 0) + h.flowLpm);
      if (!h.terrainOk) notes.push(`Becken ${b.id}: Höhenunterschied der Förderstrecke ohne vollständiges DGM nicht geprüft.`);
      if (h.reduced) warnings.push(`Becken ${b.id}: Förderstrecke liefert nur ca. ${Math.round(h.flowLpm)} l/min (zu wenige Pumpen für ${Math.round(h.wantedLpm)} l/min).`);
    }
    const reserveBasins = basins.filter((b) => b.reserve);
    if (reserveBasins.length) notes.push(`${reserveBasins.length} Becken ohne Abnehmer (${reserveBasins.map((b) => b.id).join(", ")}): als Reservestandort gekennzeichnet, nicht eingeplant (keine Versorgung, keine Pendelfahrzeuge). Die Dimensionierung je Beckengruppe (Bedarf / ${W.becken.bedarfJeBeckenLpm} l/min, Annahme) kann mehr Becken erzeugen, als die Zuordnung der Abnehmer nutzt. Aufbau entscheidet die Einsatzleitung.`);
    for (const b of basins) {
      const q = b.supply.kind === "schlauch" ? b.supply.hose.flowLpm : 0;
      b.shuttleTarget = b.supply.kind !== "keine" && q < b.demandLpm - 1e-9;
      b.shuttleNeedLpm = b.shuttleTarget ? b.demandLpm - q : 0;
      if (b.supply.kind === "schlauch" && b.shuttleTarget) b.supply.kind = "schlauch+pendel";
    }

    // ---------------- Pendelfahrzeuge: Großtanker zuerst, dann TLF, dann sonstige; innerhalb nach Lieferrate
    const targets = basins.filter((b) => b.shuttleTarget);
    const need = targets.reduce((s, b) => s + b.shuttleNeedLpm, 0) * W.pendel.reserveFaktor;
    const main = targets.slice().sort((a, b) => b.shuttleNeedLpm - a.shuttleNeedLpm)[0] || null;
    const est = (x) => {
      if (!main) return null;
      let best = null;
      for (const s of sources) {
        if (distM(s, main) > W.quellen.maxPendelM) continue;
        const c = cycle(x.v, s, main, W);
        if (c.ok && (!best || c.lpm > best.lpm)) best = { ...c, sourceId: s.id, sourceLabel: s.label };
      }
      return best;
    };
    const cand = veh.filter((x) => !used.has(x.id)).map((x) => ({ ...x, est: est(x) })).filter((x) => x.est);
    cand.sort((a, b) => a.cls.stufe - b.cls.stufe || b.est.lpm - a.est.lpm || a.anf - b.anf || (a.id < b.id ? -1 : 1));
    let sum = 0, nSh = 0;
    const extra = input.extraShuttle || 0;
    let extraLeft = extra;
    for (const x of cand) {
      if (!targets.length) break;
      if (sum >= need && extraLeft <= 0) break;
      if (sum >= need) extraLeft--;
      used.add(x.id); sum += x.est.lpm; nSh++;
      roles.set(x.id, { role: "pendel", est: x.est });
    }
    if (targets.length && !sources.length) warnings.push("Keine Entnahmestelle in den Daten: Pendelverkehr nicht möglich.");
    else if (targets.length && sum < need / W.pendel.reserveFaktor) warnings.push(`Pendelverkehr: geschätzte Lieferung ${Math.round(sum)} l/min < Bedarf ${Math.round(need / W.pendel.reserveFaktor)} l/min (zu wenige geeignete Fahrzeuge).`);

    const vehicles = veh.map((x) => {
      const r = roles.get(x.id) || { role: "reserve" };
      const cyc = r.role === "pendel" ? r.est : null;
      return {
        id: x.id, label: x.v.bezeichnung || x.v.typ || x.id, typ: x.v.typ, kommune: x.v.kommune || null, tankL: num(x.v.tank_l), pumpLpm: num(x.v.pumpe_lpm),
        cls: x.cls, anfahrtMin: x.anf, origin: num(x.v.originLat) !== null && num(x.v.originLon) !== null ? { lat: num(x.v.originLat), lon: num(x.v.originLon) } : null,
        role: r.role, basinId: r.basinId || null, sourceId: r.sourceId || null, at: r.at || null, estimate: cyc,
        annahmen: x.v.annahmen || [], anfahrtText: x.v.anfahrtText || null,
      };
    });
    const order = { pumpe: 0, verstaerker: 1, pendel: 2, reserve: 3 };
    vehicles.sort((a, b) => order[a.role] - order[b.role] || a.cls.stufe - b.cls.stufe || a.anfahrtMin - b.anfahrtMin || (a.id < b.id ? -1 : 1));
    return {
      version: W.version, W, consumers, basins, sources, sourcesRejected: allSources.filter((s) => !s.usable), vehicles, excluded: el.excluded,
      notes, warnings, manualBasins: manual, shuttleNeedLpm: need / W.pendel.reserveFaktor, shuttleEstLpm: sum, extraShuttle: extra,
      reserveCount: vehicles.filter((v) => v.role === "reserve").length,
    };
  }

  // ------------------------------------------------------------------ Simulation
  function simulate(plan) {
    const W = plan.W, dt = W.dtMin, T = W.horizonMin, N = Math.round(T / dt);
    const B = plan.basins.map((b) => ({
      b, level: 0, cap: W.becken.volumenL, readyMin: Infinity, active: [], queue: [], committed: 0,
      s_level: new Float64Array(N + 1), s_in: new Float64Array(N), s_inHose: new Float64Array(N), s_out: new Float64Array(N), s_dem: new Float64Array(N),
      firstFill: null, firstEmpty: null, waitMin: 0, throttledL: 0,
    }));
    const bIdx = new Map(B.map((x, i) => [x.b.id, i]));
    const Sx = plan.sources.map((s) => ({
      s, vol: s.volumeL, fillers: [], queue: [], pending: 0, hoseLpm: 0, usedL: 0, busyMin: 0, waitMin: 0, fills: 0, maxQueue: 0, firstUse: null, depletedAt: null, capStep: 0,
    }));
    const sIdx = new Map(Sx.map((x, i) => [x.s.id, i]));
    const C = plan.consumers.map((c) => ({ c, tank: c.tankL, bi: c.basinId !== null && c.basinId !== undefined ? bIdx.get(c.basinId) : -1, servedL: 0, fromBasinL: 0, fromTankL: 0, unmetL: 0, firstDry: null, s_unmet: new Float64Array(N) }));
    const hoses = [];
    // Bereitschaft der Becken: erstes Eintreffen eines zugeordneten Versorgungsfahrzeugs + Aufbau
    const vehById = new Map(plan.vehicles.map((v) => [v.id, v]));
    for (const x of B) {
      const sup = x.b.supply || { kind: "keine" };
      if (sup.pumpIds && sup.pumpIds.length) {
        const arr = Math.max(...sup.pumpIds.map((id) => vehById.get(id).anfahrtMin));
        const h = sup.hose;
        hoses.push({ bi: bIdx.get(x.b.id), si: sIdx.get(sup.sourceId), q: h.flowLpm, start: arr + h.setupMin });
        x.readyMin = Math.min(x.readyMin, Math.min(...sup.pumpIds.map((id) => vehById.get(id).anfahrtMin)) + W.becken.aufbauMin);
      }
    }
    for (const h of hoses) Sx[h.si].hoseLpm += h.q;
    const shuttleTargets = B.map((x, i) => i).filter((i) => B[i].b.shuttleTarget);
    const shuttle = plan.vehicles.filter((v) => v.role === "pendel");
    const firstShuttle = shuttle.length ? Math.min(...shuttle.map((v) => v.anfahrtMin)) : Infinity;
    for (const i of shuttleTargets) B[i].readyMin = Math.min(B[i].readyMin, firstShuttle + W.becken.aufbauMin);

    // Fahrzeuge
    const V = plan.vehicles.map((v, idx) => {
      const o = {
        v, idx, state: "reserve", timer: 0, timerTotal: 0, from: null, to: null, pos: null, load: 0, ruest: 0, stuck: 0,
        target: null, // {t: "s"|"b", i}
        s_state: new Uint8Array(N + 1), s_lat: new Float64Array(N + 1).fill(NaN), s_lon: new Float64Array(N + 1).fill(NaN), s_load: new Float64Array(N + 1),
        stateMin: Object.fromEntries(STATES.map((s) => [s, 0])), deliveredL: 0, cycles: 0, waitSrcMin: 0, waitBasinMin: 0, alloc: 0, flowState: null,
        unloadRate: unloadRate({ pumpe_lpm: v.pumpLpm }, W),
      };
      return o;
    });
    const vehPlace = (x) => (x.target && x.target.t === "s" ? Sx[x.target.i].s : x.target && x.target.t === "b" ? B[x.target.i].b : null);
    const fr = (x, si) => fillRate({ pumpe_lpm: x.v.pumpLpm }, Sx[si].s, W);
    const availCapLpm = (si) => (Sx[si].s.capLpm === null ? Infinity : Math.max(0, Sx[si].s.capLpm - Sx[si].hoseLpm));

    function demandAt(bi, t) { let d = 0; for (const c of C) if (c.bi === bi && t >= c.c.readyMin) d += c.c.demandLpm; return d; }
    function hoseQ(bi, t) { let q = 0; for (const h of hoses) if (h.bi === bi && t >= h.start) q += h.q; return q; }

    function chooseBasin(x, from, t) {
      let best = -1, bestScore = Infinity;
      for (const i of shuttleTargets) {
        const travel = driveMin(from, B[i].b, W);
        const ta = t + travel;
        const net = demandAt(i, ta) - hoseQ(i, ta);
        const proj = B[i].level + B[i].committed - Math.max(0, net) * travel;
        const score = proj + travel * 10; // Liter; Fahrzeit leicht gewichtet
        if (score < bestScore - 1e-9) { bestScore = score; best = i; }
      }
      return best;
    }
    function chooseSource(x, from, t) {
      let best = -1, bestScore = Infinity;
      const refB = shuttleTargets.length ? B[shuttleTargets[0]].b : from;
      for (let si = 0; si < Sx.length; si++) {
        const S = Sx[si];
        if (S.vol <= 1) continue;
        const rate = Math.min(fr(x, si), availCapLpm(si));
        if (!(rate > 0)) continue;
        if (distM(S.s, refB) > W.quellen.maxPendelM) continue;
        const toS = driveMin(from, S.s, W);
        const wait = S.pending / Math.max(1, S.s.maxConcurrent);
        const fillMin = S.s.ruestMin + (x.v.tankL - x.load) / rate;
        let back = Infinity;
        for (const i of shuttleTargets) back = Math.min(back, driveMin(S.s, B[i].b, W));
        if (!Number.isFinite(back)) back = 0;
        const pen = S.s.status === "unsicher" ? W.quellen.offen.unsicherStrafMin : 0;
        const score = toS + Math.max(0, wait - toS) + fillMin + back + pen;
        if (score < bestScore - 1e-9) { bestScore = score; best = si; }
      }
      return best;
    }
    function expFill(x, si) { const rate = Math.min(fr(x, si), availCapLpm(si)) || 1; return Sx[si].s.ruestMin + (x.v.tankL - x.load) / rate; }

    function startDrive(x, from, to, state, total) {
      x.state = state; x.from = { lat: from.lat, lon: from.lon }; x.to = { lat: to.lat, lon: to.lon };
      x.timer = total; x.timerTotal = total;
    }
    function goToSource(x, from, t) {
      const si = chooseSource(x, from, t);
      if (si < 0) { x.state = "warten_becken"; x.target = null; x.idle = true; return; }
      x.target = { t: "s", i: si }; x.pendingAdd = expFill(x, si); Sx[si].pending += x.pendingAdd;
      startDrive(x, from, Sx[si].s, "rueckfahrt", driveMin(from, Sx[si].s, W));
    }
    function goToBasin(x, from, t) {
      const bi = chooseBasin(x, from, t);
      if (bi < 0) { x.state = "warten_quelle"; x.idle = true; return; }
      x.target = { t: "b", i: bi }; B[bi].committed += x.load;
      startDrive(x, from, B[bi].b, "fahrt_beladen", driveMin(from, B[bi].b, W));
    }
    function arrive(x, t) {
      const tg = x.target;
      if (!tg) return;
      if (tg.t === "b") {
        const Bb = B[tg.i];
        x.pos = { lat: Bb.b.lat, lon: Bb.b.lon };
        if (Bb.active.length < W.becken.maxEntleerer && t >= Bb.readyMin) { Bb.active.push(x.idx); x.state = "entleeren"; x.ruest = W.pendel.entleerRuestMin; x.stuck = 0; }
        else { Bb.queue.push(x.idx); x.state = "warten_becken"; }
      } else {
        const S = Sx[tg.i];
        x.pos = { lat: S.s.lat, lon: S.s.lon };
        if (S.fillers.length < S.s.maxConcurrent) { S.fillers.push(x.idx); x.state = "fuellen"; x.ruest = S.s.ruestMin; S.fills++; }
        else { S.queue.push(x.idx); x.state = "warten_quelle"; }
      }
    }
    // Startzustand
    for (const x of V) {
      const v = x.v;
      if (v.role === "reserve") continue;
      let dest;
      if (v.role === "pumpe" || v.role === "verstaerker") dest = v.at;
      else {
        x.load = W.pendel.anfahrtVoll ? v.tankL : 0;
        if (x.load > 0) {
          const bi = chooseBasin(x, shuttleTargets.length ? B[shuttleTargets[0]].b : { lat: 0, lon: 0 }, v.anfahrtMin);
          if (bi < 0) { x.state = "reserve"; continue; }
          x.target = { t: "b", i: bi }; B[bi].committed += x.load; dest = B[bi].b;
        } else {
          const ref = shuttleTargets.length ? B[shuttleTargets[0]].b : null;
          const si = ref ? chooseSource(x, ref, v.anfahrtMin) : -1;
          if (si < 0) { x.state = "reserve"; continue; }
          x.target = { t: "s", i: si }; x.pendingAdd = expFill(x, si); Sx[si].pending += x.pendingAdd; dest = Sx[si].s;
        }
      }
      startDrive(x, v.origin || dest, dest, "anfahrt", v.anfahrtMin);
      x.hidden = !v.origin;
    }

    const record = (k) => {
      for (const x of B) x.s_level[k] = x.level;
      for (const x of V) {
        let st = x.state;
        if (st === "entleeren" && x.flowState === "voll") st = "warten_becken";
        x.s_state[k] = SI[st];
        let p = null;
        if (x.state === "reserve") p = null;
        else if (x.from && x.to && (x.state === "anfahrt" || x.state === "rueckfahrt" || x.state === "fahrt_beladen")) {
          if (x.state === "anfahrt" && x.hidden) p = null;
          else p = lerpLL(x.from, x.to, x.timerTotal > 0 ? 1 - x.timer / x.timerTotal : 1);
        } else p = x.pos;
        if (p) { x.s_lat[k] = p.lat; x.s_lon[k] = p.lon; }
        x.s_load[k] = x.load;
      }
    };
    record(0);

    for (let k = 0; k < N; k++) {
      const t = k * dt;
      // 1) Warteschlangen nachrücken
      for (const Bb of B) {
        if (t < Bb.readyMin) continue;
        while (Bb.active.length < W.becken.maxEntleerer && Bb.queue.length) {
          const x = V[Bb.queue.shift()]; Bb.active.push(x.idx); x.state = "entleeren"; x.ruest = W.pendel.entleerRuestMin; x.stuck = 0;
        }
      }
      for (const S of Sx) {
        while (S.fillers.length < S.s.maxConcurrent && S.queue.length && S.vol > 1) {
          const x = V[S.queue.shift()]; S.fillers.push(x.idx); x.state = "fuellen"; x.ruest = S.s.ruestMin; S.fills++;
        }
        S.maxQueue = Math.max(S.maxQueue, S.queue.length);
      }
      // 2) Abnehmer: Becken anteilig, Rest aus eigenem Tank; Nachfüllen des Tanks bei vollem Becken
      const needB = new Float64Array(B.length);
      for (const c of C) if (t >= c.c.readyMin && c.bi >= 0) needB[c.bi] += c.c.demandLpm * dt;
      const fracB = B.map((Bb, i) => (needB[i] > 0 && t >= Bb.readyMin ? Math.min(1, Bb.level / needB[i]) : 0));
      for (const c of C) {
        if (t < c.c.readyMin) continue;
        const need = c.c.demandLpm * dt;
        let fromB = 0;
        if (c.bi >= 0) { fromB = need * fracB[c.bi]; B[c.bi].level -= fromB; B[c.bi].s_out[k] += fromB / dt; B[c.bi].s_dem[k] += c.c.demandLpm; }
        const fromT = Math.min(need - fromB, c.tank);
        c.tank -= fromT;
        const unmet = need - fromB - fromT;
        c.fromBasinL += fromB; c.fromTankL += fromT; c.servedL += fromB + fromT; c.unmetL += unmet; c.s_unmet[k] = unmet / dt;
        if (unmet > 1e-6 && c.firstDry === null) c.firstDry = t;
      }
      for (const c of C) {
        if (c.bi < 0 || t < c.c.readyMin) continue;
        const Bb = B[c.bi];
        if (t < Bb.readyMin || Bb.level < Bb.cap * W.bedarf.tankNachfuellAbFuellstand) continue;
        const r = Math.min(W.bedarf.tankNachfuellLpm * dt, c.c.tankL - c.tank, Bb.level - Bb.cap * W.bedarf.tankNachfuellAbFuellstand);
        if (r > 0) { c.tank += r; Bb.level -= r; Bb.s_out[k] += r / dt; }
      }
      for (const Bb of B) if (Bb.level < 1e-9) Bb.level = 0;
      // 3) Förderstrecken (Vorrang an der Entnahmestelle)
      for (const S of Sx) S.capStep = S.s.capLpm === null ? Infinity : S.s.capLpm * dt;
      for (const h of hoses) {
        if (t < h.start) continue;
        const Bb = B[h.bi], S = Sx[h.si];
        const space = Bb.cap - Bb.level;
        const want = h.q * dt;
        const q = Math.max(0, Math.min(want, space, S.capStep, S.vol));
        Bb.throttledL += want - q;
        Bb.level += q; Bb.s_in[k] += q / dt; Bb.s_inHose[k] += q / dt;
        S.capStep -= q; S.vol -= q; S.usedL += q;
        if (q > 0 && S.firstUse === null) S.firstUse = t;
      }
      // 4) Zuteilung der Entnahmeleistung an füllende Fahrzeuge (FIFO)
      for (const S of Sx) {
        let rem = S.capStep;
        for (const xi of S.fillers) {
          const x = V[xi];
          const tl = Math.max(0, dt - x.ruest);
          const want = Math.min(fr(x, sIdx.get(S.s.id)) * tl, x.v.tankL - x.load);
          const a = Math.max(0, Math.min(want, rem, S.vol));
          x.alloc = a; rem -= a;
        }
      }
      // 5) Fahrzeuge
      for (const x of V) {
        let budget = dt;
        x.flowState = null;
        let guard = 0;
        while (budget > 1e-9 && guard++ < 20) {
          const tNow = t + (dt - budget);
          if (x.state === "reserve" || x.state === "pumpen") { break; }
          if (x.idle) { // ohne Ziel: erneut versuchen
            x.idle = false;
            const here = x.pos || x.to;
            if (x.load > 0.5 * x.v.tankL) goToBasin(x, here, tNow); else goToSource(x, here, tNow);
            if (x.idle) { const ws = x.load > 0.5 * x.v.tankL ? "warten_becken" : "warten_quelle"; x.state = ws; x.stateMin[ws] += budget; budget = 0; break; }
            continue;
          }
          if (x.state === "anfahrt" || x.state === "rueckfahrt" || x.state === "fahrt_beladen") {
            const use = Math.min(budget, x.timer);
            x.timer -= use; budget -= use; x.stateMin[x.state] += use;
            if (x.timer <= 1e-9) {
              x.hidden = false;
              if (x.v.role === "pumpe" || x.v.role === "verstaerker") { x.state = "pumpen"; x.pos = { ...x.to }; x.stateMin.pumpen += budget; budget = 0; break; }
              arrive(x, tNow + use);
            }
            continue;
          }
          if (x.state === "warten_quelle") { x.stateMin.warten_quelle += budget; x.waitSrcMin += budget; if (x.target && x.target.t === "s") Sx[x.target.i].waitMin += budget; budget = 0; break; }
          if (x.state === "warten_becken") { x.stateMin.warten_becken += budget; x.waitBasinMin += budget; if (x.target && x.target.t === "b") B[x.target.i].waitMin += budget; budget = 0; break; }
          if (x.state === "fuellen") {
            const si = x.target.i, S = Sx[si];
            if (x.ruest > 1e-9) { const use = Math.min(budget, x.ruest); x.ruest -= use; budget -= use; x.stateMin.fuellen += use; continue; }
            const rate = fr(x, si);
            const want = Math.min(rate * budget, x.v.tankL - x.load);
            const a = Math.max(0, Math.min(want, x.alloc, S.vol));
            x.alloc -= a; x.load += a; S.vol -= a; S.usedL += a;
            if (a > 0 && S.firstUse === null) S.firstUse = tNow;
            if (S.vol <= 1 && S.depletedAt === null) S.depletedAt = tNow;
            const full = x.v.tankL - x.load < 1e-6;
            const timeUsed = full ? Math.min(budget, a / rate) : budget;
            budget -= timeUsed; x.stateMin.fuellen += timeUsed;
            if (full || (S.vol <= 1)) {
              S.fillers = S.fillers.filter((i) => i !== x.idx); S.pending = Math.max(0, S.pending - (x.pendingAdd || 0)); x.pendingAdd = 0;
              if (x.load >= 0.3 * x.v.tankL) goToBasin(x, S.s, t + (dt - budget));
              else goToSource(x, S.s, t + (dt - budget));
            }
            continue;
          }
          if (x.state === "entleeren") {
            const bi = x.target.i, Bb = B[bi];
            if (x.ruest > 1e-9) { const use = Math.min(budget, x.ruest); x.ruest -= use; budget -= use; x.stateMin.entleeren += use; continue; }
            const possible = x.unloadRate * budget;
            const space = Math.max(0, Bb.cap - Bb.level);
            const a = Math.min(possible, x.load, space);
            x.load -= a; Bb.level += a; Bb.committed -= a; Bb.s_in[k] += a / dt; x.deliveredL += a;
            if (Bb.firstFill === null && a > 0) Bb.firstFill = t;
            if (x.load < 1e-6) {
              const timeUsed = Math.min(budget, a / x.unloadRate);
              budget -= timeUsed; x.stateMin.entleeren += timeUsed; x.load = 0; x.cycles++;
              Bb.committed = Math.max(0, Bb.committed);
              Bb.active = Bb.active.filter((i) => i !== x.idx);
              goToSource(x, Bb.b, t + (dt - budget));
              continue;
            }
            // Becken voll: warten (gedrosselt) oder zu einem anderen Becken mit Platz
            const frac = possible > 0 ? 1 - a / possible : 1;
            x.stuck += budget * frac;
            x.stateMin[frac > 0.5 ? "warten_becken" : "entleeren"] += budget; if (frac > 0.5) { x.flowState = "voll"; x.waitBasinMin += budget * frac; Bb.waitMin += budget * frac; }
            budget = 0;
            if (x.stuck >= W.pendel.beckenwechselNachMin) {
              const alt = shuttleTargets.filter((i) => i !== bi && B[i].cap - B[i].level - B[i].committed >= Math.min(x.load, 2000) && t >= B[i].readyMin)
                .sort((i, j) => driveMin(Bb.b, B[i].b, W) - driveMin(Bb.b, B[j].b, W) || i - j)[0];
              if (alt !== undefined) {
                Bb.active = Bb.active.filter((i) => i !== x.idx); Bb.committed = Math.max(0, Bb.committed - x.load);
                x.target = { t: "b", i: alt }; B[alt].committed += x.load; x.stuck = 0;
                startDrive(x, Bb.b, B[alt].b, "fahrt_beladen", driveMin(Bb.b, B[alt].b, W));
              }
            }
            continue;
          }
          break;
        }
        if (x.state === "pumpen" && budget > 1e-9) x.stateMin.pumpen += budget;
        if (x.state === "reserve") x.stateMin.reserve += dt;
      }
      // Belegung der Entnahmestellen
      for (const S of Sx) {
        if (S.fillers.length || hoses.some((h) => Sx[h.si] === S && t >= h.start)) S.busyMin += dt;
      }
      // Kennwerte Becken
      for (const Bb of B) {
        if (Bb.level > Bb.cap) Bb.level = Bb.cap; // numerische Sicherheit (Zuflüsse sind auf den freien Platz begrenzt)
        if (Bb.firstFill === null && Bb.s_inHose[k] > 0) Bb.firstFill = t;
        if (Bb.firstEmpty === null && Bb.firstFill !== null && t > Bb.firstFill && Bb.level <= 1 && needB[bIdx.get(Bb.b.id)] > 0) Bb.firstEmpty = t;
      }
      record(k + 1);
    }

    return finish(plan, { N, dt, T, B, Sx, C, V, hoses });
  }

  // ------------------------------------------------------------------ Kennzahlen und Engpassdiagnose
  function finish(plan, st) {
    const W = plan.W, { N, dt, T, B, Sx, C, V } = st;
    const lastStart = Math.max(0, ...C.map((c) => c.c.readyMin));
    const lastArr = Math.max(0, ...V.filter((x) => x.v.role !== "reserve").map((x) => x.v.anfahrtMin));
    let w0 = Math.min(T - W.diagnose.fensterMinMin, Math.max(lastStart, lastArr));
    w0 = Math.max(0, Math.floor(w0 / dt) * dt);
    const k0 = Math.round(w0 / dt), nW = N - k0;
    let dem = 0, inflow = 0, unmet = 0, out = 0;
    for (const x of B) for (let k = k0; k < N; k++) { dem += x.s_dem[k]; inflow += x.s_in[k]; out += x.s_out[k]; }
    for (const c of C) for (let k = k0; k < N; k++) unmet += c.s_unmet[k];
    // Abnehmer ohne Becken zählen beim Bedarf mit
    for (const c of C) if (c.bi < 0) for (let k = k0; k < N; k++) if (k * dt >= c.c.readyMin) dem += c.c.demandLpm;
    const kpi = {
      window: [w0, T], demandLpm: dem / nW, deliveredLpm: inflow / nW, outflowLpm: out / nW, unmetLpm: unmet / nW,
      coveragePct: dem > 0 ? 100 * (1 - unmet / dem) : 100,
      totalDemandL: C.reduce((s, c) => s + c.servedL + c.unmetL, 0), totalUnmetL: C.reduce((s, c) => s + c.unmetL, 0),
      totalDeliveredL: B.reduce((s, x) => s + x.s_in.reduce((a, v) => a + v * dt, 0), 0),
    };
    const shuttleV = V.filter((x) => x.v.role === "pendel");
    let shIn = 0;
    for (const x of B) for (let k = k0; k < N; k++) shIn += x.s_in[k] - x.s_inHose[k];
    const perTanker = shuttleV.length ? shIn / nW / shuttleV.length : null;
    kpi.shuttleLpm = shIn / nW; kpi.perTankerLpm = perTanker;

    const sources = Sx.map((S) => {
      const active = S.firstUse === null ? 0 : T - S.firstUse;
      const capL = S.s.capLpm === null ? null : S.s.capLpm * active;
      return {
        id: S.s.id, label: S.s.label, typ: S.s.typ, status: S.s.status, capLpm: S.s.capLpm, usedL: S.usedL, fills: S.fills, busyMin: S.busyMin,
        utilization: active > 0 ? S.busyMin / active : 0, flowUtilization: capL ? S.usedL / capL : null, waitMin: S.waitMin,
        meanWaitMin: S.fills ? S.waitMin / S.fills : 0, maxQueue: S.maxQueue, depletedAt: S.depletedAt, hoseLpm: S.hoseLpm, remainingL: S.vol,
      };
    });
    const basins = B.map((x) => ({
      id: x.b.id, readyMin: x.readyMin, level: x.s_level, inflow: x.s_in, inflowHose: x.s_inHose, outflow: x.s_out, demand: x.s_dem,
      firstFillMin: x.firstFill, firstEmptyMin: x.firstEmpty, minLevel: Math.min(...x.s_level.slice(Math.max(1, x.firstFill ?? N))),
      maxLevel: Math.max(...x.s_level), waitMin: x.waitMin, throttledL: x.throttledL, demandLpm: x.b.demandLpm,
    }));
    const vehicles = V.map((x) => ({
      id: x.v.id, role: x.v.role, state: x.s_state, lat: x.s_lat, lon: x.s_lon, load: x.s_load, stateMin: x.stateMin, deliveredL: x.deliveredL,
      cycles: x.cycles, waitSrcMin: x.waitSrcMin, waitBasinMin: x.waitBasinMin,
    }));
    const consumers = C.map((c) => ({ id: c.c.id, label: c.c.label, demandLpm: c.c.demandLpm, servedL: c.servedL, fromBasinL: c.fromBasinL, fromTankL: c.fromTankL, unmetL: c.unmetL, firstDryMin: c.firstDry, unmet: c.s_unmet }));

    // ---------------- Engpasskennwerte Pendelverkehr: Anteil Wartezeit an der Einsatzzeit (nach Eintreffen)
    let actMin = 0, wSrc = 0, wBas = 0;
    for (const x of V) if (x.v.role === "pendel") { actMin += Math.max(0, T - x.v.anfahrtMin); wSrc += x.waitSrcMin; wBas += x.waitBasinMin; }
    const shuttleStats = { n: shuttleV.length, activeMin: actMin, waitSrcShare: actMin ? wSrc / actMin : 0, waitBasinShare: actMin ? wBas / actMin : 0 };
    kpi.waitSrcShare = shuttleStats.waitSrcShare; kpi.waitBasinShare = shuttleStats.waitBasinShare;

    // ---------------- Diagnose
    const D = [], G = W.diagnose;
    const fmtT = (m) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")} h`;
    const pct = (v) => `${Math.round(v * 100)} %`;
    const overloaded = sources.filter((s) => s.utilization >= G.quelleAuslastung && s.meanWaitMin > G.quelleWartenMin);
    // Engpass: Wartezeit gesamt über der Schwelle; benannt wird jeder Anteil ab einem Drittel der Schwelle
    const thr = G.wartenAnteilEngpass, wTot = shuttleStats.waitSrcShare + shuttleStats.waitBasinShare;
    const srcBottleneck = overloaded.length > 0 || shuttleStats.waitSrcShare > thr || (wTot > thr && shuttleStats.waitSrcShare >= thr / 3);
    const basinBottleneck = shuttleStats.waitBasinShare > thr || (wTot > thr && shuttleStats.waitBasinShare >= thr / 3);
    for (const s of overloaded) D.push({ level: "warnung", code: "quelle_ueberlastet", sourceId: s.id, text: `${s.label} ${s.id} überlastet: ${pct(s.utilization)} belegt, mittlere Wartezeit ${r1(s.meanWaitMin)} min je Füllung (max. ${s.maxQueue} wartend). Weitere Entnahmestelle einplanen bzw. Ergiebigkeit prüfen.` });
    if (!overloaded.length && srcBottleneck) {
      const worst = sources.filter((s) => s.waitMin > 0).sort((a, b) => b.waitMin - a.waitMin)[0];
      D.push({ level: "warnung", code: "quelle_engpass", sourceId: worst ? worst.id : null, text: `Engpass Entnahmestelle: Pendelfahrzeuge warten ${pct(shuttleStats.waitSrcShare)} ihrer Einsatzzeit an der Entnahmestelle${worst ? ` (v. a. ${worst.label} ${worst.id}: mittlere Wartezeit ${r1(worst.meanWaitMin)} min je Füllung, max. ${worst.maxQueue} wartend)` : ""}. Zweite Entnahmestelle bzw. zweiten Füllplatz einplanen.` });
    }
    if (basinBottleneck) D.push({ level: "warnung", code: "becken_engpass", text: `Engpass Becken: Pendelfahrzeuge warten ${pct(shuttleStats.waitBasinShare)} ihrer Einsatzzeit am vollen bzw. belegten Becken (Tankerinhalt größer als Beckenplatz, nur ${W.becken.maxEntleerer} Einspeisestelle je Becken). Weiteres Becken koppeln oder zweite Einspeisestelle.` });
    for (const s of sources) if (s.depletedAt !== null) D.push({ level: "warnung", code: "quelle_leer", sourceId: s.id, text: `${s.label} ${s.id} nach ca. ${fmtT(s.depletedAt)} erschöpft (Volumen Annahme/OSM).` });
    const deficit = kpi.unmetLpm;
    const hasDeficit = deficit > Math.max(1, W.pendel.defizitSchwelle * kpi.demandLpm);
    if (hasDeficit) {
      const shuttleBasins = plan.basins.filter((b) => b.shuttleTarget).length;
      if (shuttleBasins && !srcBottleneck && !basinBottleneck) {
        let ref = perTanker;
        let refTxt = "mittlere Lieferung je eingesetztem Pendelfahrzeug";
        if (!(ref > 0)) {
          const tb = plan.basins.find((b) => b.shuttleTarget);
          let best = null;
          for (const s of plan.sources) { const c = cycle({ tank_l: 4000, pumpe_lpm: 2000 }, s, tb, W); if (c.ok && (!best || c.lpm > best.lpm)) best = c; }
          ref = best ? best.lpm : null; refTxt = "Referenz TLF 4000 (4.000 l, 2.000 l/min), Umlauf ohne Warten";
        }
        if (ref > 0) {
          const X = Math.ceil(deficit / ref - 1e-9);
          D.push({ level: "kritisch", code: "tanker_fehlen", count: X, text: `Defizit ca. ${Math.round(deficit)} l/min im eingeschwungenen Zustand (ab ${fmtT(w0)}): zusätzlich ca. ${X} Tanker nötig (${refTxt}: ${Math.round(ref)} l/min).${plan.reserveCount ? ` ${plan.reserveCount} weitere verfügbare Fahrzeuge sind nicht eingeplant (Nachplanung ausgeschöpft bzw. zu geringe Wirkung).` : " Keine weiteren geeigneten Fahrzeuge in der Liste."}` });
        } else D.push({ level: "kritisch", code: "defizit", text: `Defizit ca. ${Math.round(deficit)} l/min: keine nutzbare Entnahmestelle für Pendelverkehr.` });
      } else if (shuttleBasins) {
        D.push({ level: "kritisch", code: "defizit_engpass", text: `Defizit ca. ${Math.round(deficit)} l/min im eingeschwungenen Zustand (ab ${fmtT(w0)}): Engpass ${[srcBottleneck ? "Entnahmestelle" : null, basinBottleneck ? "Becken" : null].filter(Boolean).join(" und ")}; zusätzliche Tanker helfen erst nach Beseitigung des Engpasses.` });
      } else D.push({ level: "kritisch", code: "defizit", text: `Defizit ca. ${Math.round(deficit)} l/min ohne Pendelverkehr (Förderstrecke/Becken prüfen).` });
    }
    const tankersN = shuttleV.length;
    for (const b of plan.basins) {
      const r = basins.find((x) => x.id === b.id);
      if (b.supply && b.supply.hose && b.supply.hose.flowLpm < b.demandLpm) D.push({ level: "warnung", code: "schlauch_zu_wenig", basinId: b.id, text: `Förderstrecke zu Becken ${b.id} liefert ${Math.round(b.supply.hose.flowLpm)} l/min < Bedarf ${Math.round(b.demandLpm)} l/min${b.supply.hose.reduced ? " (zu wenige Pumpen: Verstärkerpumpe ergänzen)" : ""}; Rest per Pendelverkehr.` });
      if (b.supply && b.supply.hose && b.supply.hose.boosters > 0) D.push({ level: "info", code: "verstaerker", basinId: b.id, text: `Förderstrecke zu Becken ${b.id}: ${b.supply.hose.boosters} Verstärkerpumpe(n) nötig (${Math.round(b.supply.hose.lengthM)} m Schlauchweg, höchster Punkt +${Math.round(b.supply.hose.dhMaxM)} m, ${Math.round(b.supply.hose.flowLpm)} l/min).` });
      if (r.firstEmptyMin !== null) D.push({ level: "warnung", code: "becken_leer", basinId: b.id, text: `Becken ${b.id} läuft erstmals nach ${fmtT(r.firstEmptyMin)} leer.` });
      if (r.readyMin === Infinity && b.demandLpm > 0) D.push({ level: "kritisch", code: "becken_ohne_versorgung", basinId: b.id, text: `Becken ${b.id} ohne Versorgung (kein Fahrzeug bzw. keine Entnahmestelle).` });
      if (tankersN && r.waitMin / tankersN > G.beckenWartenMin && !basinBottleneck) D.push({ level: "info", code: "becken_warten", basinId: b.id, text: `Am Becken ${b.id} warten Pendelfahrzeuge im Mittel ${Math.round(r.waitMin / tankersN)} min.` });
    }
    for (const c of consumers) if (c.firstDryMin !== null) D.push({ level: "warnung", code: "abnehmer_trocken", consumerId: c.id, text: `${c.label}: erste Unterversorgung nach ${fmtT(c.firstDryMin)} (ungedeckt gesamt ca. ${Math.round(c.unmetL / 100) * 100} l).` });
    if (!D.some((d) => d.level === "kritisch")) D.unshift({ level: "ok", code: "gedeckt", text: `Bedarf im eingeschwungenen Zustand (ab ${fmtT(w0)}) zu ${Math.round(kpi.coveragePct)} % gedeckt (Simulation mit Annahmen).` });
    const order = { kritisch: 0, warnung: 1, ok: 2, info: 3 };
    D.sort((a, b) => order[a.level] - order[b.level]);
    const bottleneck = { source: srcBottleneck, basin: basinBottleneck, deficit: hasDeficit };
    return { N, dt, T, basins, vehicles, consumers, sources, kpi, diagnosis: D, bottleneck, shuttleStats, hoses: st.hoses };
  }

  /**
   * Planung + Simulation mit Nachplanung "nach Bedarf" (deterministisch, max. pendel.maxIterationen Läufe):
   *  1. Becken-Engpass (Pendelfahrzeuge warten am vollen Becken) und automatische Becken: ein Becken in der
   *     Gruppe mit der größten Wartezeit ergänzen (bis becken.maxJeGruppe).
   *  2. sonst Defizit ohne Engpass an der Entnahmestelle und Reserve vorhanden: weitere Pendelfahrzeuge.
   * Vom Nutzer gesetzte Becken werden nie verändert.
   */
  function run(input) {
    const W = input.W;
    let extra = 0;
    const basinExtra = {};
    let plan = planSupply({ ...input, extraShuttle: 0, basinExtra }), sim = simulate(plan), it = 1;
    const log = [];
    while (it < W.pendel.maxIterationen) {
      const bn = sim.bottleneck;
      if (!bn.deficit && !bn.basin) break;
      let changed = false;
      if (bn.basin && !plan.manualBasins) {
        // Gruppe mit der größten Wartezeit am Becken, die noch ein Becken aufnehmen kann
        const groups = new Map();
        for (const b of plan.basins) {
          if (!b.shuttleTarget || !b.group) continue;
          const r = sim.basins.find((x) => x.id === b.id);
          const g = groups.get(b.group) || { wait: 0, n: 0 };
          g.wait += r.waitMin; g.n++;
          groups.set(b.group, g);
        }
        const cand = [...groups.entries()].filter(([, g]) => g.n < W.becken.maxJeGruppe).sort((a, b) => b[1].wait - a[1].wait || a[0] - b[0])[0];
        if (cand) { basinExtra[cand[0]] = (basinExtra[cand[0]] || 0) + 1; changed = true; log.push(`Becken-Engpass: Gruppe ${cand[0]} +1 Becken`); }
      }
      if (!changed && bn.deficit && !bn.source && plan.reserveCount && plan.basins.some((b) => b.shuttleTarget)) {
        const per = sim.kpi.perTankerLpm > 0 ? sim.kpi.perTankerLpm : 150;
        extra += Math.max(1, Math.ceil(sim.kpi.unmetLpm / per - 1e-9));
        changed = true; log.push(`Defizit: +${extra} Pendelfahrzeug(e) über der Schätzung`);
      }
      if (!changed) break;
      const p2 = planSupply({ ...input, extraShuttle: extra, basinExtra: { ...basinExtra } });
      const s2 = simulate(p2);
      it++;
      // nur übernehmen, wenn es besser wird (weniger Defizit oder gleich mit weniger Warten)
      if (s2.kpi.unmetLpm <= sim.kpi.unmetLpm + 1e-6) { plan = p2; sim = s2; }
      else { log.push("Nachplanung ohne Verbesserung verworfen"); break; }
    }
    return { plan, sim, iterations: it, log };
  }

  /** Zustand eines Fahrzeugs zur (gebrochenen) Zeit tMin, Position linear zwischen den Minutenwerten. */
  function vehicleAt(sim, vi, tMin) {
    const v = sim.vehicles[vi];
    const f = Math.max(0, Math.min(sim.N, tMin / sim.dt));
    const k0 = Math.floor(f), k1 = Math.min(sim.N, k0 + 1), a = f - k0;
    const la0 = v.lat[k0], la1 = v.lat[k1], lo0 = v.lon[k0], lo1 = v.lon[k1];
    let lat = la0, lon = lo0;
    if (!Number.isNaN(la0) && !Number.isNaN(la1)) { lat = la0 + (la1 - la0) * a; lon = lo0 + (lo1 - lo0) * a; }
    else if (Number.isNaN(la0)) { lat = NaN; lon = NaN; }
    return { state: STATES[v.state[k0]], lat, lon, load: v.load[k0] + (v.load[k1] - v.load[k0]) * a };
  }

  /** Kompakte, JSON-taugliche Zusammenfassung für Protokoll und Export (ohne Zeitreihen). */
  function summary(plan, sim) {
    return {
      version: plan.version, hinweis: plan.W.hinweis,
      becken: plan.basins.map((b) => { const r = sim.basins.find((x) => x.id === b.id); return { id: b.id, lat: +b.lat.toFixed(6), lon: +b.lon.toFixed(6), manuell: b.manual, reservestandort: !!b.reserve, versorgung: b.supply.kind, entnahmestelle: b.supply.sourceId, schlauch_m: b.supply.hose ? Math.round(b.supply.hose.lengthM) : null, foerderstrom_lpm: b.supply.hose ? Math.round(b.supply.hose.flowLpm) : null, verstaerker: b.supply.hose ? b.supply.hose.boosters : null, bedarf_lpm: Math.round(b.demandLpm), erstes_leerlaufen_min: r.firstEmptyMin, sicherheit: b.safety ? b.safety.text : null }; }),
      fahrzeuge: plan.vehicles.map((v) => ({ id: v.id, rolle: v.role, anfahrt_min: Math.round(v.anfahrtMin), umlauf_min: v.estimate ? r1(v.estimate.cycleMin) : null, geliefert_l: Math.round((sim.vehicles.find((x) => x.id === v.id) || {}).deliveredL || 0) })),
      ausgeschlossen: plan.excluded,
      kennzahlen: { fenster_min: sim.kpi.window, bedarf_lpm: Math.round(sim.kpi.demandLpm), lieferung_lpm: Math.round(sim.kpi.deliveredLpm), defizit_lpm: Math.round(sim.kpi.unmetLpm), deckung_pct: Math.round(sim.kpi.coveragePct), defizit_l: Math.round(sim.kpi.totalUnmetL) },
      diagnose: sim.diagnosis.map((d) => d.text), warnungen: plan.warnings, hinweise: plan.notes,
    };
  }

  const Water = {
    STATES, STATE_LABEL, ROLE_LABEL, distM, makeProj, roadNet, classifySource, sourcesFromOsm, parseFlow, parseDiameter,
    vehicleClass, hasPump, eligibleSupplyVehicles, fillRate, unloadRate, driveMin, cycle, hoseDesign, hoseProfile, siteSafety,
    consumerDemand, planSupply, simulate, run, vehicleAt, summary,
  };
  root.Water = Water;
  if (typeof module !== "undefined" && module.exports) module.exports = Water;
})(typeof globalThis !== "undefined" ? globalThis : this);
