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

| Geländewind (0.4.0) | diagnostische Korrektur je Zelle (Sx, TPI, Luvhang, Talachse, Hangwind) auf geglätteten Feldern, lazy je Stunde in `travelTimeTerrain` | WindNinja (massenkonsistent), CFD | offline im Browser, Sekunden statt Minuten; aus = alter Pfad unverändert (bitgenau). Strömungsmodell als Phase-3-Option. |
| Anfahrt (0.4.0) | Luftlinie × Umwegfaktor ÷ Geschwindigkeit + Ausrückzeit; eigene Wehr nach Vorgabe 25/40 min | Routing (OSRM/Valhalla) | keine Server-/Netzabhängigkeit; Routing für Phase 2. |
| Auslieferung (0.4.0) | kleiner Loader in `index.html` (`WB_VERSION`, `WB_JS`, `WB_CSS`) mit `?v=<Version>`, nur relative Pfade | Build-Schritt mit Hash-Dateinamen | kein Build nötig; läuft unter GitHub-Pages-Unterpfad. |

## Schnittstellen (austauschbar)

- **Modell**: `FireModel.runEnsemble({grid, classList, ignition, weatherHours, horizonsH, P, runs, seed}, onProgress)` → `{counts[h], earliest, reference, refInfo, perturbations, tPossible, tLikely, quantileRuns}`. `tPossible[k]`/`tLikely[k]` = Zeit (min), ab der ≥ 10 % bzw. ≥ 50 % der Läufe die Zelle erreicht haben (m-te kleinste Ankunftszeit); exakt konsistent mit `counts`. Ein anderes Modell muss mindestens `counts`, `earliest`, `reference` liefern; ohne `tPossible`/`tLikely` werden grobe Zeitfelder aus den Horizont-Zählern abgeleitet.
- **Anzeige**: `Contour.displayLayers(nx, ny, result, P, {mode: "kontur"|"raster", ignition})` → je Horizont Ringe (Zelleinheiten) für „wahrscheinlich“, „möglich“, Referenz und Flächenstatistik.
- **Vorschläge**: `Suggest.compute(g, result, osm, ignition, vehicles, P, mainDir, state, {stations, maxAnfahrtMin, grundschutzOverride, grenzen, teilMode | teil})` → `{lines, vehicles (mit anfahrt, readyMin, lateFor, pflicht), notes, alerts, stageInfo, lineInfo {readyMin, readyText, checkMin, second, teil, found, rejected, reason}, objects, demand, ctx, grundschutz, dispatch}`. `Suggest.grundschutz(vehicles, stations, P, plannedIds, override)` separat nutzbar.
- **Geländewind**: `TerrainWind.prepare(grid, P)` (statische Felder, gecacht), `makeRunField(prep, weatherHours, P, {strength, dDir, windFactor, wind, moisture, lat, lon})` → `setHour(h)`, `cell(i)` → `{spd, ux, uy, dM, fac, thermal}`; `sampleField(...)` für die Anzeige; `solar()`, `sunTimes()`. Im Modell: `runEnsemble({..., terrain: false | {wind, moisture}})`, Ergebnis `terrainWind`.
- **Anfahrt/Daten**: `Dispatch.estimate(v, stationMap, lat, lon, P)`, `Dispatch.readiness(v, stationMap, lat, lon, setupMin, P, teil)`, `Dispatch.gemeindeteil(lat, lon, grenzen, mode)`, `Dispatch.normalize(json)` (schema 1/2, Synonyme), `filterSort`, `groupByScreen`.
- **Fahrzeugdaten** (`data/fahrzeuge.json`, schema 2): Kopf `stand, gebiet, hinweis, quellen, kommunen[], kreisweit[]`; `wachen[] {id, name, kommune, einheit?, adresse, lat, lon, koordinate_status, koordinate_genau, typ (FF/BF), ausrueckzeit_min?}`; `fahrzeuge[] {id, typ, bezeichnung, kommune, einheit, wache, lat?/lon?, tank_l, tank_quelle, pumpe_lpm, loeschfahrzeug, verfuegbar, pflicht?, quelle, quelle_typ, zugriff, annahmen[], gelaendegaengig}`. Import akzeptiert zusätzlich `vehicles/stations`, `fahrzeugtyp`, `gemeinde`, `latitude/longitude` u. a.
- **Wetter**: Objekt `{source, kind, fetchedAt, rows[{t, tempC, rh, precipMm, windKmh, windDirDeg, gustKmh}]}`. Weitere Quellen (DWD) liefern dieselbe Struktur.
- **Basiskarte**: Leaflet-Ebenen in `app.js`; Google nur als zusätzliche Anzeige-Ebene bei Key in `config.js`.
- **Daten**: `Osm.applyOsm(grid, overpassJson, P)` → Brennstoffraster + Objekte + Kandidaten. Ein vorab erzeugtes Datenpaket kann dasselbe Format liefern.
- **Gelände**: `Dem.load(url)` → `{dem, error}`; `dem.sample(lat, lon)` → Höhe in m oder `null`. `Grid.makeGrid(..., dem)` füllt `g.elev` (NaN = keine Daten), `g.slope`/`g.aspect` (Horn, nur Anzeige/Kennzahlen). Das Modell nutzt `g.elev`, wenn vorhanden (`runEnsemble` → `slopeUsed`). Ein anderes Höhenmodell muss nur `sample(lat, lon)` liefern.
- **DGM-Datei**: `data/dgm25.json` (Ursprung `west`/`north`, `dLon`/`dLat`, `nx`/`ny`, CRS, Quelle, Abrufdatum, Lizenz, Kachelliste/-stand, Statistik, SHA-256) + `data/dgm25.bin` (Int16 little-endian, Dezimeter, NoData −32768, Zeile 0 = Norden).

## Datenfluss

Polygon → Rechenraster (10 × 10 km, 25 m) → Höhe je Zelle aus DGM (falls geladen) → Brennstoff (OSM oder Ersatz) → Wetter je Stunde (+ Überschreibungen, Szenario) → Raten je Stunde/Klasse/Richtung (+ R0 und Hangkoeffizient je Klasse) → Hangzuschlag je Kante in der Minimum-Travel-Time → Referenzlauf + Ensemble (Zähler je Horizont, Zeitfelder „möglich“/„wahrscheinlich“) → Kennzahlen, Erreichzeiten → Vorschläge (Prüfzeitpunkt Bereitschaft + Wirkzeit) → Anzeige (Konturen oder Rasterumrisse) → Karte, Protokoll, Export.

## Suche (0.5.0)

**Entwurfsentscheidungen**

| Thema | Gewählt | Alternativen | Begründung |
|---|---|---|---|
| Suchdaten | vorab erzeugter Offline-Index `data/suche-index.json` (ca. 860 KB) aus amtlichen Daten (gebref, Basis-DLM, DVG1) | Geocoder-Dienst (Nominatim, NRW-Adressdienst) zur Laufzeit, Volltext-Engine (lunr, FlexSearch) | Einsatz ohne Netz muss funktionieren; amtliche Adressen sind vollständiger und genauer als OSM. Keine zusätzliche Bibliothek: eigene Bewertung reicht für 62.000 Adressen und bleibt erklärbar. |
| Ladezeitpunkt | **lazy**: Index und Rettungspunkte erst beim ersten Fokus/Antippen des Suchfeldes (`Search.ensureLoaded`) | beim Start laden, Service Worker, in `index.html` einbetten | Der Start (DGM 1,35 MB, Fahrzeuge, Gemarkungen) bleibt schnell; wer nicht sucht, lädt nichts. Ein Service Worker (Offline-Cache) ist Phase 2. |
| Format | kompaktes Array-Format, Koordinaten in Mikrograd, je Straße delta-kodiert; Hausnummern als Text | GeoJSON, CSV, SQLite/WASM | GeoJSON wäre ca. 4-fach größer. Delta-Kodierung bringt zusätzlich etwa den Faktor 2 bei gzip. |
| Bewertung | eigene Staffel: exakt > Präfix > alle Wörter als Präfix > Wortanfang > ganzer Name mit 1–2 Tippfehlern (OSA/Damerau) > enthält; Bonus für Neunkirchen-Seelscheid und für passenden Kontext (Kommune/Ortslage) | BM25/TF-IDF, trigram, phonetisch (Kölner Phonetik) | Nachvollziehbar und testbar (Tests fixieren die Reihenfolge). Phonetik brächte bei Straßennamen mehr Fehltreffer. |
| Normalisierung | klein, `ß`→`ss`, Umlaute→`ae/oe/ue` **und** Grundvokal, Satzzeichen→Leerzeichen, `Straße/Strasse/Str./Stra…`→`str` | nur NFKD, Wörterbuch | „Hauptstr“, „Hauptstraße“, „Hauptstrasse“, „Hauptstra“ (Eingabe läuft noch) treffen dasselbe; „Rosrather“ findet „Rösrather“. |
| Koordinaten | eigener Parser und Krüger-Reihen 6. Ordnung (Karney 2011) für UTM↔WGS84 | proj4js, keine UTM-Eingabe | Kein zusätzliches Paket; Abweichung gegen pyproj < 1 mm (Test mit 10 Prüfpunkten). Gauß-Krüger wird bewusst **abgelehnt** statt genähert (Datumsübergang DHDN→ETRS89 fehlt, bis ca. 100 m Fehler). |
| Online-Suche | nur auf ausdrückliche Aktion (eigene Listenzeile), gedrosselt (1 Anfrage/s), auf das Gebiet begrenzt, Ergebnis gekennzeichnet, abschaltbar | Autocomplete gegen Nominatim, eigener Geocoder-Proxy | Nominatim-Nutzungsregeln verbieten Autocomplete-Last; außerdem soll kein Suchtext unbemerkt das Gerät verlassen. |
| Rettungspunkte | eigene Datei mit eigenem Aktualisierungszyklus (`tools/build-rettungspunkte.py`), Attribute unverändert, Warnung nach 7 Monaten | in den Suchindex mischen | Andere Lizenz (CC BY-ND statt dl-de/zero), andere Herkunft und anderer Zyklus; die Pflicht, veraltete Stände zu ersetzen, lässt sich so sauber prüfen. |
| Nummern auf der Karte | permanente Leaflet-Tooltips ab Zoom 14; Nummern, die andere Beschriftungen überdecken würden, werden ausgeblendet (`obstacleSelector`) | Clustering, Nummern erst im Popup | Die Nummer ist die eigentliche Information (Meldung an die Leitstelle). Die Entzerrung der App (`declutterLabels`) verschiebt Label per `transform`; bei Leaflet-Tooltips ist `transform` die Position, deshalb hier Ausblenden statt Verschieben. |

**Schnittstellen**

- `Search.configure({indexUrl, rpUrl, online, areaBbox, demBbox, fetch, now, sleep})`, `Search.ensureLoaded()` → Promise,
  `Search.loadData(index, rp)` (synchron, für Tests), `Search.status()`.
- `Search.query(text, {limit})` → `[{typ: "kommune"|"ortsteil"|"strasse"|"adresse"|"rettungspunkt"|"koordinate"|"online"|"hinweis",
  label, sub, kommune, lat, lon, bbox?, hinweis?, quelle, score, …}]`, `bbox` immer `[süd, west, nord, ost]` in Grad.
- `Search.parseCoordinate(text)` → `{lat, lon, format, utm, imGebiet, imDgm, warnungen[]}` | `{fehler}` | `null`.
- `Search.online(text)` → Promise (Nominatim, gereiht und gedrosselt, Cache je Anfrage).
- `Search.rettungspunkte()`, `Search.rpInfo()` (Version, Stand, Alter, Warnung, Quellenvermerk als Text und HTML),
  `Search.utmToWgs84(e, n, zone)`, `Search.wgs84ToUtm(lat, lon, zone)`.
- `SearchUI.init({map, onSelect(hit), onIgnition(lat, lon, hit), limit, searchConfig})` → `{run, select, close, resultLayer, current, items}`;
  `SearchUI.rettungspunkteLayer(map, {minZoom, labelZoom, onWarn, obstacleSelector})` → `L.LayerGroup`.
- Verdrahtung in `js/app.js`: `onIgnition` legt die Kreisfläche wie der Modus „Zündpunkt + Radius“ an (`setIgnitionPoint`),
  jede Auswahl wird protokolliert (`Protocol.add("suche", …)`), die DGM-Ausdehnung wird nach dem Laden an die Suche gegeben,
  die Rettungspunkt-Ebene hängt im Ebenen-Menü von Leaflet.

**Datenfluss Suche**: Eingabe → (Koordinatenparser; wenn Koordinate: fertig) → Rettungspunkt-Nummern → Zerlegung in Name,
Hausnummer und Kontext (mehrere Lesarten) → Bewertung gegen Kommunen, Ortslagen, Straßen/Adressen → Sortierung → Trefferliste →
Auswahl → Karte (Marker oder Rechteck) + Ergebniskarte mit Quelle → optional „Als Zündpunkt setzen“ → Brandfläche + Protokoll.

**Laufzeit** (Node, gesamter Index): unter 100 ms je Anfrage (Test), typisch 5–20 ms. Index laden und aufbereiten im Browser
ca. 0,3–0,6 s (einmalig, beim ersten Fokus); die Eingabe ist mit 120 ms entprellt.

## Wasserversorgung (0.6.0)

Simulation mit Annahmen, keine Einsatzplanung. Rechenkern `js/water.js` (DOM-frei, deterministisch), Oberfläche
`js/water-ui.js`, Parameter `js/water-params.js` (`PARAMS.wasser`), Stile `css/water.css`.

**Entwurfsentscheidungen**

| Thema | Gewählt | Alternativen | Begründung |
|---|---|---|---|
| Parameter | eigene Datei `js/water-params.js`, hängt `PARAMS.wasser` ein, wenn `PARAMS` existiert | Block in `js/params.js` | Das Modul wurde parallel zur Ortssuche entwickelt; eine eigene Datei vermeidet Konflikte in `js/params.js` und hält die ca. 140 Zeilen Wasserparameter samt Herkunftskennzeichen [A]/[F]/[P]/[V]/[App] zusammen. `PARAMS.wasser` ist trotzdem überall verfügbar. |
| Zeitmodell | eigene zeitdiskrete Simulation, 1 min, 6 h, deterministisch (keine Zufallszahlen, feste Sortierreihenfolgen) | ereignisdiskrete Simulation, analytische Umlaufrechnung | Warteschlangen an Entnahmestelle und Becken, Beckenfüllstand und Animation brauchen einen Zeitverlauf. 361 Schritte × wenige Dutzend Fahrzeuge rechnen in ca. 10–150 ms, damit ist Neurechnen beim Ziehen eines Beckens möglich. Determinismus ist durch Test abgesichert. |
| Wege | Luftlinie × Umwegfaktor (1,3 Fahrt, 1,2 Schlauch), Geschwindigkeit nach Wegtyp aus dem OSM-Raster | Routing (OSRM/Valhalla), Dijkstra auf dem `drivable`-Raster | Dieselbe Festlegung wie bei der Anfahrtsschätzung (kein Routing-Dienst im Prototyp). Das `drivable`-Raster liefert nur, **ob** ein Punkt an Straße oder Waldweg liegt (Abstand zur nächsten Straße bestimmt den langsamen Anteil). Ein Routing wäre Phase 2 und würde das Modell nicht ändern, nur die Fahrzeiten. |
| Wegenetz | `Water.roadNet(null, {points})` aus den befahrbaren Zellen des bestehenden OSM-Rasters (1 = Straße, 2 = Wald-/Wirtschaftsweg), Nachbarschaftssuche über ein 200-m-Gitter | eigene Overpass-Abfrage für Wege | Die App hat die Daten bereits; eine zweite Abfrage wäre doppelte Last und könnte abweichen. Typisch einige hundert bis wenige tausend Punkte (Test: 860). |
| Becken | Dimensionierung aus dem Bedarf je Abnehmergruppe, Standortwahl per Bewertung (Abstand zum Zielpunkt hinter den Abnehmern, Wegtyp, Sicherheitsabstand zur „möglich“-Zone) | feste Zahl, nur manuell | Die automatische Planung soll einen Startpunkt liefern, den die Einsatzleitung verschiebt. Becken, die die Regel erzeugt, denen aber kein Abnehmer zugeordnet ist, werden als **Reservestandort** gekennzeichnet und nicht eingeplant (sonst würden sie stillschweigend Fahrzeuge binden). |
| Diagramme | Canvas, offscreen gezeichnet, bei Zeitänderung nur Cursor neu | SVG, Diagrammbibliothek | Keine zusätzliche Abhängigkeit; bei 60-facher Abspielgeschwindigkeit bleibt die Anzeige flüssig (nur der Cursor wird neu gesetzt). |
| Animation | Position linear zwischen den Minutenwerten interpoliert (`Water.vehicleAt`) | Zustand nur je Minute | Ruhigere Bewegung ohne zusätzliche Simulationsschritte. |
| Entzerrung der Beschriftung | Becken, Entnahmestellen, Abnehmer und Pumpen sind **feste Hindernisse** in `declutterLabels()`; die Fahrzeugmarker (`.wveh`) bleiben ausgenommen | alle Wassermarker mitentzerren | Die Wasserfahrzeuge bewegen sich im Zeitverlauf; eine Entzerrung je Frame wäre teuer und würde flackern. `declutterLabels` verschiebt per `style.transform` – bei Leaflet-Tooltips ist `transform` die Position (Falle, siehe Suche). |
| Doppelte Entnahmestellen-Ebene | Beim Öffnen des Reiters wird die Modul-Ebene ein- und die App-Ebene „Wasserentnahmestellen“ ausgeschaltet, beim Verlassen zurück | beide gleichzeitig, eine ganz entfernen | Es sind dieselben Punkte in zwei Darstellungen. Die App-Ebene trägt das Bearbeiten/Verifizieren und bleibt deshalb erhalten; die Modul-Ebene zeigt Typ, Ergiebigkeit und „ungeprüft“. |

**Nicht übernommen (bewusst):** Die eigenständige Entwurfsdemo des Moduls (`demo.html`, `js/water-demo.js`) und die
beiden Smoke-Skripte liegen **nicht** im Repository. Gründe: Die Demo arbeitet mit einem **frei erfundenen** Szenario
(Abnehmer, Entnahmestellen, Anfahrtszeiten) – auf GitHub Pages veröffentlicht könnte das für eine echte Lage gehalten
werden; sie bräuchte zusätzlich eigene Kopien von Leaflet, DGM und `js/dem.js` oder angepasste Pfade; und `js/app.js`
enthält mit `waterInput()` denselben Ablauf mit echten Daten. Der Loader-Test (`tests/model.test.mjs`) verlangt
ohnehin für **jede** Datei in `js/` einen Eintrag in `window.WB_JS` – `js/water-demo.js` dürfte dort nicht liegen.
Die 20 Prüfungen aus `tests/e2e-wasser.mjs` sind, soweit sie sich auf die echte App übertragen lassen, in
`tests/e2e.mjs` aufgegangen (Abschnitt „Wasserversorgung“, 19 Prüfungen inklusive zweier Prüfungen ohne OSM-Daten und
einer unter dem GitHub-Pages-Unterpfad).

**Schnittstellen**

- `Water.planSupply(input)` → `plan`, `Water.simulate(plan)` → `sim`, `Water.run(input)` → `{plan, sim, iterations, log}`
  (Nachplanung bei Defizit: mehr Pendelfahrzeuge bzw. ein zusätzliches Becken, höchstens 6 Durchläufe, nur Verbesserungen).
- `input = {W: PARAMS.wasser, consumers[{id, label, lat, lon, readyMin, tankL, kind, mode?, demandLpm?}],
  sources[Punktformat der App], vehicles[{…, anfahrtMin, originLat, originLon}], exclude{pflichtIds, grundschutzIds,
  assignedIds, ids}, basins: null | [{id, lat, lon}], roads: Water.roadNet(…) | null, terrain: {elevation(lat, lon)} | null,
  hazard: {center, possibleMinAt(lat, lon)} | null}`.
- `plan`: `basins[{id, lat, lon, manual, reserve, demandLpm, consumerIds, supply{kind, sourceId, hose}, safety, siteNote}]`,
  `sources` (eingestuft, `capLpm`, `capWhy`, `annahmen[]`, `verified`), `vehicles[{id, role: pendel|pumpe|verstaerker|reserve, …}]`,
  `excluded[{id, label, reason}]`, `notes[]`, `warnings[]`.
- `sim`: je Becken Zeitreihen (`level`, `inflow`, `inflowHose`, `outflow`), je Fahrzeug `state`/`lat`/`lon`/`load`,
  je Entnahmestelle Auslastung, Füllungen, Wartezeit, Restvolumen; `kpi` (Bedarf, Lieferung, Defizit, Deckung, Warteanteile),
  `diagnosis[{level, text}]`, `bottleneck`.
- `Water.summary(plan, sim)` → zeitreihenfreie Zusammenfassung für Protokoll und Export.
- `WaterUI.create({map, L, W, panel})` → `{layers{sources, hoses, routes, basins, vehicles}, setInput, recompute, setTime,
  play, pause, setSpeed, setAddMode, addBasin, moveBasin, deleteBasin, redraw, fitBounds, on("recompute"), result, time}`.
- Verdrahtung in `js/app.js`: `waterInput()` baut die Eingabe aus `S.run`, `S.sug`, `S.vehicles`, `S.stations`, `S.dem` und
  `allWaterPoints()`; `updateWater()` läuft nach jeder Vorschlagsrechnung und nach jeder Änderung an den Entnahmestellen;
  `ensureWaterUI()` erzeugt die Oberfläche einmalig und hängt die Ebenen in den Ebenenschalter; `onWaterTab()` protokolliert
  beim ersten Öffnen die Annahmen und zeichnet neu. Beim Theme-Wechsel `waterUI.redraw()` (die Canvas-Diagramme lesen die
  CSS-Variablen).

**Datenfluss Wasser**: Vorschläge (Riegel/Auffanglinie/Flanke/Objektschutz mit `readyMin`) → Abnehmer mit Bedarf →
Gruppierung (400 m) → Becken dimensionieren und verorten (Wegenetz + „möglich“-Zone aus der Prognose) → Abnehmer dem
nächsten Becken zuordnen → je Becken Förderstrecke prüfen (Länge, Reibung, Höhe aus dem DGM, freie Pumpen) sonst
Pendelverkehr → Fahrzeuge auswählen (Ausschlüsse, Großtanker zuerst) → 1-min-Simulation mit Warteschlangen →
Kennzahlen, Engpassdiagnose, Nachplanung → Karte, Diagramme, Tabellen, Protokoll (`wasser_plan`), Export.

**Laufzeit** (gemessen im Browser-Test, Chromium in der Sandbox): Planung + Simulation für 13 Abnehmer, 10 Becken,
2 Entnahmestellen und 33 geeignete Fahrzeuge ca. 120 ms inklusive 6 Nachplanungen; Neurechnen beim Verschieben eines
Beckens ca. 15 ms. Unit-Test „Performance“: 20 Fahrzeuge, 8 Abnehmer, 6 h in 1-min-Schritten unter 200 ms.

## Laufzeit (gemessen im Test, Chromium in der Sandbox)

0.4.0 mit Geländewind (Node, 24 + 1 Läufe, 400 × 400 Zellen, hügeliges Gelände): 0,5–1,1 s (ohne Geländewind 0,13–0,42 s); Vorbereitung der Geländefelder ca. 70–90 ms je Raster. Im Browser-E2E ca. 0,7–0,8 s je Prognose.

Standardszenario (24 Läufe + Referenz, 400 × 400 Zellen, 6 h): unter 1 s bei langsamer Waldausbreitung. Bei schnellem Grasfeuer mit starkem Wind wächst die Rechenzeit mit der erreichten Fläche; Ziel < 30 s, auf Tablets **zu prüfen**.

Mit DGM (e2e-Test, hügeliges Gelände, Grünland, 24 + 1 Läufe): Rechenzeit weiterhin im Bereich von Sekunden; Höhenabfrage für 160.000 Zellen und Horn-Neigung zusätzlich deutlich unter 1 s. Die Offline-Schummerung (790 × 856 Pixel) wird beim ersten Einschalten einmal berechnet.
