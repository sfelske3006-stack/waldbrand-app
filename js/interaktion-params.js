/*
 * Parameter der Karten-Interaktion (Windpfeil, Fahrzeuge per Drag & Drop).
 *
 * EIGENE Parameterdatei statt eines Blocks in js/params.js – wie js/water-params.js des
 * Wasserversorgungsmoduls. Grund: js/params.js wird parallel von anderen Modulen geändert;
 * eine eigene Datei lässt sich konfliktfrei hinzufügen. Sie ERGÄNZT `PARAMS.interaktion`
 * und ändert keinen bestehenden Wert. Muss NACH js/params.js und VOR js/windrose.js /
 * js/vehicle-drag.js geladen werden (Reihenfolge siehe INTEGRATION.md).
 *
 * JEDE ZAHL HIER IST EINE ANNAHME, solange sie nicht mit der Feuerwehr abgestimmt ist
 * (siehe ASSUMPTIONS.md). Fehlt diese Datei, arbeiten die Module mit denselben Werten
 * aus ihren eigenen DEFAULTS weiter – die Bedienung bleibt also funktionsfähig.
 */
(function (root) {
  "use strict";
  const P = root.PARAMS;
  if (!P) return;

  P.interaktion = {
    // ---------------------------------------------------------------- Windpfeil
    wind: {
      snapDeg: 5,          // ANNAHME: Rastung der Windrichtung beim Ziehen (Grad)
      fineSnapDeg: 1,      // ANNAHME: Feinmodus (Umschalttaste / Schalter)
      snapKmh: 1,          // ANNAHME: Rastung der Windstärke (km/h)
      fineSnapKmh: 0.5,    // ANNAHME: Feinmodus der Windstärke
      maxKmh: 120,         // ANNAHME: Obergrenze der Bedienung (Regler und Pfeillänge)
      radiusPx: 78,        // Anzeige: Radius des Pfeilfelds (Bildschirmpixel)
      minLenPx: 35,        // Anzeige: kürzeste Pfeillänge (bei 0 km/h)
      minDragPx: 18,       // ANNAHME: darunter keine eindeutige Richtung (Daumen auf dem Drehpunkt)
      debounceMs: 300,     // VORGABE: Neuberechnung ca. 300 ms nach dem Loslassen
      keyStepDeg: 5,       // Tastatur: Pfeiltasten links/rechts
      keyFineStepDeg: 1,   // Tastatur mit Umschalttaste
      keyStepKmh: 1,       // Tastatur: Pfeiltasten hoch/runter
      keyFineStepKmh: 0.5,
      keyPageDeg: 45,      // Tastatur: Bild auf/ab = ein Kompasssektor
      holdAfterLast: true, // ANNAHME: nach der letzten Zeitplan-Stützstelle deren Wert halten
    },
    // ---------------------------------------------------------------- Fahrzeuge ziehen
    drag: {
      snapRadiusM: 150,    // ANNAHME: Ablage näher als das = Zuordnung zur Riegellinie (halber Abschnitt)
      maxExtendM: 300,     // ANNAHME: höchstens so weit verlängert sich eine Linie je Ende
      maxShiftM: 60,       // ANNAHME: höchstens so weit verschiebt sich eine Linie quer
      shiftStepM: 10,      // Schrittweite der geprüften Anpassung (m)
      waterGuideMaxM: 2000,// Hilfslinie zur nächsten Entnahmestelle nur bis hierhin (m)
      tapTargetPx: 52,     // wie --tap in css/app.css (Tablet, Handschuhe)
      lockOnDrop: true,    // ANNAHME: von Hand gesetzte Fahrzeuge sind gegen Umsetzen gesperrt
      undoDepth: 20,       // Tiefe der Rückgängig-Liste
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
