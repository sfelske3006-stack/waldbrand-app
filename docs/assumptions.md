# Annahmen und Parameter

Alle Werte stehen versioniert in `js/params.js` (Version `0.6.0-prototyp`); die Werte der Wasserversorgung in
`js/water-params.js` (`PARAMS.wasser`, siehe Abschnitt „Neu in 0.6.0“). Jede Zeile ist eine **Annahme**, bis sie
fachlich bestätigt ist.

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
| Gemeindeteil des Einsatzorts | Gemarkung (ALKIS) → Teil: Seelscheid → Seelscheid (Name, Gerätehaus SE); Wolperath → Neunkirchen (Gerätehaus NK liegt darin); Eischeid, Herkenrath → Neunkirchen, Söntgerath → Seelscheid (näheres Gerätehaus); historische Gemeindegrenze nicht in den offenen Daten, Herleitung über Gemarkungen | **bestätigt vom Auftraggeber (Feuerwehr Neunkirchen-Seelscheid), 22.11.2026** |
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

## Neu in 0.4.2 (Befunde zum Nutzer-Screenshot „nur zwei Fahrzeuge an der Front“)

### Befunde (Code-Belege)

| Beobachtung | Ursache | Beleg |
|---|---|---|
| nur EINE Riegellinie | Ohne OSM-Daten erzeugt `lineSuggestions` genau eine geometrische Ersatzlinie: die erste Lage quer zur Hauptrichtung, die alle Bedingungen erfüllt, und kehrt sofort zurück. Es werden keine Alternativen bewertet, die Verwerfungszähler bleiben 0. | `js/suggest.js` (geometrischer Zweig in `lineSuggestions`, `return` in der Schleife über `d`) |
| wenige Fahrzeuge an der Linie | Grundbesetzung = `ceil(Länge / sectionPerVehicleM)` (300 m), gekappt auf `maxVehiclesPerLine` (4). Abschnitte ohne rechtzeitig einsatzbereites Fahrzeug bleiben frei (Sicherheitsregel: Bereitschaft + `lineMinLeadMin` ≤ Ankunft der „möglich“-Front). | `js/suggest.js` (`lineTasks`, Prüfung `ready + lineMinLeadMin > line.minArrivalMin`) |
| kein Objektschutz | `threatenedObjects` braucht `osm.objects.wohnbebauung`; ohne OSM-Daten gibt es keine Gebäudedaten. Mit OSM gilt: Bebauung höchstens `objectThreatDistM` (50 m) von der 6-h-„möglich“-Zone entfernt. | `js/suggest.js` (`threatenedObjects`), `PARAMS.suggestions.objectThreatDistM` |
| wasserführende Fahrzeuge als „Reserve“ | Es gab nur Aufgaben zur ERSTEN Bereitschaftsstufe (früheste Bereitschaft). Fahrzeuge der zweiten Stufe (z. B. Löschzug im anderen Gemeindeteil, 40 statt 25 min) waren für die vorderste Linie zu spät und fielen deshalb pauschal in den Bereitstellungsraum. Die zweite Prüfgrenze wurde nur gezeichnet, aber nicht zur Planung genutzt. | `js/suggest.js` (`lineInfo.second`), `js/app.js` (`ready-label r2`) |
| Grundschutzfahrzeug im Bereitstellungsraum | Der Grundschutz wurde ZULETZT berechnet und durfte nur Fahrzeuge nehmen, die nicht „eingeplant“ waren – auch die bloße Reserve/Bereitstellung galt als eingeplant. Damit verdrängte die Reserve die Vorgabe Grundschutz. | bis 0.4.1: `grundschutz(..., planned, ...)` am Ende von `compute` |

### Korrekturen

| Thema | Neu | Status |
|---|---|---|
| Reihenfolge | Einsatzaufgaben (Riegel, Objektschutz, Wasserversorgung) → **Grundschutz (Vorgabe)** → Verstärkung/Flanke → Bereitstellungsraum. Ein Grundschutzfahrzeug steht am Gerätehaus und erscheint nie im Bereitstellungsraum. | Vorgabe umgesetzt |
| Auffanglinie zweite Stufe (`secondStageLines`, `lineMinSeparationM`) | Sind Fahrzeuge für die vorderste Linie zu spät einsatzbereit, wird eine zweite Riegelstellung gegen die „möglich“-Zone zum SPÄTEREN Prüfzeitpunkt gesucht (mind. 200 m hinter der ersten). Findet sich keine, wird das begründet. | Annahme |
| Verstärkung/Ablösung (`lineReinforceToMax`) | Bleiben rechtzeitig einsatzbereite Löschfahrzeuge übrig, wird eine Linie bis `maxVehiclesPerLine` dichter besetzt, statt die Fahrzeuge zu parken. Die 300 m je Fahrzeug sind weiterhin eine Planungsannahme ohne Beleg aus der Fachliteratur. | Annahme, **offen** |
| Flankensicherung (`maxFlankVehicles`, `flankOffsetM`) | Neue Aufgabe „Flanke“: bis zu 2 übrige wasserführende Fahrzeuge seitlich der Hauptausbreitungsrichtung (seitliche Ausdehnung der „möglich“-Zone + 150 m je Stufe). KEINE durchgehende Flankenlinie, keine Barrierenprüfung. | Annahme, **offen** |
| Begründung je Fahrzeug im Bereitstellungsraum | Jedes Fahrzeug nennt den konkreten Grund (zu spät für Riegel X, kein sicherer Standort, Aufgaben an früher bereite Fahrzeuge vergeben, kein Löschwasser) und seine Bereitschaftszeit. | – |
| Hinweis geometrische Linie | Ohne OSM weist die App ausdrücklich darauf hin, dass genau eine Ersatzlinie je Bereitschaftsstufe erzeugt und keine Alternative bewertet wird. | – |
| Kartenbeschriftungen | Überlappende Label (Fahrzeuge, Linien, Prüfgrenzen, Horizonte) werden nach dem Zeichnen gemessen und senkrecht/waagerecht versetzt; die Markerposition bleibt unverändert (nur Anzeige). | – |

Unverändert (bewusst NICHT aufgeweicht): Mindestabstand zur „möglich“-Zone, Sicherheitspuffer `vehicleSafetyMin`,
Mindest-Wirkzeit `lineMinLeadMin`, Mindestabstand zum 1-h-Bereich, Befahrbarkeitsprüfung, Pflichtfahrzeug-Vorrang.

## Neu in 0.5.0 (Ortssuche)

Die Suche enthält **keine Modellparameter**; sie liefert nur Orte. Trotzdem gehen Annahmen und Festlegungen ein, die die
Lagebeurteilung beeinflussen können:

| Thema | Festlegung | Status |
|---|---|---|
| Suchgebiet | Neunkirchen-Seelscheid + alle Kommunen mit gemeinsamer Grenze laut DVG1 (Overath, Siegburg, Ruppichteroth, Lohmar, Much, Hennef). Außerhalb gibt es nur Koordinaten oder die Online-Suche. | Festlegung (Gebiet der Fahrzeugdaten) |
| Ortsteile | „Ortsteil“ = benannte **Ortslage** des Basis-DLM (`AX_Ortslage`, Attribut `NAM`). Das ist nicht identisch mit den amtlichen Ortsteilen/Wohnplätzen; kleine Weiler ohne Ortslage fehlen. | **Annahme**, mit dem Auftraggeber zu prüfen |
| Mittelpunkt einer Straße | diejenige Hausadresse, die dem Schwerpunkt aller Adressen der Straße am nächsten liegt (liegt damit sicher an der Straße, anders als der geometrische Schwerpunkt). | Annahme (nur Anzeige) |
| Fläche statt Punkt | Straße, Ortsteil und Kommune zoomen auf die umschließende BBox (Straße mit 15 % Rand); „Als Zündpunkt setzen“ nimmt dort den Mittelpunkt. Das ist **kein** Hinweis auf den tatsächlichen Brandort. | Annahme (Anzeige) |
| Gleichnamige Straßen | Straßen gleichen Namens in einer Gemeinde (unterschiedliche Straßenschlüssel) bleiben getrennt; unterschieden wird über die Ortslage. Treffer in Neunkirchen-Seelscheid stehen vor Treffern aus Nachbarkommunen (Bonus). | Annahme (Ranking) |
| Hausnummern | Zusatz wird berücksichtigt („12a“); unbekannter Zusatz → Hausnummer ohne Zusatz mit Hinweis; Bereiche („12-14“) werden auf die erste Nummer abgebildet; unbekannte Nummer → Straße mit Hinweis. | Annahme |
| Lagequalität der Adressen | Kennzeichen A/B/C aus `gebref` wird angezeigt; die Bedeutung ist **zu prüfen** (Formatbeschreibung in der Erstellungsumgebung nicht abrufbar). Die Koordinate ist die **Gebäudereferenz**, nicht die Zufahrt. | **offen** |
| Tippfehlertoleranz | eine Vertauschung/Auslassung (OSA-Distanz 1), ab 8 Zeichen zwei. Keine phonetische Suche. | Annahme |
| Koordinaten | ETRS89 = WGS84 gesetzt (Abweichung < 1 m, wie beim DGM). UTM nur Nordhalbkugel; Gauß-Krüger (DHDN) wird **abgelehnt** statt genähert. Koordinaten außerhalb von Suchgebiet oder DGM werden gekennzeichnet. | Festlegung |
| Rettungspunkte: Aktualitätsfrist | Warnung, wenn die Veröffentlichung mehr als **7 Monate** zurückliegt (`PARAMS` unabhängig, Konstante `rpMaxAgeMonths` in `js/search.js` und `KWF.maxAgeMonths` in `js/app.js`). Das KWF exportiert etwa zweimal jährlich; die Frist ist eine **Annahme** auf dieser Grundlage. | Annahme |
| Rettungspunkte: Ausschnitt | Nur Punkte im Gebiet (BBox + ca. 2 km): 655 von 71.621. Inhalt unverändert. Ob die Weitergabe eines Ausschnitts unter **CC BY-ND 4.0** zulässig ist, ist **lizenzrechtlich zu prüfen**. | **offen** |
| Rettungspunkte: Darstellung | Marker ab Zoom 13, Nummer ab Zoom 14; Nummern, die andere Kartenbeschriftungen überdecken würden, werden ausgeblendet (Marker und Popup bleiben erreichbar). Dadurch sind bei dichter Lage **nicht alle Nummern gleichzeitig lesbar**. | Annahme (Anzeige) |
| Online-Suche | Nur auf ausdrückliche Aktion, höchstens 1 Anfrage/s, `bounded=1` auf das Gebiet, keine Weitergabe personenbezogener Daten (kein `email`-Parameter gesetzt). Der eingegebene Suchtext verlässt dabei das Gerät – darauf weist die Listenzeile hin. | Festlegung, Nutzungsbedingungen **zu prüfen** |
| Datenschutz | Suchindex und Rettungspunkte liegen offline im Projekt; ohne Online-Suche verlässt kein Suchtext das Gerät. Jede Auswahl wird lokal im Sitzungsprotokoll vermerkt (Hash-Kette). | Festlegung |

## Neu in 0.6.0 (Wasserversorgung)

**Simulation mit Annahmen, keine Einsatzplanung.** Alle Werte stehen in `js/water-params.js` (`PARAMS.wasser`,
Parameterversion `0.1.0-entwurf`). **Nichts davon ist validiert**: kein Abgleich mit einem Löschwasserkataster, keine
Pumpenkennlinien, keine Ortskenntnis. Kennzeichnung wie im Modul: `[V]` Vorgabe Auftraggeber, `[App]` aus den
bestehenden App-Parametern übernommen (dort selbst Annahme), `[F]` Faustwert aus der Feuerwehrausbildung
(**Primärquelle nicht eingesehen**), `[P]` physikalisch begründet, `[A]` Annahme ohne belegte Quelle.

### Zeit und Verfahren

| Parameter | Wert | Status | Bemerkung |
|---|---|---|---|
| `horizonMin` | 360 min | `[V]` | Prognosezeitraum 6 h wie im übrigen Lagebild |
| `dtMin` | 1 min | `[V]` | Warteschlangen rücken zu Beginn des nächsten Schrittes nach, Diskretisierungsfehler ≤ 1 min je Vorgang |
| Fahrwege | Luftlinie × Umwegfaktor | `[App]` | **kein Routing**, keine Steigungen, Engstellen, Wendeprobleme |
| Determinismus | keine Zufallszahlen | – | gleiche Eingabe ⇒ gleiches Ergebnis (durch Test abgesichert) |

### Wasserbedarf der Abnehmer (`bedarf`)

| Parameter | Wert | Status | Bemerkung |
|---|---|---|---|
| Riegelstellung je Fahrzeug | 2 C-Rohre × 150 l/min = 300 l/min | `[A]` | Auftrag nennt 100–200 l/min je Rohr; 150 l/min als Mittelwert. **Zu prüfen:** tatsächliche Rohranzahl je Fahrzeug |
| Objektschutz je Fahrzeug | 2 × 100 l/min = 200 l/min | `[A]` | **zu prüfen** |
| Flankensicherung | wie Riegelstellung (300 l/min) | `[A]` | Festlegung der Integration 0.6.0, **mit der Feuerwehr zu prüfen** |
| Wenderohr (`mode: "wenderohr"`) | 800 l/min | `[A]` | in der App derzeit nicht gesetzt |
| `einsatzAnteil` | 1,0 | `[A]` | durchgehende Wasserabgabe, konservativ; realistisch kleiner (Pausen, Umsetzen) – **festlegen** |
| Tanknachfüllung des Abnehmers | 400 l/min, erst ab 50 % Beckenfüllung | `[A]` | damit der Tank des Abnehmers das Becken nicht leert |
| `maxAbstandBeckenM` | 400 m | `[A]` | nur Hinweis in der Oberfläche, keine Rechengröße |
| Beginn des Bedarfs | ab der **Bereitschaftszeit des jeweiligen Fahrzeugs** (`readyMin` aus `js/suggest.js`) | `[App]` | Auffanglinie der zweiten Bereitschaftsstufe liefert dadurch automatisch spätere Abnehmer |

### Entnahmestellen (`quellen`)

| Parameter | Wert | Status | Bemerkung |
|---|---|---|---|
| Hydrant ohne Angabe | 800 l/min | `[A]` | entspricht dem kleinsten Löschwasserbedarfswert (48 m³/h) der Tabelle in **DVGW W 405**; das ist der Bedarf eines Versorgungsgebiets, **keine Leistungszusage je Hydrant**. Normtext nicht eingesehen. **Zu prüfen: Löschwasserkataster / Wasserversorger** |
| Hydrant nach Durchmesser | ≤ 80 mm: 600; ≤ 100: 800; ≤ 150: 1.200; sonst 1.600 l/min | `[A]` | grobe Staffel ohne Quelle, **zu prüfen** |
| Hydrant: OSM-Tags | `flow_rate`, `fire_hydrant:flow_capacity`, `…:flow_rate`, `flow_capacity` (m³/h und l/s umgerechnet) | – | gelten als **ungeprüft** |
| Füllplätze je Hydrant | 1 gleichzeitig | `[A]` | ein Standrohr; Doppelstandrohr **zu prüfen** |
| Rüstzeit Hydrant | 3 min je Füllung | `[A]` | Standrohr setzen, kuppeln, abkuppeln |
| Offenes Gewässer: Füllrate | Nennförderstrom × 0,5 | `[A]` | Saughöhe, Saugleitung, Tankfüllleitung. **Zu prüfen** |
| Offenes Gewässer: gleichzeitig | 2 Fahrzeuge | `[A]` | setzt zwei nutzbare Saugstellen voraus – vor Ort selten gegeben |
| Rüstzeit offenes Gewässer | 6 min je Füllung | `[A]` | |
| Zuschlag „unsicheres“ Gewässer | 10 min bei der Auswahl | `[A]` | Steuergröße, keine physikalische Größe |
| Löschwasserteich/-behälter ohne Tag | 100 m³ | `[A]` | **zu prüfen**, Kataster |
| Gewässer „ausreichend“ ab | 5.000 m² Fläche; Fluss = ausreichend, Bach = unsicher | `[A]` | Wasserführung im Sommer unbekannt, reine Typzuordnung. Die App liefert für Gewässerflächen **keine Fläche** mit (`js/osm.js` setzt nur den Mittelpunkt) – sie werden deshalb als „unsicher, Größe unbekannt“ eingestuft |
| Gewässer verworfen unter | 300 m² | `[A]` | |
| Zugang zum Gewässer | befahrbarer Weg ≤ 30 m | `[A]` | Uferbeschaffenheit, Saughöhe, Wenden **nicht** geprüft |
| `maxPendelM` | 8.000 m Luftlinie | `[A]` | weiter entfernte Entnahmestellen werden nicht angefahren |
| Manuell gesetzte Stelle ohne Typ | wie Hydrant ohne Angabe (800 l/min) | `[A]` | in der Oberfläche als Annahme gekennzeichnet |

**Grundsätzlich:** Entnahmestellen aus OpenStreetMap sind **ungeprüft** (Lage, Existenz, Ergiebigkeit). Die Oberfläche
kennzeichnet sie (gestrichelter Rand, „?“, Tabellenspalte). Verifiziert sind nur die in der App bestätigten Punkte.
**Ohne OSM-Daten werden keine Entnahmestellen angenommen**; der Reiter weist darauf hin.

### Schlauchleitung / Förderstrecke (`schlauch`)

| Parameter | Wert | Status | Bemerkung |
|---|---|---|---|
| Grenze Schlauch ↔ Pendelverkehr | 600 m Schlauchweg | `[V/A]` | im Auftrag als Beispiel genannt, konfigurierbar |
| Umwegfaktor Schlauchweg | 1,2 | `[App]` | wie `suggestions` |
| Druckverlust B-Leitung | 1,0 bar je 100 m bei 800 l/min, quadratisch mit Q | `[F]` | Ausbildungsfaustwert, Primärquelle nicht eingesehen; Schlauchalter/-typ unberücksichtigt |
| max. Förderstrom je Leitung | 1.200 l/min | `[A]` | eine B-Leitung; zwei parallele Leitungen **nicht** modelliert |
| Auslegungsreserve | Bedarf × 1,25, mindestens 400 l/min | `[A]` | |
| Pumpenausgangsdruck | 8 bar | `[F/A]` | **keine Pumpenkennlinie**, fester Wert je Fahrzeug |
| Mindesteingangsdruck | 1,5 bar | `[F]` | |
| Höhendruck | 0,1 bar je m | `[P]` | 10 m Wassersäule ≈ 0,98 bar |
| Höhenprofil | DGM 25 m, Schritt 25 m entlang der Luftlinie, höchster Punkt maßgebend | – | DGM1 NRW, Geobasis NRW, dl-de/zero-2-0; der echte Schlauchweg kann anders verlaufen. Ohne DGM wird die Höhe **nicht** geprüft |
| Aufbauzeit | 10 min + 2 min je 100 m | `[A]` | hängt an Personal und Gelände |
| Pumpenstandorte | gleichmäßig verteilt | `[A]` | Befahrbarkeit der Standorte **nicht** geprüft |

### Pendelverkehr (`pendel`)

| Parameter | Wert | Status | Bemerkung |
|---|---|---|---|
| Umwegfaktor Fahrweg | 1,3 | `[App]` | wie `suggest.waterText` |
| Geschwindigkeit Straße / Waldweg | 25 / 10 km/h | `[App]` / `[A]` | langsamer Anteil = Abstand zur nächsten Straße. **Zu prüfen** |
| Füllrate am Hydranten | min(Pumpe, Ergiebigkeit), höchstens 1.600 l/min | `[A]` | max. 2 B-Leitungen |
| Füllrate ohne Pumpe (TW/LTW) | 800 l/min | `[A]` | **zu prüfen** – für die Großtanker entscheidend |
| Entleeren ins Becken | 1.600 l/min (ohne Pumpe 800) | `[A]` | Auftrag nennt 1.600–2.000 l/min |
| Rüstzeit am Becken | 2 min je Entleerung | `[A]` | |
| Anfahrt mit vollem Tank | ja | `[A]` | Fahrzeuge entleeren zuerst ins Becken |
| max. Anfahrt | 90 min | `[A]` | Großtanker werden trotz langer Anfahrt bevorzugt |
| Großtanker ab | 8.000 l oder Typ `TW`/`LTW`/`WLF` | `[A]`/`[V]` | bevorzugte Auswahl (Auftrag: Großtanker bevorzugen) |
| TLF ab | 2.400 l oder Typ `TLF`/`PTLF` | `[A]` | |
| Reservefaktor der Planung | 1,15 | `[A]` | |
| Beckenwechsel nach | 3 min Warten | `[A]` | |
| Nachplanung | max. 6 Durchläufe, ab 5 % ungedecktem Bedarf | `[A]` | nur Verbesserungen werden übernommen |

### Pufferbecken (`becken`)

| Parameter | Wert | Status | Bemerkung |
|---|---|---|---|
| Volumen | 5.000 l | `[V]` | Faltbehälter laut Auftrag |
| **Einspeisestellen je Becken** | **1** | **`[A]`** | **Größter Engpass im Modell**: Im Entwurfsszenario des Moduls entfielen dadurch ca. 23 % der Einsatzzeit der Pendelfahrzeuge auf Wartezeit am Becken. Sind zwei gleichzeitige Einspeisungen möglich, ändert sich das Ergebnis deutlich. **Vor weiterer Modellarbeit mit der Feuerwehr klären.** |
| Aufbauzeit | 5 min ab Eintreffen des ersten zugeordneten Fahrzeugs | `[A]` | |
| Becken je Gruppe | Bedarf / 600 l/min, aufgerundet, höchstens 4 | `[A]` | reine Dimensionierungsregel |
| **Becken ohne Abnehmer** | als **„Reservestandort“** gekennzeichnet, **nicht eingeplant** | Festlegung 0.6.0 | Die Dimensionierungsregel kann mehr Becken erzeugen, als die Zuordnung „Abnehmer → nächstes Becken“ nutzt. Solche Becken erhalten keine Versorgung und keine Pendelfahrzeuge, erscheinen gestrichelt auf der Karte, mit eigenem Hinweis in der Liste und `rolle` im Export. **Ob sie aufgebaut werden, entscheidet die Einsatzleitung** (vorher wurden sie stillschweigend mitgeplant) |
| Abnehmer-Cluster | 400 m | `[A]` | |
| Standort | 80 m hinter dem Abnehmerschwerpunkt (vom Brand weg), Suchradius 600 m, Mindestabstand 20 m zwischen Becken | `[A]` | |
| Sicherheitsabstand zur „möglich“-Zone | 100 m, Zeitbezug 6 h | `[A]` | Ersatzkriterium, wenn kein Standort außerhalb liegt: Zone darf den Standort frühestens 120 min nach Bereitschaft erreichen |
| Standortbewertung Waldweg | 50 m Strafmaß gegenüber Straße | `[A]` | |
| Untergrund, Platzbedarf, Gefälle | **nicht geprüft** | – | ein Faltbehälter braucht eine ebene Fläche – die Simulation kennt sie nicht |

### Fahrzeugauswahl und Ausschlüsse (`fahrzeuge`)

| Regel | Status | Bemerkung |
|---|---|---|
| Fahrzeuge der Kommune Neunkirchen-Seelscheid ausgeschlossen | `[V]` | eigene Kräfte für Riegel/Objektschutz/Grundschutz |
| Pflichtfahrzeuge (`se-hlf20`, `se-lfkats`, `se-lf20`) ausgeschlossen | `[V]` | aus `PARAMS.pflichtFahrzeuge` |
| Grundschutzfahrzeuge an den Gerätehäusern ausgeschlossen | `[V]` | aus `suggest.grundschutz` |
| Abnehmer selbst (Riegel, Auffanglinie, Flanke, Objektschutz) ausgeschlossen | `[A]` | ein Fahrzeug hat eine Aufgabe |
| Fahrzeuge im **Bereitstellungsraum** und mit der Vorschlagsaufgabe **„Wasserversorgung“** bleiben verfügbar | Festlegung 0.6.0 | Sie sind Reserve bzw. genau für diese Aufgabe gedacht. Folge: Die Fahrzeugliste des Wassermoduls kann von den Vorschlägen im Reiter „Lage“ abweichen (dort „Wasserversorgung/Pendelverkehr“ als grobe Abschätzung, hier die gerechnete Zuteilung). **Mit der Feuerwehr abzustimmen** |
| Typen ohne Löschwasser (`ELW, KdoW, MTF, MTW, DLK, DL, GW, RW`) ausgeschlossen | `[App]` | wie `suggestions.noWaterTypes` |
| Tankvolumen unbekannt oder 0, Anfahrt nicht schätzbar, Anfahrt > 90 min | `[A]` | Ausschluss mit Begründung im Reiter |
| Anfahrtszeiten | `[App]` | aus `js/dispatch.js` (Ausrückzeit + Luftlinie × Umwegfaktor ÷ Geschwindigkeit), **kein Routing** |
| Besatzung / Atemschutz / Ablösung nach 6 h | **nicht modelliert** | – |

### Engpassdiagnose (`diagnose`)

| Parameter | Wert | Status |
|---|---|---|
| Entnahmestelle „überlastet“ | ≥ 90 % belegt **und** Ø Wartezeit > 5 min je Füllung | `[A]` |
| Engpass allgemein | Pendelfahrzeuge warten > 25 % ihrer Einsatzzeit | `[A]` |
| Hinweis Becken | Ø Wartezeit je Fahrzeug > 10 min | `[A]` |
| eingeschwungener Zustand | mindestens die letzten 60 min des Zeitraums | `[A]` |
| Empfehlung „zusätzlich X Tanker“ | Defizit / mittlere Lieferung je eingesetztem Pendelfahrzeug | `[A]`, lineare Hochrechnung, gilt nur ohne Engpass an Quelle/Becken |

### Oberfläche

| Festlegung | Status | Bemerkung |
|---|---|---|
| Zeitregler 0–6 h, Schritt 1 min | `[V]` | entspricht `dtMin`/`horizonMin` |
| Geschwindigkeit 1× / 10× / 60× bezogen auf Echtzeit | `[A]` | 60× = 1 h Simulation je Minute; Position zwischen zwei Minutenwerten **linear** interpoliert |
| Füllstandsanzeige | Prozent des 5.000-l-Beckens, blinkender roter Rand bei leerem Becken | – | |
| Schlauchleitung durchgezogen, Pendelroute gestrichelt | `[V]` | Pendelrouten sind **Luftlinien** zwischen tatsächlich genutzter Entnahmestelle und Becken, aus der Simulation abgeleitet |
| Symbole | H = Hydrant (eckig), ≈ = offenes Gewässer (rund), T = Behälter/Teich (gefüllt), ? = Typ offen (gepunktet) | `[A]` | kein genormtes taktisches Zeichen (**zu prüfen:** Darstellung nach FwDV/DV 102 gewünscht?) |
| Bedienelemente ≥ 52 px (`--tap`), Dark/Light wie `css/app.css` | `[App]` | Tablet mit Handschuhen |

### Offene Fragen an die Feuerwehr / den Auftraggeber (Wasserversorgung)

1. **Löschwasserkataster:** Gibt es eine geprüfte Liste von Entnahmestellen mit Ergiebigkeit (Hydranten, Teiche,
   Saugstellen)? Dann ersetzt sie die OSM-Annahmen vollständig.
2. **Hydrantenergiebigkeit:** Welche Werte darf man im Gemeindegebiet ansetzen (800 l/min ist eine grobe Annahme)?
   Zusagen des Wasserversorgers, auch zur gleichzeitigen Entnahme an mehreren Hydranten?
3. **Füllrate der Großtanker ohne eigene Pumpe** (TW 17000, LTW 14000) am Hydranten und an der Saugstelle?
4. **Entleeren ins Faltbecken:** 1.600 l/min realistisch? **Wie viele Fahrzeuge können gleichzeitig einspeisen
   (derzeit 1)?** Das bestimmt den größten Engpass im Modell.
5. **Wasserbedarf je Riegelfahrzeug:** 2 Rohre à 150 l/min durchgehend – oder mit welchem Einsatzanteil? Zählt die
   Flankensicherung wie eine Riegelstellung (derzeit ja)?
6. **Anzahl verfügbarer Faltbehälter (5.000 l) im Kreis** und wer sie bringt – bisher wird angenommen, dass an jedem
   geplanten Standort einer verfügbar ist. Sollen Reservestandorte ohne Abnehmer überhaupt ausgewiesen werden?
7. **Standortkriterien für Becken:** Mindestfläche, Gefälle, Abstand zum Riegel, Räumungsvorlauf – derzeit nur 100 m
   Abstand zur „möglich“-Zone und ein befahrbarer Weg.
8. **Grenze Schlauchleitung ↔ Pendelverkehr:** 600 m sinnvoll? Wie viele B-Leitungen und Verstärkerpumpen stehen zur
   Verfügung?
9. **Pendelgeschwindigkeit** 25 km/h Straße / 10 km/h Waldweg – passt das zu den Erfahrungswerten?
10. **Darstellung:** Sollen die Symbole taktischen Zeichen folgen? Welche Angaben gehören in Ausdruck und Export für
    die Einsatzleitung?
11. **Ablösung/Betriebsdauer:** Was passiert nach 6 h – soll die Simulation Ablösezyklen abbilden?
12. **Fahrzeugzuteilung:** Dürfen Fahrzeuge aus dem Bereitstellungsraum für die Wasserversorgung verplant werden
    (derzeit ja)? Soll die Vorschlagsaufgabe „Wasserversorgung“ im Reiter „Lage“ durch die gerechnete Zuteilung des
    Wassermoduls ersetzt werden?
