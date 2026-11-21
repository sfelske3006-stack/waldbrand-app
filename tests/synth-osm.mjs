// Synthetische OSM-Testdaten (KEINE echten Daten), Koordinaten relativ zum Brandschwerpunkt in Metern.
// Gemeinsam genutzt von tests/model.test.mjs und tests/e2e.mjs.
export function makeTools(lat0, lon0) {
  const dy = (m) => m / 111195, dx = (m) => m / (111195 * Math.cos((lat0 * Math.PI) / 180));
  const pt = (x, y) => ({ lat: lat0 + dy(y), lon: lon0 + dx(x) });
  const rect = (x0, y0, x1, y1) => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1), pt(x0, y0)];
  let id = 1;
  const way = (tags, geometry) => ({ type: "way", id: id++, tags, geometry });
  const node = (tags, x, y) => ({ type: "node", id: id++, lat: pt(x, y).lat, lon: pt(x, y).lon, tags });
  const building = (x, y) => ({ type: "way", id: id++, tags: { building: "house" }, center: pt(x, y) });
  return { pt, rect, way, node, building };
}

/**
 * Hügeliges Gelände nahe Bebauung (für Screenshot und Riegel-/Objektschutztests):
 * Grünland/Wald, Siedlung im Nordosten (Wind aus Südwest), zwei Wirtschaftswege quer zur
 * Ausbreitungsrichtung, ein Weg direkt am Brand (darf NICHT vorgeschlagen werden), Hydrant, Teich.
 */
export function hillOsm(lat0, lon0) {
  const { pt, rect, way, node, building } = makeTools(lat0, lon0);
  // Hilfsfunktion: Linie quer zur Richtung 45° (NO) im Abstand d vom Brand, halbe Länge h
  const cross45 = (d, h) => { const c = d / Math.SQRT2; return [pt(c - h / Math.SQRT2, c + h / Math.SQRT2), pt(c, c), pt(c + h / Math.SQRT2, c - h / Math.SQRT2)]; };
  const els = [
    way({ landuse: "meadow" }, rect(-5000, -5000, 5000, 5000)),
    way({ landuse: "forest", leaf_type: "broadleaved" }, rect(-900, -700, 200, 300)),
    way({ landuse: "forest", leaf_type: "needleleaved" }, rect(-2500, 1200, -800, 2600)),
    way({ landuse: "residential", name: "Testsiedlung Nordost" }, rect(1050, 1000, 1700, 1500)),
    way({ highway: "track", tracktype: "grade2", name: "Weg nahe Brand" }, cross45(140, 400)),
    way({ highway: "track", tracktype: "grade1", name: "Hangweg" }, cross45(700, 900)),
    way({ highway: "unclassified", name: "Talstraße" }, [pt(-1500, -2600), pt(400, -1200), pt(2800, 100)]),
    way({ highway: "residential", name: "Siedlungsstraße" }, [pt(900, 1250), pt(1800, 1250)]),
    way({ highway: "residential" }, [pt(1350, 900), pt(1350, 1600)]),
    way({ waterway: "stream", name: "Testbach" }, [pt(-3000, 400), pt(-400, -200), pt(500, -2200)]),
    node({ emergency: "fire_hydrant" }, 1000, 1200),
    way({ natural: "water", name: "Löschteich (synthetisch)" }, rect(300, 900, 360, 950)),
  ];
  for (let k = 0; k < 8; k++) for (let q = 0; q < 4; q++) els.push(building(1100 + k * 70, 1050 + q * 110));
  return { version: 0.6, osm3s: { timestamp_osm_base: "SYNTHETISCHE TESTDATEN" }, elements: els };
}
