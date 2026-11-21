/*
 * Zentrale, versionierte Modellparameter und Annahmen.
 * Jede Zahl hier ist eine ANNAHME, solange sie nicht mit Feuerwehr/Forst
 * (z. B. Landesbetrieb Wald und Holz NRW) abgestimmt ist. Siehe docs/assumptions.md.
 * Änderungen hier erhöhen PARAMS.version.
 */
(function (root) {
  const TPA = 0.0459137; // 1 ton/acre (US short ton) in lb/ft²

  const PARAMS = {
    version: "0.3.0-prototyp",
    modelName: "Rothermel-1972-Raster-MTT (vereinfachte Eigenimplementierung)",

    // Prognosehorizonte in Stunden (Spezifikation 2.3)
    horizonsH: [1, 2, 4, 6],

    grid: {
      // Annahme: halbe Kantenlänge des Rechengebiets um den Brandschwerpunkt
      halfSizeM: 5000,
      // Annahme: Rechenauflösung (Spezifikation 3.4: 10-25 m)
      cellM: 25,
    },

    ensemble: {
      // Annahme: Parameterbereiche des Ensembles (gleichverteilt)
      runs: 24,
      seed: 20240601,
      windDirDeg: 25, // ± Grad um den Eingangswert
      windSpeedFactor: [0.75, 1.35],
      deadMoistureAbs: 2, // ± Prozentpunkte auf 1-h/10-h/100-h-Feuchte
      // Schwellen für die Bandanzeige (Anteil der Läufe, in denen eine Zelle brennt)
      likely: 0.5, // "wahrscheinlich"
      possible: 0.1, // "möglich"
    },

    // Geländemodell (DGM1 NRW, Geobasis NRW, dl-de/zero-2-0; erzeugt mit tools/build-dgm.py)
    dem: {
      url: "data/dgm25.json", // Metadaten; Binärdatei laut meta.file im selben Verzeichnis
      // Hangfaktor nach Rothermel (1972): phiS = 5.275 * beta^-0.3 * tan²(Neigung).
      // VEREINFACHTE ANNAHME: Zuschlag R0 * phiS bergauf je Rasterkante zur Wind-Ellipsenrate
      // addiert (nicht vektoriell kombiniert, Phase 2); bergab keine Verlangsamung.
      // Annahme: Obergrenze tan = 0,7 (ca. 35°); steiler wird nicht weiter extrapoliert.
      maxTanSlope: 0.7,
      // Darstellung der Offline-Schummerung (nur Anzeige)
      hillshade: { azimuthDeg: 315, altitudeDeg: 45, zFactor: 1.5 },
    },

    weather: {
      maxAgeH: 3, // Spezifikation: Warnung bei Wetterdaten älter als 3 h (Annahme)
    },

    moisture: {
      // Annahme: einfacher Ansatz für Tote-Brennstoff-Feuchte (siehe weather.js)
      // 1-h-Feuchte = Gleichgewichtsfeuchte (Simard 1968) + Regenzuschlag
      rain24hFactor: 2.0, // %-Punkte je mm Regen der letzten 24 h
      rainMaxAdd: 15, // maximaler Regenzuschlag in %-Punkten
      add10h: 1, // 10-h = 1-h + 1 %-Punkt
      add100h: 2, // 100-h = 1-h + 2 %-Punkte + Regen 72 h
      rain72hFactor100h: 1.0,
      min: 3,
      max: 40,
      liveHerb: 90, // % Annahme (Sommer, grün) - konservativ niedrig
      liveWoody: 120, // % Annahme
    },

    // Annahme: Windreduktion von 10-m-Wind auf Flammenhöhe (Wind Adjustment Factor)
    // Hinweis: Rothermel/BehavePlus beziehen WAF auf 20-ft-Wind; hier vereinfacht auf 10-m-Wind.
    waf: { offen: 0.4, wald: 0.2 },

    // Barrieren: OSM-Linien, die im Modell als nicht brennbar gerastert werden.
    // Wald-/Feldwege (track/path) werden NICHT als Barriere gerechnet (konservativ),
    // aber als Riegelkandidaten genutzt.
    barrierHighways: ["motorway", "trunk", "primary", "secondary", "tertiary",
      "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
      "unclassified", "residential"],
    barrierWaterways: ["river", "canal"],

    // Annahme: Zuordnung OSM-Klasse -> Brennstoffmodell (Anderson 1982, 13 Modelle).
    // MUSS mit Forst/Feuerwehr abgestimmt werden (Spezifikation 3.1, fachliche Warnung).
    fuelClasses: {
      nadelwald: { label: "Nadelwald", model: 10, waf: "wald", color: "#2f5d3a" },
      laubwald: { label: "Laubwald", model: 9, waf: "wald", color: "#6b9a4b" },
      mischwald: { label: "Mischwald / Wald ohne Angabe", model: 8, waf: "wald", color: "#4f7d45" },
      gruenland: { label: "Grünland / Wiese", model: 1, waf: "offen", color: "#c9d77a" },
      acker: { label: "Acker", model: 1, waf: "offen", color: "#e3d38a" },
      gebuesch: { label: "Gebüsch / Heide / Brache", model: 5, waf: "offen", color: "#a2a14f" },
      unbekannt: { label: "Unbekannt (keine OSM-Fläche)", model: 1, waf: "offen", color: "#d8d2c0" },
      siedlung: { label: "Siedlung (nicht brennbar gerechnet)", model: 0, waf: "offen", color: "#b9b2b0" },
      wasser: { label: "Wasser", model: 0, waf: "offen", color: "#7fb2d6" },
      barriere: { label: "Straße/Fluss (Barriere)", model: 0, waf: "offen", color: "#777777" },
    },

    // Anderson (1982) 13 Fuel Models: Beladung in ton/acre, SAV in 1/ft, Tiefe in ft, Mx in %.
    // Quelle: Anderson, H.E. (1982) Aids to determining fuel models..., GTR INT-122.
    // Hinweis: aus Literaturkenntnis übertragen, Abgleich mit Primärquelle "Zu prüfen".
    fuelModels: {
      1: { name: "FM1 Kurzes Gras", w: [0.74, 0, 0, 0, 0], sav1: 3500, savLH: 1500, savLW: 1500, depth: 1.0, mx: 12 },
      2: { name: "FM2 Gras unter Bäumen", w: [2.0, 1.0, 0.5, 0.5, 0], sav1: 3000, savLH: 1500, savLW: 1500, depth: 1.0, mx: 15 },
      3: { name: "FM3 Hohes Gras", w: [3.01, 0, 0, 0, 0], sav1: 1500, savLH: 1500, savLW: 1500, depth: 2.5, mx: 25 },
      5: { name: "FM5 Gebüsch", w: [1.0, 0.5, 0, 0, 2.0], sav1: 2000, savLH: 1500, savLW: 1500, depth: 2.0, mx: 20 },
      8: { name: "FM8 Nadelstreu geschlossen", w: [1.5, 1.0, 2.5, 0, 0], sav1: 2000, savLH: 1500, savLW: 1500, depth: 0.2, mx: 30 },
      9: { name: "FM9 Laubstreu", w: [2.92, 0.41, 0.15, 0, 0], sav1: 2500, savLH: 1500, savLW: 1500, depth: 0.2, mx: 25 },
      10: { name: "FM10 Streu mit Unterwuchs", w: [3.01, 2.0, 5.01, 0, 2.0], sav1: 2000, savLH: 1500, savLW: 1500, depth: 1.0, mx: 25 },
    },
    tonPerAcreToLbFt2: TPA,

    // Kartenanzeige der Prognose (nur Darstellung, beeinflusst die Rechnung nicht)
    display: {
      defaultMode: "kontur", // "kontur" (geglättete Isochronen) oder "raster" (25-m-Kästchen)
      contour: {
        chaikinIterations: 2, // Chaikin-Glättung der Marching-Squares-Isochronen
        simplifyCells: 0.2, // Douglas-Peucker-Toleranz in Zellen (0,2 x 25 m = 5 m)
        warnAreaDevPct: 5, // Hinweis, wenn Konturfläche um mehr als 5 % von der Rasterfläche abweicht
      },
    },

    suggestions: {
      // --- Zeitbezug: Einsatzbereitschaft an einer Linie = Prognosebeginn + Anfahrt + Aufbau ---
      // Annahme: Alarmierung + Anfahrt bis zur Linie (min). Kein Routing; Gemeindegebiet ca. 10 x 10 km,
      // letzte Strecke auf Wald-/Feldwegen. MUSS mit der Feuerwehr abgestimmt werden (offen).
      anfahrtMin: 30,
      // Annahme: Aufbau einer Riegelstellung (Schlauchleitungen, Stellung beziehen) (min), offen
      setupMin: 45,
      // Annahme: Aufbau Objektschutz (kürzere Leitungen am Objekt) (min), offen
      objectSetupMin: 15,
      // Annahme: Sicherheitspuffer Fahrzeugstandort: früheste Ankunft der Front (einzelner Lauf) muss
      // mindestens so viele Minuten NACH der Einsatzbereitschaft liegen
      vehicleSafetyMin: 60,
      // Annahme: Mindestabstand Fahrzeug zum "möglich"-Bereich 1 h (m)
      vehicleMinDistM: 100,
      // --- Riegellinien ---
      // Annahme: Mindest-Wirkzeit an der Linie nach Einsatzbereitschaft (min). Geprüft wird gegen die
      // "möglich"-Zone zum Zeitpunkt Bereitschaft + Wirkzeit (75 + 30 = 105 min). 0 = nur Bereitschaft.
      lineMinLeadMin: 30,
      // Annahme: Mindestabstand jeder Linienzelle zur "möglich"-Zone zum Prüfzeitpunkt (m)
      lineClearanceM: 50,
      // Linie gilt als "im Ausbreitungsbereich", wenn sie höchstens so weit von der 6-h-"möglich"-Zone entfernt ist (m)
      lineReachM: 50,
      lineMinLengthM: 100,
      // Annahme: Verlängerung über den Ausbreitungsbereich hinaus für den Flankenanschluss (m je Seite)
      lineExtendM: 150,
      // Annahme: "quer" = Winkel zwischen Linie und Hauptausbreitungsrichtung mindestens 45°
      lineMinCrossDeg: 45,
      // Annahme: "vor der Front" = Linienmitte innerhalb ±60° um die Hauptausbreitungsrichtung
      lineMaxSectorDeg: 60,
      maxLines: 3,
      // Annahme: Gewichte der Riegelbewertung (nur gültige Linien werden bewertet)
      weights: { barrierType: 1.0, bufferTime: 1.0, length: 0.3, protects: 0.8, downwind: 0.8, cross: 0.5, coverage: 1.5 },
      barrierTypeScore: {
        primary: 1.0, secondary: 1.0, tertiary: 0.9, unclassified: 0.8, residential: 0.8,
        track: 0.6, service: 0.6, path: 0.3, river: 1.0, stream: 0.5, railway: 0.9,
        forest_edge_broadleaf: 0.4,
      },
      // --- Fahrzeugzuordnung ---
      // Annahme: wirksamer Linienabschnitt je Löschfahrzeug (m), z. B. Schlauchleitung nach beiden Seiten
      // vom Standort; Anzahl Fahrzeuge je Linie = Linienlänge / Abschnitt (aufgerundet)
      sectionPerVehicleM: 300,
      maxVehiclesPerLine: 4,
      // Bebauung gilt als bedroht, wenn sie höchstens so weit von der 6-h-"möglich"-Zone entfernt ist (m)
      objectThreatDistM: 50,
      // Annahme: Gebäude/Wohnflächen mit Lücken bis 100 m bilden ein Objekt (ein Objektschutz-Vorschlag)
      objectClusterGapM: 100,
      maxObjectTasks: 4,
      // Annahme: Wasserentnahme über Schlauchleitung bis 300 m Luftlinie, darüber Pendelverkehr
      hoseMaxM: 300,
      // Annahme: Wasserabgabe eines Fahrzeugs im Riegel (l/min) für Pendel-Abschätzung
      waterUseLpm: 400,
      // Annahme: mittlere Pendelgeschwindigkeit (km/h) mangels Routing
      shuttleKmh: 25,
      // Fahrzeugtypen, die als Löschfahrzeug für Riegel/Objektschutz vorgeschlagen werden
      suppressionTypes: ["HLF 20", "LF 20", "LF KatS", "LF 10", "TLF 3000", "TLF 4000", "MLF"],
      // Fahrzeugtypen ohne Löschwasser: nie Riegel/Objektschutz/Pendel (Präfix-Vergleich)
      noWaterTypes: ["ELW", "KdoW", "MTF", "MTW", "DLK", "DL", "GW", "RW"],
    },
  };

  root.PARAMS = PARAMS;
  if (typeof module !== "undefined" && module.exports) module.exports = PARAMS;
})(typeof globalThis !== "undefined" ? globalThis : this);
