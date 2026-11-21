# Architektur und Modellwahl (Kurzfassung)

## Entscheidungen

| Thema | Gewählt | Alternativen | Begründung |
|---|---|---|---|
| Frontend | HTML/CSS/JS ohne Build, Leaflet 1.9.4 lokal | TypeScript + React/Svelte, MapLibre GL | Prototyp ohne Toolchain lauffähig (`python3 -m http.server`), WMS von Geobasis NRW in Leaflet direkt nutzbar, keine CDN-Abhängigkeit (Offline vorbereitet). Umstieg auf TypeScript/MapLibre für Phase 2 sinnvoll. |
| Ausbreitung | Rothermel (1972) + Ellipse nach Anderson (1983) auf Raster, Minimum-Travel-Time (Dijkstra, 16er-Nachbarschaft) | Huygens-Vertexpropagation (FARSITE-Ansatz), zellulärer Automat, ELMFIRE/Cell2Fire | Raster ist robust bei heterogenem Brennstoff und Barrieren, einfach ensemble-fähig, im Browser schnell (Sekunden). Huygens liefert glattere Fronten, ist aber aufwendiger (Schleifen, Überschneidungen). |
| Unsicherheit | Ensemble (24 Läufe) mit Variation Windrichtung, Windstärke, Feuchte | Monte-Carlo über Brennstoff, Bayes-Kalibrierung | Spezifikation 2.3, einfach erklärbar („Anteil der Läufe“). |
| Projektion | lokale äquidistante Näherung um den Brandschwerpunkt | EPSG:25832 (UTM32) | Kein proj4-Bedarf; Fehler im 10-km-Gebiet < 0,1 %. **Abweichung von der Spezifikation**, Umstellung offen. |
| Brennstoff | OSM-Landnutzung → Anderson 13 (Annahme) | ATKIS, Forstdaten NRW, CORINE | Im Browser per Overpass abrufbar; andere Quellen Zugang offen. |
| Gelände | DGM1 NRW (Geobasis NRW, dl-de/zero-2-0), vorab mit `tools/build-dgm.py` auf ca. 25 m gemittelt, als `data/dgm25.bin` (Int16, dm, 1,35 MB) im Projekt | Live-Abruf WCS/WMS, DGM25/DGM50, UTM-Raster | Offline nutzbar, kein Dienst zur Laufzeit nötig. Raster in **EPSG:4326** (reguläres lat/lon-Gitter, 0,000355° × 0,000225° ≈ 24,9 × 25,0 m), weil `grid.js` mit lat/lon und lokaler Projektion arbeitet: `Dem.sample(lat, lon)` ist reine Indexrechnung (bilinear), ohne proj4/UTM-Formeln im Browser. Gebiet: Gemeinde (DVG1) + 5 km. |
| Hangeffekt | Rothermel-Hangfaktor je Rasterkante, additiv zur Wind-Ellipsenrate (siehe unten) | effektiver Wind-/Hangvektor (Rothermel 1972, Albini; FARSITE), Exposition | Raten werden je Stunde/Klasse/Richtung vorberechnet (eben). Der Hang hängt von der Kante ab und wird deshalb in `travelTime` ergänzt: bergauf `R(θ) + R0 · 5,275 · β^−0,3 · min(tan, 0,7)²`, bergab `R(θ)`. Einfach, deterministisch, mit flachem DGM exakt gleich dem bisherigen Ergebnis. Vektorielle Kombination: Phase 2. |
| Kartendarstellung | Standard: Isochronen je Horizont aus Zeitfeldern (Zeit „möglich“/„wahrscheinlich“/Referenz je Zelle) per Marching Squares mit linearer Interpolation zwischen Zellmittelpunkten, Chaikin (2 Iterationen), Douglas-Peucker (5 m); Bänder (Horizont h ohne h−1, Füllregel evenodd), „möglich“ als SVG-Pattern. Umschaltbar: Rasteransicht als Zellumrisse (Treppenlinien), ebenfalls Vektor | Rasterbild (Canvas) wie bis 0.2.0, Kernel-Glättung, Konturen auf Wahrscheinlichkeitsfeld | Zeitfelder interpolieren physikalisch sinnvoll (Ankunftszeit wächst etwa linear mit dem Abstand), Kontur bei t = Horizont ist eine Isochrone. Nicht erreichte Zellen (Barrieren) und Brandflächenzellen werden so behandelt, dass die Fläche zur Rasterfläche passt (Tests: ≤ 3 % ab 100 Zellen). Vektor statt Canvas: keine Pixelartefakte, Schraffur unabhängig von der Zoomstufe. |
| Backend | keines | Wetter-Proxy, Vorverarbeitung | Ziel Betrieb ohne Backend. Für Produktion: Overpass-/Kachel-Vorverarbeitung als Datenpaket. |
| Protokoll | localStorage, SHA-256-Hash-Kette | IndexedDB, serverseitige revisionssichere Ablage | Einfach, manipulationserkennend; Aufbewahrung offen. |

## Schnittstellen (austauschbar)

- **Modell**: `FireModel.runEnsemble({grid, classList, ignition, weatherHours, horizonsH, P, runs, seed}, onProgress)` → `{counts[h], earliest, reference, refInfo, perturbations, tPossible, tLikely, quantileRuns}`. `tPossible[k]`/`tLikely[k]` = Zeit (min), ab der ≥ 10 % bzw. ≥ 50 % der Läufe die Zelle erreicht haben (m-te kleinste Ankunftszeit); exakt konsistent mit `counts`. Ein anderes Modell muss mindestens `counts`, `earliest`, `reference` liefern; ohne `tPossible`/`tLikely` werden grobe Zeitfelder aus den Horizont-Zählern abgeleitet.
- **Anzeige**: `Contour.displayLayers(nx, ny, result, P, {mode: "kontur"|"raster", ignition})` → je Horizont Ringe (Zelleinheiten) für „wahrscheinlich“, „möglich“, Referenz und Flächenstatistik.
- **Vorschläge**: `Suggest.compute(...)` → `{lines, vehicles, notes, stageInfo, lineInfo {readyMin, checkMin, found, rejected, reason}, objects, demand}`.
- **Wetter**: Objekt `{source, kind, fetchedAt, rows[{t, tempC, rh, precipMm, windKmh, windDirDeg, gustKmh}]}`. Weitere Quellen (DWD) liefern dieselbe Struktur.
- **Basiskarte**: Leaflet-Ebenen in `app.js`; Google nur als zusätzliche Anzeige-Ebene bei Key in `config.js`.
- **Daten**: `Osm.applyOsm(grid, overpassJson, P)` → Brennstoffraster + Objekte + Kandidaten. Ein vorab erzeugtes Datenpaket kann dasselbe Format liefern.
- **Gelände**: `Dem.load(url)` → `{dem, error}`; `dem.sample(lat, lon)` → Höhe in m oder `null`. `Grid.makeGrid(..., dem)` füllt `g.elev` (NaN = keine Daten), `g.slope`/`g.aspect` (Horn, nur Anzeige/Kennzahlen). Das Modell nutzt `g.elev`, wenn vorhanden (`runEnsemble` → `slopeUsed`). Ein anderes Höhenmodell muss nur `sample(lat, lon)` liefern.
- **DGM-Datei**: `data/dgm25.json` (Ursprung `west`/`north`, `dLon`/`dLat`, `nx`/`ny`, CRS, Quelle, Abrufdatum, Lizenz, Kachelliste/-stand, Statistik, SHA-256) + `data/dgm25.bin` (Int16 little-endian, Dezimeter, NoData −32768, Zeile 0 = Norden).

## Datenfluss

Polygon → Rechenraster (10 × 10 km, 25 m) → Höhe je Zelle aus DGM (falls geladen) → Brennstoff (OSM oder Ersatz) → Wetter je Stunde (+ Überschreibungen, Szenario) → Raten je Stunde/Klasse/Richtung (+ R0 und Hangkoeffizient je Klasse) → Hangzuschlag je Kante in der Minimum-Travel-Time → Referenzlauf + Ensemble (Zähler je Horizont, Zeitfelder „möglich“/„wahrscheinlich“) → Kennzahlen, Erreichzeiten → Vorschläge (Prüfzeitpunkt Bereitschaft + Wirkzeit) → Anzeige (Konturen oder Rasterumrisse) → Karte, Protokoll, Export.

## Laufzeit (gemessen im Test, Chromium in der Sandbox)

Standardszenario (24 Läufe + Referenz, 400 × 400 Zellen, 6 h): unter 1 s bei langsamer Waldausbreitung. Bei schnellem Grasfeuer mit starkem Wind wächst die Rechenzeit mit der erreichten Fläche; Ziel < 30 s, auf Tablets **zu prüfen**.

Mit DGM (e2e-Test, hügeliges Gelände, Grünland, 24 + 1 Läufe): Rechenzeit weiterhin im Bereich von Sekunden; Höhenabfrage für 160.000 Zellen und Horn-Neigung zusätzlich deutlich unter 1 s. Die Offline-Schummerung (790 × 856 Pixel) wird beim ersten Einschalten einmal berechnet.
