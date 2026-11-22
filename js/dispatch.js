/*
 * Anfahrt und Fahrzeugdaten (neu in 0.4.0). Reine Funktionen, UI-unabhängig.
 *
 * Anfahrt = Ausrückzeit + Luftlinie (Wache -> Einsatzstelle) x Umwegfaktor / Geschwindigkeit der Fahrzeugklasse.
 * GESCHÄTZT, KEIN ROUTING. Alle Werte sind Annahmen (PARAMS.anfahrt). Ohne Koordinate der Wache (oder des
 * Fahrzeugs) gibt es keine Schätzung; das Fahrzeug wird dann nicht eingeplant.
 *
 * Datenmodell (kompatibel mit schema_version 1, data/fahrzeuge.json bis 0.3.0):
 *   wachen[]:    {id, name, kommune?, einheit?, adresse?, lat, lon, koordinate_status?, typ? ("FF"|"BF"),
 *                 ausrueckzeit_min?, quelle?, quellentyp?, annahmen?[]}
 *   fahrzeuge[]: {id, typ, bezeichnung?, kommune?, einheit?, wache (id), lat?/lon? (überschreibt Wache),
 *                 funkrufname?, tank_l?, pumpe_lpm?, loeschfahrzeug?, verfuegbar?, quelle?, quellentyp?,
 *                 annahmen?[] , tank_quelle?, pumpe_quelle?}
 */
(function (root) {
  const R_EARTH = 6371008.8;

  function haversineM(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const hasCoord = (o) => o && num(o.lat) !== null && num(o.lon) !== null && Math.abs(num(o.lat)) <= 90 && Math.abs(num(o.lon)) <= 180;

  function stationMap(stations) {
    const m = new Map();
    for (const s of stations || []) if (s && s.id !== undefined) m.set(String(s.id), s);
    return m;
  }

  /** Ausgangspunkt eines Fahrzeugs: eigene Koordinate oder Koordinate der Wache. */
  function origin(v, stMap) {
    const st = v.wache !== undefined && v.wache !== null ? stMap.get(String(v.wache)) : null;
    if (hasCoord(v)) return { lat: num(v.lat), lon: num(v.lon), station: st || null, from: "fahrzeug" };
    if (hasCoord(st)) return { lat: num(st.lat), lon: num(st.lon), station: st, from: "wache" };
    return { station: st || null, missing: true };
  }

  /** Geschwindigkeit (km/h) nach längstem passenden Typ-Präfix. */
  function speedFor(typ, P) {
    const t = String(typ || "").toUpperCase();
    let best = null, bestLen = -1;
    for (const [k, v] of Object.entries(P.anfahrt.kmh)) {
      if (k === "default") continue;
      const K = k.toUpperCase();
      if ((t === K || t.startsWith(K + " ") || t.startsWith(K + "-") || t.startsWith(K)) && K.length > bestLen) { best = v; bestLen = K.length; }
    }
    return best ?? P.anfahrt.kmh.default;
  }

  function ausrueckFor(station, P) {
    const A = P.anfahrt.ausrueckMin;
    const own = station ? num(station.ausrueckzeit_min) : null;
    if (own !== null) return { min: own, src: "Wache" };
    const typ = station && station.typ ? String(station.typ).toUpperCase() : null;
    if (typ && A[typ] !== undefined) return { min: A[typ], src: `Annahme ${typ}` };
    return { min: A.default, src: "Annahme Freiwillige Feuerwehr" };
  }

  const fmt = (v, d = 1) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });

  /**
   * Geschätzte Anfahrt eines Fahrzeugs zur Einsatzstelle (lat, lon).
   * @returns {ok:false, reason} | {ok:true, min, luftlinieKm, wegKm, kmh, ausrueckMin, text, short}
   */
  function estimate(v, stMap, lat, lon, P) {
    const o = origin(v, stMap);
    if (o.missing) return { ok: false, reason: o.station ? `Wache „${o.station.name || o.station.id}“ ohne Koordinate` : "keine Wache/Koordinate zugeordnet" };
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: "keine Einsatzstelle" };
    const A = P.anfahrt;
    const d = haversineM(o.lat, o.lon, lat, lon) / 1000;
    const weg = d * A.umwegfaktor;
    const kmh = speedFor(v.typ, P);
    const aus = ausrueckFor(o.station, P);
    const min = aus.min + (weg / kmh) * 60;
    return {
      ok: true, min, luftlinieKm: d, wegKm: weg, kmh, ausrueckMin: aus.min,
      short: `ca. ${Math.round(min)} min`,
      text: `ca. ${Math.round(min)} min (geschätzt, kein Routing): Luftlinie ${fmt(d)} km × ${fmt(A.umwegfaktor)} Umweg ÷ ${kmh} km/h + ${fmt(aus.min, 1)} min Ausrücken (${aus.src})`,
    };
  }

  // ------------------------------------------------------------------ Import / Normalisierung
  const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };
  const asList = (x) => (x === undefined || x === null || x === "" ? [] : Array.isArray(x) ? x.map(String) : [String(x)]);

  function normStation(s) {
    const c = s.koordinate || s.coordinates || {};
    const lat = pick(s, ["lat", "latitude", "breite"]) ?? (Array.isArray(c) ? c[0] : c.lat);
    const lon = pick(s, ["lon", "lng", "longitude", "laenge"]) ?? (Array.isArray(c) ? c[1] : (c.lon ?? c.lng));
    return {
      ...s,
      id: String(pick(s, ["id", "wache_id", "station_id"]) ?? ""),
      name: pick(s, ["name", "bezeichnung"]) ?? String(pick(s, ["id"]) ?? ""),
      kommune: pick(s, ["kommune", "gemeinde", "stadt"]) ?? null,
      einheit: pick(s, ["einheit", "loeschzug", "loescheinheit", "unit"]) ?? null,
      adresse: pick(s, ["adresse", "address", "anschrift"]) ?? "",
      lat: num(lat), lon: num(lon),
      quelle: pick(s, ["quelle", "source", "url", "adresse_quelle"]) ?? null,
      quellentyp: pick(s, ["quellentyp", "quelle_typ", "source_type"]) ?? null,
      annahmen: asList(pick(s, ["annahmen", "assumptions"])),
    };
  }
  function normVehicle(v, k) {
    const c = v.koordinate || v.coordinates || {};
    const lat = pick(v, ["lat", "latitude"]) ?? (Array.isArray(c) ? c[0] : c.lat);
    const lon = pick(v, ["lon", "lng", "longitude"]) ?? (Array.isArray(c) ? c[1] : (c.lon ?? c.lng));
    const out = {
      ...v,
      typ: pick(v, ["typ", "fahrzeugtyp", "type"]),
      bezeichnung: pick(v, ["bezeichnung", "name"]) ?? null,
      wache: pick(v, ["wache", "wache_id", "station", "standort_id", "station_id"]) ?? null,
      kommune: pick(v, ["kommune", "gemeinde", "stadt"]) ?? null,
      einheit: pick(v, ["einheit", "loeschzug", "loescheinheit", "unit"]) ?? null,
      funkrufname: pick(v, ["funkrufname", "rufname", "callsign"]) ?? null,
      tank_l: pick(v, ["tank_l", "tank", "wasser_l"]),
      pumpe_lpm: pick(v, ["pumpe_lpm", "pumpe"]),
      quelle: pick(v, ["quelle", "source", "url"]),
      quellentyp: pick(v, ["quellentyp", "quelle_typ", "source_type"]) ?? null,
      annahmen: asList(pick(v, ["annahmen", "assumptions"])),
    };
    if (lat !== undefined) out.lat = num(lat);
    if (lon !== undefined) out.lon = num(lon);
    if (out.wache !== null) out.wache = String(out.wache);
    out.id = pick(v, ["id", "fahrzeug_id"]);
    if (out.id === undefined) out._autoId = k;
    return out;
  }

  /**
   * Normalisiert eine Fahrzeugliste (Array oder Objekt mit fahrzeuge/vehicles und wachen/stations).
   * Ergänzt Kommune/Einheit aus der Wache. Erzeugt fehlende ids (mit Warnung).
   * @returns {meta, fahrzeuge, wachen, warnings}
   */
  function normalize(json) {
    const warnings = [];
    const isArr = Array.isArray(json);
    const rawV = isArr ? json : (json.fahrzeuge || json.vehicles || []);
    const rawS = isArr ? [] : (json.wachen || json.stations || json.standorte || []);
    if (!Array.isArray(rawV)) throw new Error("Keine Fahrzeugliste gefunden (erwartet: Array oder Objekt mit „fahrzeuge“).");
    const wachen = (Array.isArray(rawS) ? rawS : []).map(normStation);
    const stMap = stationMap(wachen);
    const fahrzeuge = rawV.map((v, k) => normVehicle(v, k));
    for (const v of fahrzeuge) {
      if (v._autoId !== undefined) {
        v.id = `${v.wache || "fz"}-${String(v.typ || "x").replace(/\s+/g, "")}-${v._autoId + 1}`;
        warnings.push(`Fahrzeug ohne id (Zeile ${v._autoId + 1}): id „${v.id}“ erzeugt.`);
        delete v._autoId;
      }
      const st = v.wache ? stMap.get(v.wache) : null;
      if (v.wache && !st) warnings.push(`Fahrzeug „${v.id}“: Wache „${v.wache}“ nicht in der Wachenliste.`);
      if (st) { if (!v.kommune && st.kommune) v.kommune = st.kommune; if (!v.einheit && st.einheit) v.einheit = st.einheit; }
    }
    const meta = isArr ? {} : Object.fromEntries(Object.entries(json).filter(([k]) => !["fahrzeuge", "vehicles", "wachen", "stations", "standorte"].includes(k)));
    return { meta, fahrzeuge, wachen, warnings };
  }

  /** Filtern und Sortieren der Fahrzeugliste (UI). est: Map id -> estimate. */
  function filterSort(vehicles, opt, est) {
    const o = opt || {};
    let list = vehicles.map((v, k) => ({ v, k }));
    if (o.kommune) list = list.filter(({ v }) => (v.kommune || "") === o.kommune);
    if (o.typ) list = list.filter(({ v }) => String(v.typ || "") === o.typ);
    if (o.onlyAvail) list = list.filter(({ v }) => v.verfuegbar !== false);
    const am = (v) => { const e = est && est.get(v.id); return e && e.ok ? e.min : Infinity; };
    if (o.sort === "anfahrt") list.sort((a, b) => am(a.v) - am(b.v) || a.k - b.k);
    else if (o.sort === "kommune") list.sort((a, b) => String(a.v.kommune || "").localeCompare(String(b.v.kommune || ""), "de") || String(a.v.wache || "").localeCompare(String(b.v.wache || ""), "de") || a.k - b.k);
    else if (o.sort === "typ") list.sort((a, b) => String(a.v.typ || "").localeCompare(String(b.v.typ || ""), "de") || a.k - b.k);
    return list.map((x) => x.v);
  }

  /**
   * Bildschirm-Gruppierung von Punkten (z. B. Wachen-Marker) ohne Zusatzbibliothek:
   * Punkte näher als radiusPx (in Bildschirmkoordinaten, project(p) -> {x, y}) bilden eine Gruppe.
   */
  function groupByScreen(points, project, radiusPx) {
    const groups = [];
    const cellSize = radiusPx;
    const grid = new Map();
    for (const p of points) {
      const q = project(p);
      const gx = Math.floor(q.x / cellSize), gy = Math.floor(q.y / cellSize);
      let found = null;
      for (let dx = -1; dx <= 1 && !found; dx++) for (let dy = -1; dy <= 1 && !found; dy++) {
        for (const gr of grid.get(`${gx + dx},${gy + dy}`) || []) {
          if (Math.hypot(gr.x - q.x, gr.y - q.y) < radiusPx) { found = gr; break; }
        }
      }
      if (found) found.items.push(p);
      else {
        const gr = { x: q.x, y: q.y, items: [p] };
        groups.push(gr);
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(gr);
      }
    }
    return groups;
  }

  // ------------------------------------------------------------------ Gemeindeteil und Bereitschaft eigene Wehr
  function inRing(lon, lat, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if ((y1 > lat) !== (y2 > lat) && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) c = !c;
    }
    return c;
  }
  const inPolys = (lon, lat, polys) => (polys || []).some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)));

  /**
   * Gemeindeteil am Einsatzort. mode: "auto" | "Neunkirchen" | "Seelscheid" (manuelle Wahl überschreibt).
   * grenzen: data/gemeindeteile.json (Gemarkungen mit Zuordnung, vom Auftraggeber bestätigt, 22.11.2026).
   * @returns {teil: "Neunkirchen"|"Seelscheid"|null, innerhalb: true|false|null, quelle, gemarkung?, annahme}
   */
  function gemeindeteil(lat, lon, grenzen, mode) {
    if (mode === "Neunkirchen" || mode === "Seelscheid") return { teil: mode, innerhalb: true, quelle: "manuelle Wahl", annahme: false, manuell: true };
    if (!grenzen || !grenzen.gemarkungen) return { teil: null, innerhalb: null, quelle: "keine Grenzdaten (data/gemeindeteile.json nicht geladen)", annahme: true };
    for (const g of grenzen.gemarkungen) {
      if (inPolys(lon, lat, g.polygone)) return { teil: g.teil, innerhalb: true, gemarkung: g.name, quelle: `Gemarkung ${g.name} (ALKIS) → ${g.teil}: ${g.zuordnung}`, annahme: !/^(belegt|bestätigt)/.test(g.zuordnung) };
    }
    const inG = grenzen.gemeinde ? inPolys(lon, lat, grenzen.gemeinde.polygone) : false;
    return inG ? { teil: null, innerhalb: true, quelle: "im Gemeindegebiet, keine Gemarkung zugeordnet", annahme: true } : { teil: null, innerhalb: false, quelle: "außerhalb des Gemeindegebiets (ALKIS)", annahme: false };
  }

  /** Teil (Neunkirchen/Seelscheid) des Löschzugs eines Fahrzeugs der eigenen Wehr, sonst null. */
  function eigenerTeil(v, stMap, P) {
    const B = P.bereitschaftEigeneWehr;
    if (!B) return null;
    const st = v.wache ? stMap.get(String(v.wache)) : null;
    const k = v.kommune || (st && st.kommune) || null;
    if (k && String(k).trim().toLowerCase() !== B.kommune.toLowerCase()) return null;
    return B.wachenTeil[String(v.wache)] || null;
  }

  /**
   * Bereitschaft (Zeit von Alarm bis löschbereit) eines Fahrzeugs am Ort (lat, lon).
   * Eigene Wehr (Vorgabe Auftraggeber): gleicher Gemeindeteil 25 min, anderer 40 min (Gesamtzeit).
   * Sonst: geschätzte Anfahrt (Luftlinie × Umweg ÷ km/h + Ausrücken) + setupMin (Annahme).
   * teil: Ergebnis von gemeindeteil() für den EINSATZORT (Brand), undefined = Vorgabe nicht anwendbar.
   * @returns {ok, ready, kind: "vorgabe"|"geschaetzt", e (Anfahrtsschätzung), text, short} | {ok:false, reason}
   */
  function readiness(v, stMap, lat, lon, setupMin, P, teil) {
    const B = P.bereitschaftEigeneWehr;
    const own = teil !== undefined ? eigenerTeil(v, stMap, P) : null;
    const e = estimate(v, stMap, lat, lon, P);
    if (own) {
      if (teil && teil.teil) {
        const same = teil.teil === own;
        const m = same ? B.gleicherTeil : B.andererTeil;
        return { ok: true, ready: m, kind: "vorgabe", e, short: `${m} min löschbereit (Vorgabe)`, text: `löschbereit ${m} min nach Alarm (${B.quelle}: LZ ${own}, Einsatzort Gemeindeteil ${teil.teil}${teil.annahme ? ", Gemeindeteil-Zuordnung teils Annahme" : ""})` };
      }
      if (teil && teil.innerhalb === false) {
        if (e.ok) {
          const m = Math.max(B.ausserhalbMinMin, e.min + setupMin);
          return { ok: true, ready: m, kind: "geschaetzt", e, short: `${Math.round(m)} min löschbereit (geschätzt)`, text: `löschbereit ca. ${Math.round(m)} min (Einsatzort außerhalb des Gemeindegebiets, ANNAHME: Anfahrt geschätzt ${e.text} + ${setupMin} min Aufbau, mind. ${B.ausserhalbMinMin} min)` };
        }
        return { ok: true, ready: B.andererTeil, kind: "vorgabe", e, short: `${B.andererTeil} min (Annahme)`, text: `löschbereit ${B.andererTeil} min (Einsatzort außerhalb, keine Wachenkoordinate: ANNAHME ${B.andererTeil} min)` };
      }
      return { ok: true, ready: B.unbekanntMin, kind: "vorgabe", e, short: `${B.unbekanntMin} min (Teil unbekannt)`, text: `löschbereit ${B.unbekanntMin} min nach Alarm (Gemeindeteil des Einsatzorts unbekannt: ANNAHME ${B.unbekanntMin} min für beide Löschzüge; ${teil ? teil.quelle : ""})` };
    }
    if (!e.ok) return { ok: false, reason: e.reason, e };
    return { ok: true, ready: e.min + setupMin, kind: "geschaetzt", e, short: `${Math.round(e.min + setupMin)} min löschbereit`, text: `löschbereit ca. ${Math.round(e.min + setupMin)} min = Anfahrt ${e.text} + ${setupMin} min Aufbau (Annahme)` };
  }

  const Dispatch = { gemeindeteil, eigenerTeil, readiness, haversineM, stationMap, origin, speedFor, ausrueckFor, estimate, normalize, filterSort, groupByScreen, hasCoord };
  root.Dispatch = Dispatch;
  if (typeof module !== "undefined" && module.exports) module.exports = Dispatch;
})(typeof globalThis !== "undefined" ? globalThis : this);
