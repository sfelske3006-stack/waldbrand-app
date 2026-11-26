/*
 * Parameterblock "wasser" (Modul Wasserversorgung). Für die Integration wird der Inhalt von
 * WASSER_PARAMS unverändert als PARAMS.wasser in js/params.js übernommen (siehe INTEGRATION.md).
 * JEDE Zahl ist eine ANNAHME, solange sie nicht mit der Feuerwehr / dem Wasserversorger abgestimmt ist.
 * Quellenangaben und Status: docs/assumptions.md (Abschnitt „Neu in 0.6.0 (Wasserversorgung)“). Kennzeichnung im Kommentar:
 *   [A] Annahme ohne belegte Quelle, [F] Faustwert aus der Feuerwehrausbildung (Primärquelle nicht eingesehen),
 *   [P] physikalisch, [V] Vorgabe Auftraggeber, [App] übernommen aus den bestehenden App-Parametern.
 */
(function (root) {
  const WASSER_PARAMS = {
    version: "0.1.0-entwurf",
    hinweis: "Simulation mit Annahmen, keine Einsatzplanung.",
    horizonMin: 360, // [V] Prognosezeitraum 6 h
    dtMin: 1, // [V] Zeitschritt 1 min

    // ---------------------------------------------------------------- Wasserbedarf der Abnehmer
    bedarf: {
      // [A] je Löschfahrzeug am Riegel: 2 C-Rohre à 150 l/min (Auftrag: 100–200 l/min je Rohr), durchgehend
      riegel: { rohre: 2, lpmJeRohr: 150 },
      // [A] Objektschutz: 2 C-Rohre à 100 l/min
      objektschutz: { rohre: 2, lpmJeRohr: 100 },
      // [A] alternativ Riegel mit Wenderohr (Abnehmer mit mode "wenderohr")
      wenderohrLpm: 800,
      // [A] Anteil der Zeit, in der tatsächlich Wasser abgegeben wird (1 = durchgehend, konservativ)
      einsatzAnteil: 1,
      // [A] eigener Tank des Abnehmers wird aus dem Becken nachgefüllt, solange das Becken >= 50 % voll ist
      tankNachfuellLpm: 400,
      tankNachfuellAbFuellstand: 0.5,
      // [A] Hinweis, wenn der Schlauchweg Becken -> Abnehmer länger ist
      maxAbstandBeckenM: 400,
    },

    // ---------------------------------------------------------------- Entnahmestellen
    quellen: {
      hydrant: {
        // [A] Ergiebigkeit ohne OSM-Angabe. 800 l/min = 48 m³/h entspricht dem kleinsten Löschwasserbedarfswert
        // der Tabelle in DVGW W 405 (Bedarf des Versorgungsgebiets für 2 h, KEINE Leistungszusage je Hydrant;
        // Normtext nicht eingesehen, zu prüfen). Tatsächliche Werte: Wasserversorger/Löschwasserkataster.
        defaultLpm: 800,
        // [A] grobe Zuordnung nach fire_hydrant:diameter (mm), ohne Quelle; kleinster passender Eintrag gilt
        nachDurchmesserLpm: [[80, 600], [100, 800], [150, 1200], [9999, 1600]],
        maxGleichzeitig: 1, // [A] ein Standrohr/Füllvorgang je Hydrant gleichzeitig
        ruestMin: 3, // [A] Standrohr setzen, kuppeln, abkuppeln je Füllung
      },
      offen: {
        // offenes Gewässer / Saugstelle: Füllrate durch die Fahrzeugpumpe begrenzt (Saugbetrieb)
        saugFaktor: 0.5, // [A] Füllrate = Nennförderstrom der Pumpe x 0,5 (Saughöhe, Saugleitung, Tankfüllleitung)
        maxGleichzeitig: 2, // [A] zwei Fahrzeuge können gleichzeitig ansaugen
        ruestMin: 6, // [A] Saugleitung kuppeln, ansaugen, abbauen je Füllung
        unsicherStrafMin: 10, // [A] Auswahl: "unsicher" eingestufte Gewässer werden um 10 min schlechter bewertet
      },
      behaelter: {
        // Löschwasserteich (fire_water_pond) / Löschwasserbehälter (water_tank): endliches Volumen, Saugbetrieb
        defaultM3: 100, // [A] Volumen ohne OSM-Tag water_volume (Löschwasserkataster prüfen)
      },
      gewaesser: {
        // [A] Einstufung natural=water nach Fläche, waterway nach Typ (Wasserführung im Sommer unbekannt)
        flaecheAusreichendM2: 5000,
        flaecheMinM2: 300, // kleiner: nicht berücksichtigt
        fluss: "ausreichend", // waterway=river
        bach: "unsicher", // waterway=stream
        zugangMaxM: 30, // [A] Gewässer gilt als zugänglich, wenn ein befahrbarer Weg höchstens 30 m entfernt ist
        zugangAbstandM: 300, // [A] Mindestabstand zwischen zwei Zugangspunkten am selben Gewässer
      },
      unbekannt: { defaultLpm: 800 }, // [A] manuell erfasste Stelle ohne Typ: wie Hydrant ohne Angabe
      maxPendelM: 8000, // [A] Entnahmestellen weiter als 8 km Luftlinie vom Becken werden nicht angefahren
    },

    // ---------------------------------------------------------------- Schlauchleitung / Förderstrecke
    schlauch: {
      maxSchlauchwegM: 600, // [V/A] Grenze Schlauchleitung vs. Pendelverkehr (Auftrag: z. B. 600 m), konfigurierbar
      umwegFaktor: 1.2, // [App] Schlauchweg = Luftlinie x 1,2 (wie suggestions: Länge +20 %)
      reibungBarJe100mBei800: 1.0, // [F] B-Schlauch: ca. 1 bar je 100 m bei 800 l/min, quadratisch mit dem Durchfluss
      maxLeitungLpm: 1200, // [A] eine B-Leitung
      bedarfsReserve: 1.25, // [A] Auslegung = Bedarf des Beckens x 1,25 (min. 400 l/min)
      pumpenAusgangBar: 8, // [F/A] Ausgangsdruck je Pumpe in der Förderstrecke
      eingangMinBar: 1.5, // [F] Mindesteingangsdruck an der nächsten Pumpe bzw. am Leitungsende
      barJeMeterHoehe: 0.1, // [P] 10 m Wassersäule ~ 1 bar (genauer 0,98 bar)
      profilSchrittM: 25, // Höhenprofil entlang der Luftlinie aus dem DGM (25 m)
      aufbauGrundMin: 10, // [A] Aufbau Förderstrecke: 10 min + 2 min je 100 m
      aufbauMinJe100m: 2,
    },

    // ---------------------------------------------------------------- Pendelverkehr
    pendel: {
      umwegFaktor: 1.3, // [App] Weg = Luftlinie x 1,3 (wie suggest.waterText)
      kmhStrasse: 25, // [App] mittlere Pendelgeschwindigkeit (suggestions.shuttleKmh)
      kmhWaldweg: 10, // [A] auf Wald-/Wirtschaftswegen (Anteil = Abstand Becken/Quelle zur nächsten Straße)
      fuellMaxLpm: 1600, // [A] Füllen über max. 2 B-Leitungen
      fuellOhnePumpeLpm: 800, // [A] Fahrzeug ohne Pumpenangabe (TW, LTW): Füllen am Hydranten mit Netzdruck
      entleerLpm: 1600, // [A] Entleeren ins Becken über 2 B-Leitungen (Auftrag: 1.600–2.000 l/min)
      entleerOhnePumpeLpm: 800, // [A] freier Auslauf ohne Pumpe
      entleerRuestMin: 2, // [A] Kuppeln/Abkuppeln am Becken
      maxAnfahrtMin: 90, // [A] Wasserversorgungsfahrzeuge bis 90 min Anfahrt (Großtanker trotz längerer Anfahrt)
      reserveFaktor: 1.15, // [A] geschätzte Lieferung soll den Bedarf um 15 % übersteigen
      anfahrtVoll: true, // [A] Fahrzeuge kommen mit vollem Tank an und entleeren zuerst ins Becken
      grosstankerMinL: 8000, // [A] Großtanker ab 8.000 l oder Typ-Präfix
      grosstankerTypen: ["TW", "LTW", "WLF"],
      tlfTypen: ["TLF", "PTLF"],
      tlfMinL: 2400, // [A] wasserführend mit großem Tank wie TLF
      beckenwechselNachMin: 3, // [A] Becken voll: nach 3 min Warten zu einem anderen Becken mit Platz
      maxIterationen: 6, // Nachplanung: weitere Fahrzeuge, solange ein Defizit bleibt und Reserve vorhanden ist
      defizitSchwelle: 0.05, // ab 5 % ungedecktem Bedarf im eingeschwungenen Zustand
    },

    // ---------------------------------------------------------------- Pufferbecken
    becken: {
      volumenL: 5000, // [V] Faltbehälter 5.000 l
      aufbauMin: 5, // [A] Aufbau ab Eintreffen des ersten zugeordneten Versorgungsfahrzeugs
      maxEntleerer: 1, // [A] ein Fahrzeug speist gleichzeitig ein
      clusterM: 400, // [A] Abnehmer bis 400 m Abstand teilen sich eine Beckengruppe
      bedarfJeBeckenLpm: 600, // [A] Anzahl Becken je Gruppe = Bedarf / 600 l/min, aufgerundet
      maxJeGruppe: 4,
      abstandHinterAbnehmerM: 80, // [A] Zielpunkt 80 m vom Abnehmer-Schwerpunkt weg vom Brand
      suchRadiusM: 600, // [A] Suche nach befahrbarem Standort um den Abnehmer-Schwerpunkt
      sicherheitM: 100, // [A] Abstand zur 6-h-"möglich"-Zone
      ersatzVorlaufMin: 120, // [A] Ersatzkriterium, wenn kein Standort außerhalb der 6-h-Zone liegt
      versatzM: 20, // [A] Mindestabstand zweier Becken einer Gruppe
      waldwegStrafM: 50, // [A] Bewertung: Standort am Waldweg 50 m schlechter als an einer Straße
    },

    // ---------------------------------------------------------------- Fahrzeugauswahl (Ausschlüsse)
    fahrzeuge: {
      ausschlussKommune: "Neunkirchen-Seelscheid", // [V] NK-Fahrzeuge nicht für die Wasserversorgung
      keinWasserTypen: ["ELW", "KdoW", "MTF", "MTW", "DLK", "DL", "GW", "RW"], // [App] suggestions.noWaterTypes
    },

    // ---------------------------------------------------------------- Engpassdiagnose
    diagnose: {
      quelleAuslastung: 0.9, // [A] Entnahmestelle überlastet ab 90 % Belegung ...
      quelleWartenMin: 5, // [A] ... und mittlerer Wartezeit > 5 min je Füllung
      beckenWartenMin: 10, // [A] Hinweis: Tanker warten im Mittel > 10 min an einem Becken
      wartenAnteilEngpass: 0.25, // [A] Engpass, wenn Pendelfahrzeuge > 25 % ihrer Einsatzzeit warten (Quelle bzw. Becken)
      fensterMinMin: 60, // eingeschwungener Zustand mindestens die letzten 60 min
    },
  };

  root.WASSER_PARAMS = WASSER_PARAMS;
  if (root.PARAMS && !root.PARAMS.wasser) root.PARAMS.wasser = WASSER_PARAMS;
  if (typeof module !== "undefined" && module.exports) module.exports = WASSER_PARAMS;
})(typeof globalThis !== "undefined" ? globalThis : this);
