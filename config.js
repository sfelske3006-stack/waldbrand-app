/*
 * Betriebs-Konfiguration (je Installation anpassen).
 * Hier stehen KEINE Modellparameter (die liegen versioniert in js/params.js).
 *
 * googleMapsApiKey: leer lassen, solange kein Key mit Abrechnung vorliegt.
 *   Erst wenn hier ein Key steht, erscheint der Umschalter "Google Luftbild".
 *   Google-Bilder werden nur angezeigt, nie ausgewertet (Nutzungsbedingungen).
 *   Den Key nicht in ein öffentliches Repository einchecken.
 */
window.APP_CONFIG = {
  googleMapsApiKey: "",
  // Overpass-Endpunkt für OSM-Daten (Brennstoff, Wege, Gewässer, Hydranten).
  // Zu prüfen: Für den Betrieb eigene Instanz/Extrakt verwenden (Nutzungsregeln).
  overpassUrl: "https://overpass-api.de/api/interpreter",
  // Open-Meteo Forecast-API (keine Registrierung). Zu prüfen: Nutzungsbedingungen.
  openMeteoUrl: "https://api.open-meteo.com/v1/forecast",
  // Nominatim für die manuelle Geokodierung von Wachenadressen (Admin-Ansicht) und als Ergänzung der Ortssuche.
  nominatimUrl: "https://nominatim.openstreetmap.org/search",
  // Online-Suche (OpenStreetMap/Nominatim) in der Ortssuche. false = dauerhaft aus (Schalter in der App gesperrt).
  // Sie läuft nie automatisch: nur auf Knopfdruck, höchstens 1 Anfrage/s, kein Autocomplete. Nutzungsregeln prüfen.
  searchOnline: true,
};
