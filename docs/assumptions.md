# Annahmen und Parameter

Alle Werte stehen versioniert in `js/params.js` (Version `0.3.0-prototyp`). Jede Zeile ist eine **Annahme**, bis sie fachlich bestätigt ist.

| Bereich | Parameter | Wert | Status |
|---|---|---|---|
| Horizonte | `horizonsH` | 1, 2, 4, 6 h | Spezifikation |
| Raster | `grid.cellM` / `grid.halfSizeM` | 25 m / 5.000 m | Annahme, Performance auf Tablet zu prüfen |
| Ensemble | Läufe, Seed | 24, 20240601 | Annahme |
| Ensemble | Windrichtung | ±25° gleichverteilt | Annahme |
| Ensemble | Windstärke | ×0,75 bis ×1,35 | Annahme |
| Ensemble | Tote-Brennstoff-Feuchte | ±2 %-Punkte | Annahme |
| Band | „wahrscheinlich“ / „möglich“ | ≥ 50 % / ≥ 10 % der Läufe | Annahme |
| Wetter | Warnung Datenalter | > 3 h | Spezifikation (Annahme) |
| Feuchte | 1-h-Feuchte | Gleichgewichtsfeuchte (Simard 1968) + 2 %-Pkt. je mm Regen 24 h (max. +15) | Annahme, Methode zu prüfen |
| Feuchte | 10-h / 100-h | 1-h + 1 / 1-h + 2 + 1 %-Pkt. je mm Regen 72 h | Annahme |
| Feuchte | Grenzen | 3–40 % | Annahme |
| Feuchte | lebend krautig / holzig | 90 % / 120 % | Annahme (Sommer) |
| Wind | Reduktion 10 m → Flammenhöhe | offen 0,4, Wald 0,2 | Annahme |
| Brennstoff | Nadelwald (`leaf_type=needleleaved`) | Anderson FM10 | Annahme, mit Forst abzustimmen |
| Brennstoff | Laubwald (`broadleaved`) | FM9 | Annahme |
| Brennstoff | Wald ohne/mit gemischter Angabe | FM8 | Annahme |
| Brennstoff | Wiese, Gras, Obstwiese | FM1 | Annahme |
| Brennstoff | Acker | FM1 (bei reifem Getreide eher FM3) | Annahme |
| Brennstoff | Gebüsch, Heide | FM5 | Annahme |
| Brennstoff | Fläche ohne OSM-Landnutzung | FM1 | Annahme |
| Brennstoff | Siedlung, Gebäudezellen, Wasser | nicht brennbar | Annahme (optimistisch) |
| Barrieren | Straßen `motorway` … `residential`, Bahn, Fluss/Kanal | nicht brennbar, kein Überspringen | Annahme (optimistisch) |
| Barrieren | `track`, `path`, Bach | keine Barriere im Modell, nur Riegelkandidat | Annahme (konservativ) |
| Vorschläge | Anfahrt bis zur Linie `anfahrtMin` | 30 min, pauschal (kein Routing) | **Annahme, neu in 0.3.0**, offen (Feuerwehr) |
| Vorschläge | Aufbauzeit Riegel `setupMin` | 45 min (unverändert) | Annahme, offen (Feuerwehr) |
| Vorschläge | Einsatzbereitschaft an der Linie | Anfahrt + Aufbau = 75 min nach Prognosebeginn | abgeleitet |
| Vorschläge | Mindest-Wirkzeit `lineMinLeadMin` | 30 min: Prüfzeitpunkt für Linien = 75 + 30 = 105 min | **Annahme, neu**; ohne sie wären Linien möglich, an denen kein Fahrzeug sicher stehen kann (0 = nur Bereitschaft) |
| Vorschläge | Linie gültig | alle Linienzellen außerhalb der „möglich“-Zone zum Prüfzeitpunkt, Abstand ≥ 50 m (`lineClearanceM`) | Annahme |
| Vorschläge | „quer“ / „vor der Front“ | Winkel zur Hauptrichtung ≥ 45°; Linienmitte ≤ 60° neben der Hauptrichtung; jede Zelle in Ausbreitungsrichtung vor der Zone (Querstreifen ±50 m) | Annahme |
| Vorschläge | im Ausbreitungsbereich | Linie höchstens 50 m von der 6-h-„möglich“-Zone; Verlängerung 150 m je Seite; Mindestlänge 100 m | Annahme |
| Vorschläge | ohne gültige Linie | keine Linie, Meldung „Keine geeignete Riegelstellung gefunden“ mit Anzahl verworfener Kandidaten je Grund | Vorgabe |
| Vorschläge | Sicherheitspuffer Fahrzeug `vehicleSafetyMin` | „möglich“-Front am Standort frühestens 60 min nach Einsatzbereitschaft (≥ 135 min) und kein einzelner Lauf vor der Bereitschaft (> 75 min) | Annahme, offen. **Geändert**: bis 0.2.0 „früheste Ankunft (einzelner Lauf) ≥ 45 + 60 min“ ohne Anfahrt |
| Vorschläge | Mindestabstand zum 1-h-„möglich“-Bereich | 100 m (Bereitstellungsraum 300 m) | Annahme, offen |
| Vorschläge | Gewichte Riegelbewertung (nur gültige Linien) | Barrieretyp 1,0; Vorlauf 1,0; Länge −0,3; Schutz 0,8; Lage 0,8; quer 0,5; Abdeckung Frontbreite 1,5 | Annahme |
| Vorschläge | Befahrbarkeit | Straßen und `track` grade1–3/ohne Angabe | Annahme, Waldwege vor Ort prüfen |
| Fahrzeuge | Löschwasser | Riegel/Objektschutz/Pendel nur mit Tank > 0 (bzw. Löschfahrzeugtyp bei unbekanntem Tank); nie ELW, KdoW, MTF/MTW, DLK, GW, RW | Annahme |
| Fahrzeuge | Abschnitt je Fahrzeug an der Linie `sectionPerVehicleM` | 300 m; Fahrzeuge je Linie = Länge / 300 m aufgerundet, max. 4, Standorte in Abschnittsmitte auf der brandabgewandten Seite, mind. 60 m auseinander | Annahme (Schlauchreserve beidseitig), offen |
| Fahrzeuge | Reihenfolge der Aufgaben | R1-Abschnitte → Objektschutz je bedrohter Bebauung (nach Bedrohungszeit, max. 4) → R2/R3-Abschnitte → Wasserversorgung je Linie | Annahme |
| Fahrzeuge | bedrohte Bebauung | OSM-Gebäude/Wohnflächen ≤ 50 m von der 6-h-„möglich“-Zone; Lücken ≤ 100 m = ein Objekt; 1 Fahrzeug je Objekt; Aufbau Objektschutz 15 min | Annahme |
| Fahrzeuge | Wasserversorgung | Entnahmestelle ≤ 300 m von der Linienmitte: Schlauchleitung (Hinweis); sonst 1 Fahrzeug (größter Tank) für Pendelverkehr | Annahme |
| Fahrzeuge | Bereitstellungsraum | nächster sicherer, befahrbarer Punkt in der Gegenrichtung (±72°), ≥ 300 m vom 1-h-Bereich, ≤ 3 km; dort ELW (Führung), MTF (Personalreserve) und nur überzählige Löschfahrzeuge (Reserve mit Begründung) | Annahme |
| Fahrzeuge | nicht eingeplant | DLK, GW-G, KEF (Ausstattung offen) – Hinweis im UI | Annahme |
| Wasser | Abgabe je Fahrzeug | 400 l/min | Annahme |
| Wasser | Schlauchleitung bis `hoseMaxM` | 300 m Luftlinie, Länge +20 % | Annahme |
| Wasser | Pendelgeschwindigkeit | 25 km/h, Weg = Luftlinie × 1,3 | Annahme (kein Routing) |
| Fahrzeuge | HLF 20 Tank/Pumpe | 1.600 l / 2.000 l/min | Normwert (Mindestwert), zu prüfen |
| Fahrzeuge | LF 20 Tank/Pumpe | 2.000 l / 2.000 l/min | Normwert (Mindestwert), zu prüfen |
| Karte | Startmittelpunkt | 50,858° N / 7,335° O | Annahme (nur Kartenstart) |
| Projektion | lokale äquidistante Näherung | – | Abweichung von EPSG:25832 |
| Gelände | DGM | DGM1 NRW, Flächenmittel auf ca. 25 m (EPSG:4326), Neunkirchen-Seelscheid + 5 km | Datenquelle amtlich; Mittelung und Ausschnitt: Annahme |
| Gelände | Höhe je Zelle | bilinear aus dem 25-m-DGM an der Zellmitte | Annahme |
| Hang | Steigung je Kante | Höhendifferenz / Kantenlänge in Laufrichtung (16er-Nachbarschaft) | **vereinfachte Annahme** |
| Hang | Hangfaktor | φS = 5,275 · β^−0,3 · tan² (Rothermel 1972), Zuschlag R0 · φS bergauf | Literatur, übertragen |
| Hang | Kombination mit Wind | additiv zur Ellipsenrate in Laufrichtung, nicht vektoriell | **vereinfachte Annahme**, vektorielle Kombination Phase 2 |
| Hang | bergab | keine Verlangsamung (Grundrate) | Annahme (konservativ) |
| Hang | Obergrenze `dem.maxTanSlope` | tan 0,7 (≈ 35°); steilere Kanten wie 35° | Annahme |
| Hang | außerhalb DGM / fehlende Höhe | eben, mit Warnung | Annahme |
| Anzeige | Schummerung offline | Horn, Licht aus 315°/45°, Überhöhung 1,5 | nur Darstellung |
| Anzeige | Standarddarstellung `display.defaultMode` | Konturen; Umschalter Konturen/Raster in der Legende, Wahl im localStorage | Vorgabe |
| Anzeige | Konturen | Marching Squares auf Zeitfeldern (lineare Interpolation; nicht erreichte Zellen, Werte jenseits 6 h und Rasterrand: halber Weg; Brandflächenzellen: Front ab Zellrand), Chaikin 2 Iterationen, Douglas-Peucker 0,2 Zellen (5 m) | nur Darstellung |
| Anzeige | Flächenabweichung Kontur/Raster | Tests: ≤ 3 % für Flächen ab 100 Zellen (6,25 ha), max. 0,1–3 %; unter 100 Zellen bis ca. 35 % (einzelne Zellen sind als Kontur nicht flächentreu darstellbar). Hinweis in der Legende ab 5 % | gemessen (tests/model.test.mjs) |
| Anzeige | Rasteransicht | Zellumrisse entlang der Zellränder (flächentreu), Referenzlauf nur als Linie | nur Darstellung |

## Befunde 0.3.0 (Fehleranalyse zum Nutzer-Screenshot)

- **Schwarze Kästchen**: `renderOverlay` (bis 0.2.0) malte für jeden Horizont jede Zelle des Referenzlaufs, die einen nicht erreichten 4er-Nachbarn hat, deckend schwarz (Alpha 255) ins Rasterbild. Die vier Umrisse lagen bei langsamer Ausbreitung (rückwärtig, flankierend) nur 1–2 Zellen auseinander und verschmolzen zu Blöcken um die Brandfläche; außerdem wurden Zellen neben nicht brennbaren Zellen (Gebäude, Straßen, Gewässer) markiert. Im synthetischen Testfall waren 220 von 736 farbigen Zellen (30 %) schwarz. Kein NaN-/Indexfehler. Die Schraffur bestand aus Bildpixeln (2 px je Zelle, Periode 6 px) und erschien deshalb als Streifen in Rastergröße.
- **Riegel R1 durch die 2–4-h-Zone**: Die Linie im Screenshot ist gerade und hat Fahrzeuge an beiden Enden; das entspricht der geometrischen Ersatzlinie ohne OSM-Daten (vermutlich war Overpass beim Nutzer nicht erreichbar; **nicht sicher**, Protokoll prüfen). Diese wurde an der ersten Stelle der Achse gesetzt, an der die früheste Ankunft ≥ 45 + 60 min war; die übrige Linie wurde nicht geprüft. Mit OSM genügte für Wegelinien eine Ankunft nach 45 min.
- **Nur zwei Fahrzeuge im Einsatz**: Die Aufgabenliste war fest: R1 → 2 Fahrzeuge bei Index ⌊n/3⌋ und ⌊2n/3⌋ der Punktliste (bei 2 Punkten = Enden), Objektschutz nur für die eine früheste Gebäudezelle und nur mit OSM, R2/R3 je 1. Die geometrische Ersatzlinie liefert genau eine Linie → 2 Aufgaben → 2 Fahrzeuge; alle übrigen Löschfahrzeuge (3 mit Wasser) und der ELW gingen in den Bereitstellungsraum, dort mit identischen Koordinaten und um je 34 px versetzten Labels („gestapelt“). Ohne OSM gibt es keine Gebäudedaten, daher kein Objektschutz für die Bebauung im Osten/Norden.

