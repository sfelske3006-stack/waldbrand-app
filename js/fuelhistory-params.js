/*
 * Parameterblock "trockenheit" (Modul Trockenheit / Vorgeschichte des Wetters, 0.9.0).
 *
 * EIGENE Parameterdatei statt eines Blocks in js/params.js - wie js/water-params.js und
 * js/interaktion-params.js. Sie ERGÄNZT `PARAMS.trockenheit` und ändert keinen bestehenden Wert.
 * Muss NACH js/params.js und VOR js/fuelhistory.js / js/fuelhistory-ui.js geladen werden
 * (Loaderliste in index.html). Fehlt die Datei, arbeitet der Rechenkern mit seinen eigenen
 * DEFAULTS weiter; die Bedienung bleibt funktionsfähig.
 *
 * JEDE Zahl hier ist eine ANNAHME, solange sie nicht mit Forst/Feuerwehr bzw. der Primärquelle
 * abgeglichen ist. Quellen und Status: docs/assumptions.md (Abschnitt "Neu in 0.9.0"). Kennzeichnung im Kommentar:
 *   [Q]   belegt (Quelle genannt und eingesehen: heruntergeladene Open-Meteo-Doku, xclim-Quelltext)
 *   [Q?]  Quelle genannt, Primärquelle NICHT eingesehen -> zu prüfen
 *   [A]   eigene Annahme ohne Quelle
 *   [V]   Vorgabe des Auftraggebers
 *   [App] übernommen aus den bestehenden App-Parametern (js/params.js)
 */
(function (root) {
  const FUELHISTORY_PARAMS = {
    version: "0.9.0-prototyp",
    hinweis: "Wettervorgeschichte und Dürre-Indikatoren mit Annahmen. Keine amtliche Waldbrandgefahrenstufe.",

    // Schalter "Vorgeschichte einbeziehen". false = Rechnung wie bisher (0.6.0), bitgenau.
    enabled: true,

    // ---------------------------------------------------------------- Wetterabruf (Vorgeschichte)
    abruf: {
      // [Q] Forecast-API liefert Vergangenheit über past_days (heruntergeladene Doku:
      //     _dl/api-parameters.svelte -> past_days, Integer, Standard 0; _dl/opt_options.ts ->
      //     pastDaysOptions bis '92' = "3 months"). Eine harte Obergrenze nennt die
      //     Parametertabelle nicht (anders als forecast_days "Integer (0-16)") -> maxPastDays zu prüfen.
      forecastUrl: "https://api.open-meteo.com/v1/forecast",
      // [Q] Historical/Archive-API (Reanalyse) auf eigenem Host, _dl/..._historical-weather-api__page.svelte:
      //     "archive-api.open-meteo.com/v1/archive"; ERA5/ERA5-Land "Daily with 5 days delay",
      //     ECMWF IFS "Every 6 hours with no delay". Nur nötig, wenn > 92 Tage gebraucht werden.
      archiveUrl: "https://archive-api.open-meteo.com/v1/archive",
      archiveVerzoegerungTage: 5, // [Q] ERA5-Verzögerung; archiv-only-Abruf endet entsprechend früher
      archiveModell: "", // leer = Open-Meteo-Standard (best_match); z. B. "era5_land", "ecmwf_ifs"

      pastDaysDefault: 60, // [V] Vorgabe Auftraggeber: 60 Tage
      pastDaysMin: 30, // [V] Spanne 30-60 Tage
      pastDaysMax: 92, // [Q] größter in der Doku belegter Wert der Optionsliste
      forecastDays: 2, // [App] wie js/weather.js (Prognosehorizont max. 6 h + Reserve)
      hervorhebenTage: 7, // [V] letzte 7 Tage im UI hervorgehoben

      // Stundenvariablen. Für FWI genügen T, rF, Wind, Niederschlag am Mittag.
      hourly: ["temperature_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m"],
      // Tageswerte als Gegenprobe (Niederschlagssumme); nicht für die Rechnung nötig.
      daily: ["precipitation_sum"],
      coordDecimals: 2, // [App] Koordinaten auf ca. 1 km gerundet senden (Datenschutz, wie js/weather.js)
      timeoutMs: 30000, // [A] 60 Tage Stundenwerte sind ca. 300-500 kB
      zeitzone: "Europe/Berlin", // [A] Lokalzeit für "Mittag" (Sommer-/Winterzeit über Intl)

      // localStorage-Cache (try/catch, Fallback ohne Cache)
      cacheKey: "wb_fuelhistory",
      cacheMaxAgeH: 12, // [A] älter = erneut abrufen; bis 48 h weiter nutzbar mit Hinweis
      cacheWarnAgeH: 48, // [A] darüber deutliche Warnung "Vorgeschichte veraltet"
      cacheMaxBytes: 1500000, // [A] Schutz gegen QuotaExceeded; darüber wird nur die Tagesreihe gespeichert
    },

    // ---------------------------------------------------------------- Tote Brennstofffeuchte (stündlich)
    tote: {
      // Gleichgewichtsfeuchte (EMC) nach Simard (1968) - identische Funktion wie FireModel.equilibriumMoisture
      // in js/model.js [App]; damit bleibt der Schalter "aus" vergleichbar.
      // Fortschreibung je Stunde: m <- EMC + (m - EMC) * exp(-dt / tau)   [Q?]
      //   Exponentielle Annäherung mit Zeitverzögerung tau ("timelag"), tau = nominelle Reaktionszeit
      //   der Klasse (1/10/100 h; Byram 1963, Fosberg 1971, zusammengefasst in Andrews 2018
      //   RMRS-GTR-371). Definition: nach tau sind 1 - 1/e = 63 % der Differenz zur EMC abgebaut.
      //   Primärquellen nicht eingesehen -> zu prüfen.
      klassen: {
        d1: { tauH: 1, sat: 35, rainKPerMm: 6.0, rainMaxPerH: 12, label: "1 h" },
        d10: { tauH: 10, sat: 30, rainKPerMm: 2.0, rainMaxPerH: 5, label: "10 h" },
        d100: { tauH: 100, sat: 25, rainKPerMm: 0.6, rainMaxPerH: 2, label: "100 h" },
      },
      // Regenbenetzung [A] EIGENE, EINFACHE ANNAHME (kein übernommenes Modell):
      //   Zuschlag je Stunde = min(rainKPerMm * Regen[mm/h], rainMaxPerH), danach auf sat begrenzt.
      //   Begründung der Abstufung: je größer die Klasse, desto geringer die Benetzung je mm.
      //   Alternativen, die NICHT übernommen wurden, weil die Formeln nicht sicher bekannt sind:
      //   NFDRS-Randbedingung mit Regendauer, Nelson (2000) Diffusionsmodell.
      //   Vergleichswert aus der Literatur: Die Regenroutine des FFMC (Van Wagner 1987, Gl. 2/3a/3b)
      //   ist im FWI-Teil umgesetzt; FuelHistory.ffmcMoisture(FFMC) liefert daraus die Feuchte der
      //   FFMC-Streuschicht als unabhängige Gegenprobe zur 1-h-Klasse (siehe UI/Tests).
      regenSchwelleMm: 0.1, // [A] darunter als "kein Regen" behandelt (Messauflösung)
      min: 1.5, // [A] untere Schranke (Rothermel-Dämpfung bleibt endlich)
      max: 40, // [App] wie PARAMS.moisture.max
      // Startwert der Fortschreibung: EMC der ersten Stunde [A]. Nach 5*tau ohne Einfluss
      // (1 h: 5 h, 10 h: ca. 2 Tage, 100 h: ca. 21 Tage) - bei 30-60 Tagen Vorlauf bedeutungslos.
      // Test "Startwert ohne Einfluss" in tests/fuelhistory.test.mjs beziffert das.
      startEmc: true,
      startVersatzPct: 0, // [A] optionaler Zuschlag auf den Startwert (nur für Tests)
    },

    // ---------------------------------------------------------------- Lebende Brennstofffeuchte
    // [A] EINFACHE ANNAHME nach Jahreszeit und Dürre (DC). KEIN phänologisches Modell,
    // keine Messung (Live Fuel Moisture wird in Deutschland nicht flächig erhoben, zu prüfen).
    lebend: {
      // Monatswerte 1..12 in % Trockenmasse, 51° N, Mittelgebirge [A]
      // Kraut/Gras (lh): Austrieb ab April, Höhepunkt Mai/Juni, Vergilben ab August.
      krautMonat: [30, 30, 45, 90, 120, 120, 100, 80, 60, 45, 30, 30],
      // Gehölz/Nadeln (lw): deutlich träger, Winterwert hoch (lebendes Holz)
      gehoelzMonat: [90, 90, 95, 110, 130, 130, 120, 110, 100, 95, 90, 90],
      interpolieren: true, // [A] linear zwischen Monatsmitten (kein Sprung am Monatsersten)
      // Dürre-Abschlag über den Drought Code: Anteil = 0 bei DC <= dcStart, 1 bei DC >= dcVoll
      dcStart: 200, // [A]
      dcVoll: 600, // [A] DC 600 entspricht einer ausgeprägten, mehrwöchigen Trockenheit
      krautAbschlag: 0.45, // [A] bis -45 % des Jahreszeitwerts
      gehoelzAbschlag: 0.2, // [A] bis -20 %
      krautMin: 30, // [App] PARAMS.moisture.liveHerb = 90 ist der bisherige Festwert; 30 % = vollständig vergilbt
      gehoelzMin: 70, // [A]
      // Vergilben/"Curing": Anteil des Krautbrennstoffs, der bei Dürre als TOTER Feinbrennstoff gerechnet wird.
      // Nur wirksam, wenn kopplung.curing.enabled = true.
      curingMax: 0.5, // [A] höchstens die Hälfte der Krautbeladung wandert in die 1-h-Klasse
    },

    // ---------------------------------------------------------------- FWI-System (Van Wagner 1987)
    fwi: {
      // [Q] Gleichungen nach Van Wagner (1987) Forestry Technical Report 35, in der Fassung von
      // cffdrs/xclim (Quelltext _venv/.../xclim/compute/fire/_cffwis.py eingesehen, Gl.-Nummern dort).
      // Verifiziert gegen xclim 1.0.0, Abweichungen siehe tests/fuelhistory.test.mjs und BERICHT.
      lat: 51.0, // [V] Gebiet Neunkirchen-Seelscheid ca. 50,85° N -> Tabellenzeile "90 >= lat >= 30"
      // Tageslängen Le (DMC) für 30-90° N, Van Wagner 1987 Tab. (xclim DAY_LENGTHS[4]) [Q]
      tageslaengeDMC: [6.5, 7.5, 9, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8, 7, 6],
      // Tageslängenfaktor Lf (DC) für die Nordhalbkugel, Van Wagner 1987 (xclim DAY_LENGTH_FACTORS[2]) [Q]
      tageslaengeDC: [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6],
      // Standard-Startwerte ("spring startup", Van Wagner 1987) [Q?]
      startFFMC: 85, startDMC: 6, startDC: 15,
      // Einfluss der Startwerte bei 60 Tagen Vorlauf (siehe ASSUMPTIONS.md/Test):
      // FFMC nach ca. 5 Tagen, DMC nach ca. 4-6 Wochen ohne Einfluss; DC behält die Erinnerung
      // (reiner Summenspeicher, nur Regen > 2,8 mm senkt ihn) -> DC-Startwert ist die wichtigste Annahme.
      mittagStunde: 12, // [Q] FWI-Eingang: 12 Uhr Lokalzeit (LST), Niederschlag der vorangegangenen 24 h
      minTageFuerFwi: 10, // [A] darunter kein FWI ausgeben (Vorlauf zu kurz)
      // Überwinterung des DC (overwintering, Van Wagner/Lawson) ist NICHT umgesetzt -> zu prüfen.
      ueberwinterung: false,
    },

    // ---------------------------------------------------------------- Trockenheitsampel
    ampel: {
      // [Q?] FWI-Klassengrenzen wie im europäischen Waldbrandinformationssystem EFFIS gebräuchlich
      // (very low < 5,2; low < 11,2; moderate < 21,3; high < 38,0; very high < 50,0; extreme >= 50).
      // Primärquelle (JRC/EFFIS-Dokument) NICHT eingesehen -> zu prüfen, Zahlen nicht verändern ohne Beleg.
      fwiGrenzen: [5.2, 11.2, 21.3, 38.0, 50.0],
      fwiLabels: ["sehr gering", "gering", "mittel", "hoch", "sehr hoch", "extrem"],
      // [A] Zusammenfassung auf eine dreistufige Ampel (eigene Annahme, keine amtliche Stufe):
      //   grün  = FWI-Klasse 0-1, gelb = Klasse 2, rot = Klasse 3-5
      ampelAbKlasse: { gelb: 2, rot: 3 },
      // [A] Ergänzende Kennzahlen für den Ampeltext (keine Klassengrenzen aus einer Quelle):
      dcHinweis: [300, 500], // DC > 300 "deutliches Niederschlagsdefizit", > 500 "ausgeprägte Dürre"
      buiHinweis: [40, 90], // BUI > 40 "Brennstoff tiefer getrocknet", > 90 "auch grobes Totholz trocken"
      trockentageHinweis: [10, 21], // Tage seit >= 1 mm Regen
      regenSchwellenMm: [1, 5], // [V] Kennzahl "Tage seit letztem Regen >= X mm"
      summenTage: [7, 30, 60], // [V] Niederschlagssummen
    },

    // ---------------------------------------------------------------- Kopplung an das Ausbreitungsmodell
    // Alle Zahlen [A]. Die Kopplung ist begrenzt, damit keine unplausiblen Sprünge entstehen.
    kopplung: {
      // 1. Basisfeuchte: Feuchten aus der Vorgeschichte ersetzen FireModel.deadMoisture().
      feuchteBasis: true,
      // Begrenzung gegenüber der bisherigen Herleitung (Gleichgewichtsfeuchte + Regenzuschlag),
      // damit die Vorgeschichte das Ergebnis nicht beliebig weit verschiebt:
      maxAbweichungPct: { d1: 6, d10: 8, d100: 12 }, // %-Punkte je Klasse
      // Lebendfeuchte aus der Jahreszeit/Dürre ersetzt PARAMS.moisture.liveHerb/liveWoody
      lebendBasis: true,
      maxAbweichungLebendPct: 60, // %-Punkte gegenüber dem bisherigen Festwert
      // 2. Dürre-Effekt, zwei Modi:
      //    "reaktionsintensitaet" (STANDARD): Reaktionsintensität I_R und damit die
      //      Ausbreitungsrate werden mit einem begrenzten Faktor skaliert. Begründung: Bei Dürre
      //      trocknen tiefere Streu-/Totholzschichten mit und verbrennen mit, der Anteil des
      //      Brennstoffs, der in der Flammenfront umgesetzt wird, steigt. Monoton und begrenzt.
      //    "brennstoffmenge": die Beladungen w[] der toten Klassen werden skaliert.
      //      WARNUNG: In Rothermel (1972) erhöht mehr Grobbrennstoff bei gleicher Brennstofftiefe
      //      die Packungsdichte; die Ausbreitungsrate kann dadurch SINKEN (im Testlauf FM8:
      //      trocken/nass nur Faktor 1,05). Dieser Modus ist daher nur für Vergleichsrechnungen
      //      gedacht und NICHT voreingestellt.
      modus: "reaktionsintensitaet",
      duerre: {
        quelle: "bui", // "bui" (empfohlen: enthält DMC und DC) oder "dc"
        start: 40, // [A] darunter kein Dürre-Effekt (BUI 40 ca. "mittel")
        voll: 120, // [A] Vollausschlag (BUI 120 = ausgeprägte Dürre)
        maxLastFaktor: 1.25, // [A] höchstens +25 % tote Beladung
        // Anteil des Dürre-Effekts je Beladungsklasse des Brennstoffmodells (w[0..4])
        anteil: { w1: 0.4, w10: 1.0, w100: 1.0, wLH: 0, wLW: 0 },
        maxIrFaktor: 1.2, // [A] höchstens +20 % Reaktionsintensität/Rate (modus "reaktionsintensitaet")
      },
      // Vergilben: Teil der Krautbeladung als toter Feinbrennstoff (1 h) rechnen
      curing: { enabled: true, start: 60, voll: 160 }, // [A] Schwellen auf BUI
      // 3. Ensemble-Spannweite: Streuung der toten Feuchte wird mit der Dürre und mit der
      //    Unsicherheit der Vorgeschichte breiter (Faktor auf PARAMS.ensemble.deadMoistureAbs).
      ensemble: {
        maxFaktor: 1.6, // [A] höchstens 1,6-fache Spannweite
        start: 40, voll: 120, // [A] auf BUI
        fallbackFaktor: 1.8, // [A] ohne Vorgeschichte (Fallback/manuelle Eingabe): breiteres Band
        manuellFaktor: 1.4, // [A] mit manueller Ersatzeingabe
      },
      // Gesamtbegrenzung: Das Verhältnis der Kopffeuerrate "mit Vorgeschichte" zu "ohne" wird
      // in den Tests geprüft und soll in diesem Bereich bleiben (sonst Warnung im UI).
      plausibelRateFaktor: [0.3, 3.0], // [A]
    },

    // ---------------------------------------------------------------- Anzeige
    ui: {
      diagrammHoehe: 190, // px, Canvas (ohne deviceScaleFactor)
      diagrammMinBreite: 280,
      maxBalkenMm: 25, // [A] Skala der Niederschlagsbalken (darüber abgeschnitten, Zahl wird angezeigt)
      feuchteSkalaMax: 40, // % für die Feuchteachse
      zeigeKlassen: ["d1", "d10", "d100"],
    },
  };

  root.FUELHISTORY_PARAMS = FUELHISTORY_PARAMS;
  // Registrierung als PARAMS.trockenheit (eigener Schlüssel; kollidiert nicht mit dem Block
  // "safearea" o. a. in js/params.js). Vorhandene Werte werden nicht überschrieben.
  if (root.PARAMS && !root.PARAMS.trockenheit) root.PARAMS.trockenheit = FUELHISTORY_PARAMS;
  if (typeof module !== "undefined" && module.exports) module.exports = FUELHISTORY_PARAMS;
})(typeof globalThis !== "undefined" ? globalThis : this);
