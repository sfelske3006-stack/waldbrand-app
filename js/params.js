/*
 * Zentrale, versionierte Modellparameter und Annahmen.
 * Jede Zahl hier ist eine ANNAHME, solange sie nicht mit Feuerwehr/Forst
 * (z. B. Landesbetrieb Wald und Holz NRW) abgestimmt ist. Siehe docs/assumptions.md.
 * Änderungen hier erhöhen PARAMS.version.
 */
(function (root) {
  const TPA = 0.0459137; // 1 ton/acre (US short ton) in lb/ft²

  const PARAMS = {
    version: "0.6.0-prototyp",
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

    // ------------------------------------------------------------------ Geländeeinfluss (neu in 0.4.0)
    // VEREINFACHTE, DIAGNOSTISCHE Korrektur des Windes und der Feinbrennstofffeuchte aus dem DGM.
    // KEIN massenkonsistentes Windfeld (WindNinja o. ä.: Phase-3-Option), keine Wirbel/Leewalzen,
    // keine feuerinduzierten Winde, keine Inversionen, kein Föhn. Alle Zahlen sind ANNAHMEN.
    terrain: {
      wind: {
        enabled: true, // Schalter "Geländewind" (UI überschreibt je Rechnung); aus = Rechnung wie 0.3.0 (bitgenau)
        // Glättung der Eingangsfelder (Box-Filter, Radius in Zellen, Durchläufe) gegen Rasterartefakte
        smoothRadiusCells: 2, smoothPasses: 3,
        // Abschattung/Exposition: Winstral-Sx (Winstral, Elder & Davis 2002) = max. Horizontwinkel in
        // Luv-Richtung bis sxMaxDistM; > 0 = abgeschattet (Lee), < 0 = exponiert. Normierung sxScaleDeg.
        sxMaxDistM: 300, sxSectors: 16, sxScaleDeg: 15, sxWeight: 0.25,
        // Topographic Position Index: Höhe minus mittlere Höhe im Quadrat ±tpiRadiusM; > 0 Kuppe, < 0 Mulde/Tal
        tpiRadiusM: 400, tpiScaleM: 40, tpiWeight: 0.15,
        // Luv-/Leehang: Hangneigung in Windrichtung (tan), angelehnt an MicroMet (Liston & Elder 2006),
        // Gewichte eigene Annahme. Normierung slopeScaleTan.
        slopeScaleTan: 0.3, slopeWeight: 0.15,
        // Faktor auf die Windgeschwindigkeit, begrenzt (Annahme laut Auftrag 0,5–1,4)
        factorMin: 0.5, factorMax: 1.4,
        // Talkanalisierung: Tal = TPI < -valleyDepthM[0] (voll ab -valleyDepthM[1]); Talachse aus dem
        // Strukturtensor der Hangneigung (Fenster ±valleyWindowM); Kohärenz als Maß für ein ausgeprägtes Tal.
        valleyDepthM: [5, 30], valleyWindowM: 150, valleyCoherence: [0.3, 0.7],
        // maximaler Anteil, um den die Windrichtung zur Talachse gedreht wird (bei Taltiefe/Kohärenz voll);
        // zusätzlich gewichtet mit cos(Winkel Wind–Talachse): quer zum Tal keine eindeutige Drehung
        valleyMaxTurn: 0.7,
        // Dämpfung der Windgeschwindigkeit quer zur Talachse (Anteil bei voller Taltiefe, Wind quer)
        valleyCrossDamping: 0.3,
        // Hang-/Talwind (thermisch): nur bei schwachem synoptischem Wind (10 m) unter thermalMaxSynKmh,
        // linear abnehmend bis zur Schwelle; tagsüber hangaufwärts, nachts hangabwärts (Annahme).
        thermalMaxSynKmh: 12,
        thermalUpKmh: 7.2, // 2 m/s (Annahme, Größenordnung 1–3 m/s)
        thermalDownKmh: 5.4, // 1,5 m/s (Annahme)
        thermalFullTan: 0.3, // volle Stärke ab Hangneigung tan 0,3 (ca. 17°), darunter linear
        thermalSunFullDeg: 20, // tags volle Stärke ab Sonnenhöhe 20° (darunter linear ab 0°)
        thermalNightFullDeg: 6, // nachts volle Stärke, wenn die Sonne mehr als 6° unter dem Horizont steht
        // Ensemble: Stärke aller Geländekorrekturen (Wind und Feuchte) je Lauf gleichverteilt in diesem Bereich
        ensembleStrength: [0.5, 1.5],
        // Anzeige "Geländewind": Pfeilabstand (m) und Pfeillänge bei Faktor 1 (m)
        displaySpacingM: 250, displayArrowM: 170,
      },
      moisture: {
        enabled: true, // Feinbrennstofffeuchte nach Exposition/Einstrahlung (nur mit DGM und Geländewind-Schalter)
        // EIGENE, EINFACHE ANNAHME (keine Fosberg/Rothermel-Korrekturtabelle übernommen, Werte nicht sicher bekannt):
        // dM = -kPerUnit * (cos(Einfallswinkel Hang) - cos(Zenit)) tagsüber (wolkenlos angenommen), nachts 0.
        // Südhänge (Sonne steht im Süden) daher trockener, Nordhänge feuchter; Größenordnung bis ca. 3 %-Pkt.
        kPerUnit: 8, maxDry: 3, maxWet: 3,
        // auf welche Totholz-Klassen die Korrektur wirkt (Anteil): 1 h und 10 h voll, 100 h nicht
        apply: { d1: 1, d10: 1, d100: 0 },
        binPct: 0.25, // Quantisierung für die Ratentabelle (%-Punkte)
      },
    },

    // Anfahrt (neu in 0.4.0): entfernungsbasierte SCHÄTZUNG, KEIN Routing.
    // Anfahrt = Ausrückzeit + Luftlinie Wache->Einsatzstelle x Umwegfaktor / Geschwindigkeit.
    anfahrt: {
      umwegfaktor: 1.4, // Annahme (Straßennetz im Bergischen Land), zu prüfen
      // mittlere Geschwindigkeit je Fahrzeugklasse (km/h, Annahme); Präfixvergleich mit dem Fahrzeugtyp
      kmh: { ELW: 60, KdoW: 60, MTF: 60, MTW: 60, MLF: 50, "HLF": 50, "LF": 50, "TLF": 45, "TSF": 50, "GW": 50, "DLK": 45, "SW": 45, default: 50 },
      // Ausrückzeit (Alarm bis Abfahrt) in min, Annahme; Wache kann "ausrueckzeit_min" angeben.
      ausrueckMin: { FF: 7, BF: 1.5, default: 7 }, // Freiwillige Feuerwehr 5–8 min -> 7 (Annahme)
      maxAnfahrtMin: 45, // Option "nur Fahrzeuge bis X min Anfahrt einplanen" (Default, Annahme)
      // Riegel gilt als einsatzbereit, wenn das n-t nächste geeignete Löschfahrzeug angekommen ist (Annahme)
      // Seit 0.4.0 (Vorgabe: Bereitschaft je Fahrzeug): Prüfgrenze für Riegel = früheste Bereitschaft (Rang 1);
      // je Abschnitt wird geprüft, ob das zugeordnete Fahrzeug rechtzeitig mit Wirkzeit-Reserve bereit ist.
      lineReadyVehicleRank: 1,
      // Begrenzung des Bereitstellungsraums bei vielen Fahrzeugen (Annahme): nächstgelegene zuerst,
      // weitere geeignete Fahrzeuge werden als "nicht benötigt" gemeldet (nicht eingeplant).
      maxReserve: 3, maxStageLead: 2, maxStageCrew: 2,
    },

    // Bereitschaft der eigenen Wehr (VORGABE AUFTRAGGEBER, 22.11.2026 – keine Annahme): Zeit von Alarm bis
    // "vor Ort und löschbereit" (Gesamtzeit inkl. Ausrücken, Anfahrt und Aufbau) für die Fahrzeuge der Feuerwehr
    // Neunkirchen-Seelscheid. Ersetzt für diese Fahrzeuge Anfahrt + Aufbau. Mindest-Wirkzeit bleibt separat
    // (suggestions.lineMinLeadMin). Fahrzeuge anderer Kommunen: entfernungsbasierte Schätzung + Aufbau (Annahme).
    bereitschaftEigeneWehr: {
      quelle: "Vorgabe Auftraggeber, 22.11.2026",
      gleicherTeil: 25, // Einsatzort im eigenen Gemeindeteil des Löschzugs
      andererTeil: 40, // Einsatzort im anderen Gemeindeteil
      kommune: "Neunkirchen-Seelscheid",
      wachenTeil: { "lz-nk": "Neunkirchen", "lz-se": "Seelscheid" },
      // ANNAHME: Gemeindeteil unbekannt (keine Grenzdaten, keine Wahl) -> 40 min für beide Löschzüge (konservativ)
      unbekanntMin: 40,
      // ANNAHME: Einsatzort außerhalb des Gemeindegebiets -> entfernungsbasierte Schätzung + Aufbau, aber nicht
      // schneller als gleicherTeil (25 min); ohne Wachenkoordinate andererTeil (40 min)
      ausserhalbMinMin: 25,
      // Grenzdatei der Gemeindeteile (abgeleitet aus ALKIS-Gemarkungen, siehe tools/build-gemeindeteile.py)
      grenzenUrl: "data/gemeindeteile.json",
    },

    // Pflichtfahrzeuge (Vorgabe Auftraggeber, 0.4.0): werden bei JEDEM Einsatz eingebunden, vorrangig vor allen
    // anderen Fahrzeugen und unabhängig vom Anfahrts-Limit. Sicherheitsregeln gelten weiter; ohne sichere
    // Aufgabe: "Pflichtfahrzeug – bereitgestellt" im Bereitstellungsraum nahe der Einsatzstelle.
    // Ids aus data/fahrzeuge.json (Löschzug Seelscheid). Im UI je Fahrzeug änderbar (Häkchen "Pflicht").
    // Ohne Wachenkoordinate wird für sie der pauschale Ersatzwert suggestions.anfahrtMin angenommen (gekennzeichnet).
    pflichtFahrzeuge: ["se-hlf20", "se-lfkats", "se-lf20"],

    // Grundschutz (Vorgabe Auftraggeber, 0.4.0): je ein wasserführendes Fahrzeug aus einer NACHBARKOMMUNE an den
    // Gerätehäusern der eigenen Kommune. Auswahl: Typstufe (Annahme: zuerst HLF/LF, dann TLF/MLF/TSF-W, dann
    // sonstige wasserführende), innerhalb der Stufe kürzeste geschätzte Anfahrt zum Gerätehaus; nicht im Einsatz
    // eingeplant, nicht doppelt. Manuell änderbar.
    grundschutz: {
      kommune: "Neunkirchen-Seelscheid",
      wachen: ["lz-nk", "lz-se"],
      typStufen: [["HLF", "LF"], ["TLF", "MLF", "TSF-W"]],
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
      // SEIT 0.4.0 NUR NOCH ERSATZWERT: Die Bereitschaft wird aus der geschätzten Anfahrt der Fahrzeuge
      // (PARAMS.anfahrt) berechnet. 30 min gelten nur, wenn kein Fahrzeug eine Wachenkoordinate hat.
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
      // ANNAHME (0.4.2, NICHT fachlich belegt): sind nach der Grundbesetzung (Linienlänge / sectionPerVehicleM)
      // noch rechtzeitig einsatzbereite Löschfahrzeuge übrig, wird die Linie bis maxVehiclesPerLine dichter
      // besetzt (Verstärkung/Ablösung), statt die Fahrzeuge als Reserve zu parken. Mit der Feuerwehr klären:
      // wirksamer Abschnitt je Fahrzeug und sinnvolle Mindestbesetzung je Linie (offen).
      lineReinforceToMax: true,
      // ANNAHME (0.4.2): zweite Riegelstellung (Auffanglinie) für die ZWEITE Bereitschaftsstufe, wenn
      // Fahrzeuge für die vorderste Linie zu spät einsatzbereit sind (z. B. Löschzug im anderen Gemeindeteil:
      // 40 statt 25 min). Anzahl zusätzlicher Linien und Mindestabstand zur ersten Linie (m).
      secondStageLines: 1,
      lineMinSeparationM: 200,
      // ANNAHME (0.4.2, NICHT mit der Feuerwehr abgestimmt): Flankensicherung. Bleiben wasserführende
      // Fahrzeuge ohne Aufgabe übrig, werden bis zu maxFlankVehicles seitlich der Hauptausbreitungsrichtung
      // eingesetzt (Abstand = seitliche Ausdehnung der „möglich“-Zone + flankOffsetM je Stufe). Es wird KEINE
      // durchgehende Flankenlinie geprüft; die Sicherheitsprüfung des Standorts gilt unverändert.
      maxFlankVehicles: 2,
      flankOffsetM: 150,
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
      // Großtanker/Wassertransport: nur Wasserversorgung/Pendelverkehr, dort bevorzugt (Annahme; Präfixvergleich)
      waterSupplyOnlyTypes: ["TW ", "LTW", "WLF"],
    },
  };

  root.PARAMS = PARAMS;
  if (typeof module !== "undefined" && module.exports) module.exports = PARAMS;
})(typeof globalThis !== "undefined" ? globalThis : this);
