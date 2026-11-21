/*
 * OpenStreetMap-Daten (ODbL, © OpenStreetMap-Mitwirkende) über die Overpass API:
 * vereinfachte Brennstoffkarte, Barrieren, Riegelkandidaten, Objekte, Wasserentnahmestellen.
 * Alle OSM-Daten gelten als "nicht verifiziert".
 */
(function (root) {
  const G = root.Grid;

  function buildQuery(b) {
    const bb = `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;
    const lu = "^(forest|meadow|grass|farmland|residential|commercial|industrial|retail|farmyard|orchard|village_green|reservoir|basin)$";
    const nat = "^(wood|scrub|heath|grassland|water)$";
    return `[out:json][timeout:90];
(
  way["landuse"~"${lu}"](${bb});
  relation["landuse"~"${lu}"]["type"="multipolygon"](${bb});
  way["natural"~"${nat}"](${bb});
  relation["natural"~"${nat}"]["type"="multipolygon"](${bb});
  way["highway"](${bb});
  way["railway"~"^(rail|light_rail)$"](${bb});
  way["waterway"~"^(river|stream|canal|riverbank)$"](${bb});
  way["leisure"="nature_reserve"](${bb});
  relation["leisure"="nature_reserve"](${bb});
  relation["boundary"="protected_area"]["protect_class"~"^(1a|1b|1|2|3|4)$"](${bb});
);
out geom;
(
  way["building"](${bb});
  node["emergency"~"^(fire_hydrant|water_tank|suction_point|fire_water_pond)$"](${bb});
  way["emergency"~"^(fire_water_pond|water_tank|suction_point)$"](${bb});
);
out center;`;
  }

  async function fetchOsm(bounds, url, signal) {
    const res = await fetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(buildQuery(bounds)),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal,
    });
    if (!res.ok) throw new Error(`Overpass antwortet mit HTTP ${res.status}`);
    return res.json();
  }

  function areaClass(t) {
    if (t.natural === "water" || t.landuse === "reservoir" || t.landuse === "basin" || t.waterway === "riverbank") return "wasser";
    if (["residential", "commercial", "industrial", "retail", "farmyard"].includes(t.landuse)) return "siedlung";
    if (t.landuse === "forest" || t.natural === "wood") {
      if (t.leaf_type === "needleleaved") return "nadelwald";
      if (t.leaf_type === "broadleaved") return "laubwald";
      return "mischwald";
    }
    if (["meadow", "grass", "village_green", "orchard"].includes(t.landuse) || t.natural === "grassland") return "gruenland";
    if (t.landuse === "farmland") return "acker";
    if (t.natural === "scrub" || t.natural === "heath") return "gebuesch";
    return null;
  }
  const PRIORITY = { gruenland: 1, acker: 1, gebuesch: 1, mischwald: 2, laubwald: 2, nadelwald: 2, siedlung: 3, wasser: 4 };

  function geomXY(g, geometry) {
    return geometry.filter(Boolean).map((p) => g.proj.toXY(p.lat, p.lon));
  }

  function elementSegments(g, el) {
    const segs = [];
    if (el.type === "way" && el.geometry && el.geometry.length > 2) {
      G.ringToSegs(geomXY(g, el.geometry), segs);
    } else if (el.type === "relation" && el.members) {
      for (const m of el.members) {
        if (m.type !== "way" || !m.geometry || m.geometry.length < 2) continue;
        const pts = geomXY(g, m.geometry);
        for (let k = 0; k + 1 < pts.length; k++) segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
      }
    }
    return segs;
  }

  /**
   * Überträgt OSM-Daten auf das Raster. Verändert grid.fuel.
   * @returns {objects, candidates, drivable, waterPoints, stats}
   */
  function applyOsm(g, json, P) {
    const cl = g.classList;
    const n = g.nx * g.ny;
    const objects = {
      wohnbebauung: new Uint8Array(n), strasse: new Uint8Array(n),
      bahn: new Uint8Array(n), schutzgebiet: new Uint8Array(n),
    };
    const drivable = new Uint8Array(n); // 1 = Straße, 2 = Waldweg (Befahrbarkeit prüfen)
    const candidates = [];
    const waterPoints = [];
    const stats = { flaechen: 0, wege: 0, gebaeude: 0, entnahmestellen: 0, relationenOhneGeometrie: 0 };
    const els = json.elements || [];

    // 1) Flächen nach Priorität
    const areas = [];
    for (const el of els) {
      const t = el.tags || {};
      const c = areaClass(t);
      if (c && (el.type === "way" ? t.highway === undefined : true)) areas.push({ el, c });
    }
    areas.sort((a, b) => PRIORITY[a.c] - PRIORITY[b.c]);
    for (const { el, c } of areas) {
      const segs = elementSegments(g, el);
      if (!segs.length) { if (el.type === "relation") stats.relationenOhneGeometrie++; continue; }
      const v = cl.indexOf(c);
      G.fillSegments(g, segs, (i) => { g.fuel[i] = v; if (c === "siedlung") objects.wohnbebauung[i] = 1; });
      stats.flaechen++;
    }
    // Schutzgebiete
    for (const el of els) {
      const t = el.tags || {};
      if (t.leisure === "nature_reserve" || t.boundary === "protected_area") {
        G.fillSegments(g, elementSegments(g, el), (i) => { objects.schutzgebiet[i] = 1; });
      }
    }
    // 2) Linien: Wege, Bahn, Gewässer
    const barrierIdx = cl.indexOf("barriere");
    const roadDrive = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
      "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street"];
    const candHighways = ["primary", "secondary", "tertiary", "unclassified", "residential", "service", "track", "path"];
    for (const el of els) {
      if (el.type !== "way" || !el.geometry) continue;
      const t = el.tags || {};
      const pts = geomXY(g, el.geometry);
      if (pts.length < 2) continue;
      let kind = null, barrier = false;
      if (t.highway) {
        kind = t.highway;
        barrier = P.barrierHighways.includes(t.highway);
        const isRoad = roadDrive.includes(t.highway);
        const isTrack = t.highway === "track" && (!t.tracktype || ["grade1", "grade2", "grade3"].includes(t.tracktype));
        if (isRoad || isTrack) G.rasterLine(g, pts, (i) => { if (!drivable[i]) drivable[i] = isRoad ? 1 : 2; if (isRoad) drivable[i] = 1; });
        if (["primary", "secondary", "tertiary", "trunk", "motorway"].includes(t.highway)) G.rasterLine(g, pts, (i) => { objects.strasse[i] = 1; });
        if (!candHighways.includes(t.highway)) kind = null;
        stats.wege++;
      } else if (t.railway) {
        kind = "railway"; barrier = true;
        G.rasterLine(g, pts, (i) => { objects.bahn[i] = 1; });
      } else if (t.waterway && t.waterway !== "riverbank") {
        kind = t.waterway; barrier = P.barrierWaterways.includes(t.waterway);
      }
      if (barrier) G.rasterLine(g, pts, (i) => { g.fuel[i] = barrierIdx; });
      if (kind && P.suggestions.barrierTypeScore[kind] !== undefined) {
        candidates.push({ id: `${el.type}/${el.id}`, kind, name: t.name || t.ref || null, tags: t, pts, latlngs: el.geometry.map((p) => [p.lat, p.lon]) });
      }
    }
    // 3) Gebäude (Mittelpunkte) und Wasserentnahmestellen
    const siedlungIdx = cl.indexOf("siedlung");
    for (const el of els) {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat === undefined) continue;
      const [x, y] = g.proj.toXY(lat, lon);
      const i = G.cellOf(g, x, y);
      if (t.building && i >= 0) {
        objects.wohnbebauung[i] = 1;
        g.fuel[i] = siedlungIdx; // Annahme: Gebäudezelle nicht brennbar gerechnet
        stats.gebaeude++;
      }
      if (t.emergency) {
        waterPoints.push({ id: `${el.type}/${el.id}`, lat, lon, kind: t.emergency, tags: t, source: "OSM", verified: false });
        stats.entnahmestellen++;
      }
    }
    // Gewässerflächen als mögliche Entnahmestellen (Mittelpunkt grob)
    for (const el of els) {
      const t = el.tags || {};
      if (el.type === "way" && t.natural === "water" && el.geometry && el.geometry.length > 2) {
        const lat = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
        const lon = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
        waterPoints.push({ id: `way/${el.id}`, lat, lon, kind: t.water ? `Gewässer (${t.water})` : "Gewässer", tags: t, source: "OSM", verified: false });
      }
    }
    return { objects, candidates, drivable, waterPoints, stats };
  }

  const Osm = { buildQuery, fetchOsm, applyOsm, areaClass };
  root.Osm = Osm;
  if (typeof module !== "undefined" && module.exports) module.exports = Osm;
})(typeof globalThis !== "undefined" ? globalThis : this);
