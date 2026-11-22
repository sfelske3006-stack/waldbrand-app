# Annahmen und Parameter

Alle Werte stehen versioniert in `js/params.js` (Version `0.4.0-prototyp`). Jede Zeile ist eine **Annahme**, bis sie fachlich bestätigt ist.

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
| Vorschläge | Anfahrt `anfahrtMin` | 30 min, seit 0.4.0 **nur Ersatzwert** (kein einplanbares Fahrzeug; Pflichtfahrzeug ohne schätzbare Anfahrt) | Annahme |
| Vorschläge | Aufbauzeit Riegel `setupMin` | 45 min (unverändert) | Annahme, offen (Feuerwehr) |
| Vorschläge | Einsatzbereitschaft / Prüfgrenze Riegel | früheste Bereitschaft eines geeigneten Löschfahrzeugs (`anfahrt.lineReadyVehicleRank` = 1) + Mindest-Wirkzeit; je Abschnitt Prüfung der Bereitschaft des zugeordneten Fahrzeugs; zweite Prüfgrenze für die nächste deutlich spätere Bereitschaft (z. B. 40 min) | **geändert in 0.4.0** (bis 0.3.0: pauschal 75 min) |
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


## Neu in 0.4.0

### Bereitschaft eigene Wehr (VORGABE AUFTRAGGEBER, keine Annahme)

| Parameter | Wert | Status |
|---|---|---|
| `bereitschaftEigeneWehr.gleicherTeil` | 25 min von Alarm bis löschbereit (inkl. Ausrücken, Anfahrt, Aufbau), Einsatzort im Gemeindeteil des Löschzugs | **Vorgabe Auftraggeber, 22.11.2026** |
| `bereitschaftEigeneWehr.andererTeil` | 40 min, Einsatzort im anderen Gemeindeteil | **Vorgabe Auftraggeber, 22.11.2026** |
| Zuordnung Löschzug → Gemeindeteil | lz-nk → Neunkirchen, lz-se → Seelscheid | Vorgabe |
| Gemeindeteil des Einsatzorts | Gemarkung (ALKIS) → Teil: Seelscheid → Seelscheid (belegt: Name, Gerätehaus SE); Wolperath → Neunkirchen (Gerätehaus NK liegt darin, abgeleitet); Eischeid, Herkenrath → Neunkirchen, Söntgerath → Seelscheid | **Annahme** (näheres Gerätehaus), zu prüfen |
| Gemeindeteil unbekannt (`unbekanntMin`) | 40 min für beide Löschzüge | Annahme (konservativ) |
| Einsatzort außerhalb des Gemeindegebiets | eigene Fahrzeuge: Anfahrt geschätzt + Aufbau, mindestens 25 min (`ausserhalbMinMin`); ohne Koordinate 40 min | Annahme |
| Manuelle Wahl „Einsatzort im Gemeindeteil“ | überschreibt die automatische Bestimmung, wird protokolliert | Vorgabe |

### Anfahrt fremder Fahrzeuge (`PARAMS.anfahrt`, geschätzt, kein Routing)

| Parameter | Wert | Status |
|---|---|---|
| Formel | Ausrückzeit + Luftlinie Wache→Einsatzstelle × Umwegfaktor ÷ Geschwindigkeit; Bereitschaft = Anfahrt + Aufbau (45 min Riegel, 15 min Objektschutz) | Annahme |
| `umwegfaktor` | 1,4 | Annahme, zu prüfen |
| `kmh` | ELW/KdoW/MTF/MTW 60, HLF/LF/MLF/TSF/GW 50, TLF/DLK/SW 45 km/h (Präfix des Typs) | Annahme |
| `ausrueckMin` | FF 7 min (Spanne 5–8 min), BF 1,5 min; Wache kann `ausrueckzeit_min` angeben | Annahme |
| `maxAnfahrtMin` | 45 min (Option im UI); Pflichtfahrzeuge unabhängig davon | Annahme |
| ohne Koordinate | Fahrzeug nicht eingeplant, Hinweis (Ausnahme: Pflichtfahrzeug, dann Ersatzwert 30 min + Aufbau) | Vorgabe/Annahme |
| zu spät für Riegel | Bereitschaft + Mindest-Wirkzeit (30 min) später als die „möglich“-Front an der Linie | Annahme (Wirkzeit) |
| Bereitstellungsraum begrenzt | max. 3 Reserve, 2 Führung, 2 Personal (nächste zuerst); weitere „nicht benötigt“ | Annahme |
| Großtanker | Typen `TW `, `LTW`, `WLF`: nur Wasserversorgung/Pendelverkehr, dort bevorzugt; nicht für Grundschutz | Annahme |

### Pflichtfahrzeuge und Grundschutz (Vorgabe Auftraggeber)

| Parameter | Wert | Status |
|---|---|---|
| `pflichtFahrzeuge` | se-hlf20, se-lfkats, se-lf20 (LZ Seelscheid); je Fahrzeug im UI änderbar (Häkchen „Pflicht“) | **Vorgabe Auftraggeber** |
| Vorrang | Pflichtfahrzeuge erhalten Aufgaben vor allen anderen; Sicherheitsregeln gelten weiter; ohne sichere Aufgabe „Pflichtfahrzeug – bereitgestellt“ im Bereitstellungsraum (nicht Reserve) mit Begründung | Vorgabe |
| nicht verfügbar | nicht eingeplant, deutlicher Hinweis | Vorgabe |
| `grundschutz.wachen` | Gerätehäuser lz-nk (Sankt-Franziskus-Weg 3), lz-se (Hausener Straße 2) | Vorgabe |
| Auswahl | verfügbares, wasserführendes Fahrzeug einer anderen Kommune, nicht im Einsatz, nicht doppelt; Typstufe HLF/LF vor TLF/MLF/TSF-W vor sonstigen, innerhalb der Stufe kürzeste geschätzte Anfahrt zum Gerätehaus | Vorgabe; Typstufen = **Annahme** |
| ohne Nachbarfahrzeug | „Kein Fahrzeug aus Nachbarkommune verfügbar – Grundschutz nicht sichergestellt“ | Vorgabe |

### Geländewind (`PARAMS.terrain.wind`, vereinfachte diagnostische Korrektur)

| Parameter | Wert | Quelle / Status |
|---|---|---|
| Schalter | `enabled` (UI „Geländewind: an/aus“); aus = Rechnung wie 0.3.0, bitgenau (Prüfsummentest) | Vorgabe |
| Glättung | Box-Filter Radius 2 Zellen, 3 Durchläufe (≈ Gauß) auf Höhe; Sx 2 Durchläufe; Strukturtensor Fenster ±150 m | Annahme |
| Abschattung Sx | max. Horizontwinkel in Luv-Richtung bis 300 m (16 Sektoren, linear interpoliert), Normierung 15°, Gewicht 0,25 | Methode: Winstral, Elder & Davis (2002), J. Hydrometeorology 3; Werte Annahme |
| TPI | Höhe − Mittel im Quadrat ±400 m, Normierung 40 m, Gewicht 0,15 | Methode verbreitet (Weiss 2001, **zu prüfen**); Werte Annahme |
| Luv-/Leehang | Neigung in Windrichtung, Normierung tan 0,3, Gewicht 0,15 | angelehnt an MicroMet (Liston & Elder 2006, **zu prüfen**); Werte Annahme |
| Faktor | 1 − 0,25·Sx + 0,15·TPI + 0,15·Luv, begrenzt 0,5–1,4 | Annahme (Auftrag) |
| Tal | Taltiefe −TPI 5–30 m (linear), Kohärenz Strukturtensor 0,3–0,7; Drehung zur Talachse bis 70 % × √cos(Winkel); Dämpfung quer zum Tal bis 30 % | Annahme |
| Hangwind | nur bei synoptischem Wind < 12 km/h (linear abnehmend); tags bis 2 m/s hangaufwärts (voll ab Sonnenhöhe 20°), nachts bis 1,5 m/s hangabwärts (voll ab −6°); volle Stärke ab Neigung tan 0,3 | Annahme (Größenordnung 1–3 m/s laut Auftrag) |
| Sonnenstand | NOAA „General Solar Position Calculations“ (Deklination, Zeitgleichung, Refraktion 0,833° für Auf-/Untergang) | Formeln aus Literaturkenntnis, Test gegen bekannte Zeiten (±15 min) |
| Tageszeit | Mitte der Prognosestunde; ohne Zeitstempel weder Hangwind noch Feuchtekorrektur | Annahme |
| Ensemble | Stärke aller Geländekorrekturen je Lauf ×0,5–1,5 (gleichverteilt), Referenzlauf ×1 | Annahme |
| Anzeige | Pfeile alle 250 m, Länge 170 m × Faktor (0,45–1,8), Farbe: < 0,75 / 0,75–0,95 / 0,95–1,05 / 1,05–1,2 / > 1,2 | nur Darstellung |
| Nicht modelliert | Massenerhaltung (WindNinja: Phase 3), Wirbel/Leewalzen, feuerinduzierte Winde, Inversionen/Kaltluftseen, Föhn (hier nicht relevant), Bewölkung | Grenze |

### Feinbrennstofffeuchte nach Exposition (`PARAMS.terrain.moisture`)

| Parameter | Wert | Status |
|---|---|---|
| Ansatz | tagsüber dM = −8 %-Pkt. × (cos Einfallswinkel am Hang − cos Zenit), begrenzt −3 … +3 %-Pkt., × Ensemble-Stärke; nachts 0; wolkenlos | **eigene, einfache Annahme**; Fosberg/Rothermel-Korrekturtabellen NICHT übernommen (Werte nicht sicher bekannt) |
| Wirkung | 1-h und 10-h voll, 100-h nicht | Annahme |
| Quantisierung | 0,25 %-Pkt. für die Ratentabelle | Rechentechnik |

### Gemessene Wirkung und Laufzeit (tests/model.test.mjs, Node 22, Sandbox)

| Lage | Rechenzeit Ensemble 24+1 aus / an | Fläche 6 h „möglich“ | Referenzlauf 6 h |
|---|---|---|---|
| Hang südl. Gemeindegebiet, Grünland, 6 km/h SW | 127 / 617 ms | 561,6 → 542,8 ha (−3,4 %) | −9,9 % |
| dto., 12 km/h SW | 412 / 1.043 ms | 2.593,6 → 2.457,6 ha (−5,2 %) | −15,0 % |
| Tal bei Eischeid, 6 km/h SW | 153 / 533 ms | −3,5 % | −20,7 % |
| dto., 12 km/h SW | 418 / 681 ms | −0,5 % | −20,1 % |
