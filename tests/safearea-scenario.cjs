/*
 * SYNTHETISCHES Demoszenario für das Modul "Safe Areas und Fluchtwege".
 * Keine echten Daten: Gelände, Landnutzung, Wege, Wetter und Fahrzeugstandorte sind erfunden
 * und dienen ausschließlich der Vorführung und den Tests. Nicht für den Einsatz.
 *
 * Wird sowohl von demo.html (klassisches Skript) als auch von tests/safearea.test.mjs genutzt.
 */
(function (root) {
  // Mittelpunkt: synthetische Lage (nicht die reale Einsatzgemeinde)
  const LAT0 = 50.8, LON0 = 7.3;

  /** Overpass-ähnliche Testdaten; Koordinaten relativ zum Mittelpunkt in Metern. */
  function osmJson(lat0, lon0) {
    const dy = (m) => m / 111195, dx = (m) => m / (111195 * Math.cos((lat0 * Math.PI) / 180));
    const pt = (x, y) => ({ lat: lat0 + dy(y), lon: lon0 + dx(x) });
    const rect = (x0, y0, x1, y1) => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1), pt(x0, y0)];
    let id = 1;
    const way = (tags, geometry) => ({ type: "way", id: id++, tags, geometry });
    const els = [
      // Grundfläche Grünland, darin Gebüsch/Heide (Brandherd, schnelle Ausbreitung) und Wald
      way({ landuse: "meadow" }, rect(-2600, -2600, 2600, 2600)),
      way({ natural: "scrub", name: "Heidefläche (synthetisch)" }, rect(-900, -900, 600, 900)),
      way({ landuse: "forest", leaf_type: "needleleaved" }, rect(600, 300, 1600, 1600)),
      way({ landuse: "forest", leaf_type: "broadleaved" }, rect(-1800, 600, -1000, 1600)),
      // Kandidatenflächen
      way({ natural: "water", name: "Weiher (synthetisch)" }, rect(700, 1100, 1000, 1380)),
      way({ landuse: "farmland", name: "Ackerschlag Nord (synthetisch)" }, rect(-700, 1300, 300, 2100)),
      way({ landuse: "quarry", name: "Steinbruch (synthetisch)" }, rect(1150, -500, 1700, 100)),
      way({ amenity: "parking", name: "Wanderparkplatz (synthetisch)" }, rect(-1750, 250, -1650, 330)),
      way({ amenity: "parking", name: "Kleiner Waldparkplatz (synthetisch)" }, rect(-1000, -1250, -950, -1200)),
      way({ leisure: "pitch", name: "Sportplatz (synthetisch)" }, rect(-2100, -1500, -1850, -1330)),
      // Wege: Talstraße im Süden, Waldwege zu den Flächen
      way({ highway: "unclassified", name: "Talstraße (synthetisch)" }, [pt(-2500, -1800), pt(0, -1700), pt(2500, -1500)]),
      way({ highway: "track", tracktype: "grade1", name: "Steinbruchweg" }, [pt(500, -1650), pt(1100, -900), pt(1400, -400)]),
      way({ highway: "track", tracktype: "grade2", name: "Weiherweg" }, [pt(250, -1680), pt(620, 300), pt(800, 1100)]),
      way({ highway: "track", tracktype: "grade2", name: "Westweg" }, [pt(-1700, -1760), pt(-1700, 300)]),
      way({ highway: "track", tracktype: "grade1", name: "Ackerweg" }, [pt(-1690, 310), pt(-900, 1400), pt(-400, 1600)]),
      way({ highway: "track", tracktype: "grade2", name: "Heideweg" }, [pt(-980, -1220), pt(-700, -500), pt(-350, 400)]),
      // Bebauung im Nordosten (Schutzobjekt, keine Rückzugsfläche)
      way({ landuse: "residential", name: "Testsiedlung (synthetisch)" }, rect(1700, 1700, 2300, 2200)),
      // Entnahmestelle
      { type: "node", id: id++, lat: pt(800, 1150).lat, lon: pt(800, 1150).lon, tags: { emergency: "suction_point" } },
    ];
    for (let k = 0; k < 6; k++) els.push({ type: "way", id: id++, tags: { building: "house" }, center: pt(1760 + k * 90, 1800) });
    return { version: 0.6, osm3s: { timestamp_osm_base: "SYNTHETISCHE TESTDATEN" }, elements: els };
  }

  /**
   * Synthetisches Gelände: Rücken, der nach Nordosten ansteigt, mit einer Mulde im Süden.
   * Damit ist der Rückzug nach Nordosten bergauf, nach Süden bergab (für die Fluchtzeiten sichtbar).
   */
  function setElevation(Grid, g) {
    const elev = new Float32Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell;
      const ne = (x + y) / Math.SQRT2;
      elev[j * g.nx + i] = 320 + 0.065 * ne + 18 * Math.sin(x / 900) - 12 * Math.cos(y / 1100);
    }
    g.elev = elev;
    g.elevMissing = 0;
    Grid.terrain(g);
    return g;
  }

  function weatherHours(n) {
    const out = [];
    for (let h = 0; h < n; h++) {
      out.push({ t: h * 3600000, windKmh: 32, windDirDeg: 225, gustKmh: 50, tempC: 31, rh: 24, rain24: 0, rain72: 0 });
    }
    return out;
  }

  /** Fahrzeugstandorte wie sie js/suggest.js liefern würde (synthetisch). */
  function positions(g) {
    const at = (x, y) => { const [la, lo] = g.proj.toLatLng(x, y); return { lat: la, lon: lo }; };
    return [
      { id: "fz:se-hlf20", vehicleId: "se-hlf20", name: "HLF 20 Seelscheid", label: "Riegel R1, Abschnitt 1/2", taskKind: "Riegel", ...at(620, 300) },
      { id: "fz:se-lf20", vehicleId: "se-lf20", name: "LF 20 Seelscheid", label: "Riegel R1, Abschnitt 2/2", taskKind: "Riegel", ...at(710, 700) },
      { id: "fz:nk-tlf3000", vehicleId: "nk-tlf3000", name: "TLF 3000 Neunkirchen", label: "Wasserversorgung R1", taskKind: "Wasserversorgung", ...at(800, 1050) },
      { id: "fz:nk-hlf10", vehicleId: "nk-hlf10", name: "HLF 10 Neunkirchen", label: "Objektschutz Testsiedlung", taskKind: "Objektschutz", ...at(1690, 1680) },
      { id: "fz:se-lfkats", vehicleId: "se-lfkats", name: "LF KatS Seelscheid", label: "Riegel R1 (Standort verschoben)", taskKind: "Riegel", ...at(-150, -150) },
      { id: "fz:nk-lf10", vehicleId: "nk-lf10", name: "LF 10 Neunkirchen", label: "Flankensicherung links", taskKind: "Riegel", ...at(-300, -250) },
      { id: "fz:nk-mtf", vehicleId: "nk-mtf", name: "MTF Neunkirchen", label: "Bereitstellung: Reserve", taskKind: "Bereitstellung", ...at(250, -1650) },
    ];
  }

  /**
   * Baut das Szenario: Raster, Gelände, OSM, Prognose.
   * @param deps {Grid, FireModel, Osm, SafeArea, P}
   */
  async function build(deps, opt = {}) {
    const { Grid, FireModel, Osm, SafeArea, P } = deps;
    const CL = Object.keys(P.fuelClasses);
    const halfSizeM = opt.halfSizeM ?? 2500, cellM = opt.cellM ?? 25;
    const g = Grid.makeGrid(LAT0, LON0, halfSizeM, cellM, CL);
    if (opt.dem !== false) setElevation(Grid, g);
    const json = opt.osm === false ? null : osmJson(LAT0, LON0);
    const osm = json ? Osm.applyOsm(g, json, P) : null;
    if (osm && opt.extra !== false) osm.safeAreaExtra = SafeArea.rasterExtra(g, json);
    const hours = weatherHours(Math.max(...P.horizonsH) + 1);
    // Brandfläche: Kreis mit 120 m Radius im Nadelwald, Südwesten
    const ring = [];
    for (let a = 0; a < 24; a++) {
      const t = (a / 24) * 2 * Math.PI;
      ring.push(g.proj.toLatLng(-500 + 120 * Math.cos(t), -400 + 120 * Math.sin(t)));
    }
    const ignition = Grid.polygonCells(g, ring);
    const result = await FireModel.runEnsemble({
      grid: g, classList: CL, ignition, weatherHours: hours, P,
      runs: opt.runs ?? P.ensemble.runs, terrain: opt.terrain ?? false,
    });
    return { grid: g, result, osm, ignition, weatherHours: hours, positions: positions(g), poly: ring, osmJson: json, lat0: LAT0, lon0: LON0 };
  }

  const SafeAreaDemo = { LAT0, LON0, osmJson, setElevation, weatherHours, positions, build };
  root.SafeAreaDemo = SafeAreaDemo;
  if (typeof module !== "undefined" && module.exports) module.exports = SafeAreaDemo;
})(typeof globalThis !== "undefined" ? globalThis : this);
