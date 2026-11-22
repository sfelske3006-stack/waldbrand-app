/*
 * UI-Steuerung: Karte, Zeichnen, Wetter, OSM, Prognose, Vorschläge, Protokoll.
 * Fachlogik liegt in model.js / suggest.js (UI-unabhängig).
 */
(function () {
  "use strict";
  const P = window.PARAMS;
  const CFG = window.APP_CONFIG || {};
  const ARTIFACT = !!window.__ARTIFACT_MODE;
  const $ = (id) => document.getElementById(id);
  const CLASS_LIST = Object.keys(P.fuelClasses);
  const HZ_COLORS = [[122, 10, 10], [192, 40, 28], [227, 116, 27], [232, 185, 35]];
  const CENTER = [50.858, 7.335]; // Annahme: grober Mittelpunkt Neunkirchen-Seelscheid (nur Kartenstart)
  // Cache-Busting: eigene Datendateien mit ?v=<Version> laden (index.html definiert WB_ASSET); Pfade relativ
  const asset = (p) => (typeof window.WB_ASSET === "function" ? window.WB_ASSET(p) : p);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* nicht verfügbar */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (t) => new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtHour = (t) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const fmtNum = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : Number(v).toLocaleString("de-DE", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const compass = (deg) => deg === null ? "–" : ["N", "NO", "O", "SO", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  const msg = (cls, html) => `<div class="msg ${cls}">${html}</div>`;

  const S = {
    poly: store.get("wb_poly", null), tmpPts: [], mode: null,
    wx: store.get("wb_wx", null), overrides: store.get("wb_overrides", {}),
    osm: null, osmApplied: null,
    vehicles: [], stations: [], vehMeta: null,
    run: null, runB: null, mapShows: "A",
    sug: null, sugState: { locked: new Map(), excluded: new Set() }, sugCtx: null,
    manualWater: store.get("wb_water_manual", []), waterEdits: store.get("wb_water_edits", {}),
    tileErrors: 0,
    dem: null, demError: null, demPromise: null, shadeBuilt: false,
    tw: Object.assign({ wind: P.terrain.wind.enabled, moisture: P.terrain.moisture.enabled }, store.get("wb_tw", {})),
    twLayer: store.get("wb_twlayer", false), twHour: 0,
    maxAnf: store.get("wb_maxanf", P.anfahrt.maxAnfahrtMin),
    gsOverride: store.get("wb_gs_override", {}),
    teilMode: store.get("wb_teil", "auto"), grenzen: null,
    vf: Object.assign({ kommune: "", typ: "", sort: "anfahrt", onlyAvail: false }, store.get("wb_vf", {})),
  };

  // ---------------------------------------------------------------- Texte
  const LIMITS_HTML = `<ul>
    <li><b>Kein Funkenflug (Spotting)</b>: Sprünge über Wege, Straßen und Gewässer werden nicht berechnet. Barrieren stoppen das Feuer im Modell vollständig. Das ist optimistisch.</li>
    <li><b>Geländewind nur vereinfacht</b> (Schalter „Geländewind“): Windstärke je Zelle mit Faktor 0,5–1,4 aus Abschattung (Winstral-Sx), Kuppen-/Muldenlage (TPI) und Luv-/Leehang; in ausgeprägten Tälern teilweise Drehung zur Talachse; schwacher thermischer Hangwind (tags hangaufwärts, nachts hangabwärts) nur bei schwachem Wind; Südhänge tagsüber etwas trockener, Nordhänge feuchter. Das ist <b>kein Strömungsmodell</b>: kein massenkonsistentes Windfeld (WindNinja o. ä. wäre eine Option für Phase 3), keine Wirbel und Leewalzen, keine feuerinduzierten Winde, keine Inversionen und Kaltluftseen, keine Windsprünge/Böen.</li>
    <li><b>Föhn wird nicht modelliert.</b> Echter Föhn (Fallwind nach Überströmen eines Gebirges mit Erwärmung und Austrocknung) ist im Bergischen Land/Rhein-Sieg-Kreis nicht relevant; föhnartige Effekte am Mittelgebirgsrand sind möglich, aber nicht abgebildet.</li>
    <li><b>Keine Brandbekämpfungswirkung</b>: Löschmaßnahmen verändern die Prognose nicht.</li>
    <li><b>Kein Kronenfeuer, keine Übergänge Boden-/Kronenfeuer</b>, kein Rauch.</li>
    <li><b>Hangneigung nur vereinfacht</b>: Mit geladenem Geländemodell (DGM1 NRW, auf 25 m gemittelt) erhält die Ausbreitung bergauf einen Zuschlag nach Rothermel; Wind und Hang werden nur addiert, nicht als Vektoren kombiniert; bergab keine Verlangsamung; Hang- und Talwinde nur über den vereinfachten Geländewind. Ohne DGM wird die Hangneigung nicht berücksichtigt (Warnung im Ergebnis).</li>
    <li><b>Brennstoffkarte</b> aus OpenStreetMap kann veraltet, unvollständig oder falsch sein. Die Zuordnung zu nordamerikanischen Brennstoffmodellen (Anderson 13) ist eine Annahme und nicht mit Forst/Feuerwehr abgestimmt.</li>
    <li><b>Wetterdaten</b> sind Modell- oder Stationswerte, keine Messung am Brandort.</li>
    <li><b>Vereinfachtes Rothermel-Modell</b> (ohne Größenklassen-Gewichtung), Ellipsenform nach Anderson (1983), Rasterrechnung (25 m). Tote-Brennstoff-Feuchte aus einem einfachen Ansatz (Gleichgewichtsfeuchte + Regenzuschlag). Das Modell ist unvalidiert.</li>
    <li><b>Vorschläge</b> berücksichtigen keine echten Fahrzeiten: Die Anfahrt wird aus der Luftlinie Wache–Einsatzstelle × Umwegfaktor ÷ Durchschnittsgeschwindigkeit + Ausrückzeit <b>geschätzt (kein Routing)</b>; Fahrzeuge ohne Wachenkoordinate werden nicht eingeplant. Keine Rückzugswege und keine feuerwehrinternen Sicherheitsregeln. Riegel werden nur vorgeschlagen, wenn sie bei Einsatzbereitschaft außerhalb der „möglich“-Zone liegen; sonst erscheint „Keine geeignete Riegelstellung gefunden“.</li>
  </ul>`;
  const SOURCES_HTML = `<ul>
    <li><b>Luftbild</b>: Geobasis NRW, WMS <code>wms_nw_dop</code>, Layer <code>nw_dop_rgb</code>; Lizenz laut GetCapabilities: Datenlizenz Deutschland – Zero 2.0 (geprüft 21.11.2026).</li>
    <li><b>Topografie</b>: Geobasis NRW, WMS <code>wms_nw_dtk</code>, Layer <code>nw_dtk_col</code> (geprüft 21.11.2026). Laut GetCapabilities gelten für P10 (Maßstab 1:4.100–11.000), DTK250 und DTK500 die Bedingungen des BKG: © GeoBasis-DE / BKG, dl-de/by-2-0 (Namensnennung). Für DTK25–100/ABK/ALKIS verweist der Dienst auf die Lizenzbedingungen von Geobasis NRW (zu prüfen).</li>
    <li><b>Geländemodell</b>: DGM1 NRW (Rasterweite 1 m) von opengeodata.nrw.de, mit <code>tools/build-dgm.py</code> auf ca. 25 m gemittelt (Datei <code>data/dgm25.bin</code>, offline). Geobasis NRW, dl-de/zero-2-0 (Lizenzangabe aus Katalog-Metadaten und WMS-GetCapabilities; im Download-Verzeichnis keine Lizenzdatei). Schummerung online: WMS <code>wms_nw_dgm-schummerung</code>, Layer <code>nw_dgm-schummerung_pan</code>.</li>
    <li><b>OpenStreetMap</b> (Karte, Brennstoff, Wege, Gewässer, Hydranten): © OpenStreetMap-Mitwirkende, ODbL 1.0. Abruf über Overpass API; im Betrieb eigene Instanz verwenden (zu prüfen).</li>
    <li><b>Wetter</b>: Open-Meteo (Modellwerte, Quelle u. a. DWD ICON), Attribution CC BY 4.0; Nutzungsbedingungen für den Einsatz zu prüfen. DWD Open Data: nicht angebunden.</li>
    <li><b>Fahrzeuge/Wachen</b>: Neunkirchen-Seelscheid aus ffnkse.de; übrige Kommunen des Rhein-Sieg-Kreises aus Websuche (Feuerwehr-/Kommunalseiten, bos-fahrzeuge.info, Presse). <b>Ungeprüft, aus Websuche</b> (Originalseiten in der Erstellungsumgebung nicht abrufbar); Quellentyp je Fahrzeug in der Liste; Tankvolumen überwiegend Normwerte (gekennzeichnet). Wachenkoordinaten aus GEOBASIS.NRW-Gebäudereferenzen (dl-de/zero-2-0).</li>
    <li><b>Gemeindeteile</b>: Gemarkungen aus ALKIS (Geobasis NRW, dl-de/zero-2-0). Eine Gemarkung „Neunkirchen“ gibt es nicht; die Zuordnung der Gemarkungen Eischeid, Herkenrath, Söntgerath zu den Gemeindeteilen ist eine Annahme (näheres Gerätehaus), Wolperath abgeleitet (Gerätehaus Neunkirchen liegt darin). Bereitschaftszeiten 25/40 min: Vorgabe Auftraggeber (22.11.2026).</li>
    <li><b>Google Maps</b>: nur Anzeige, wenn ein API-Key in config.js eingetragen ist. Keine Auswertung der Google-Bilder.</li>
    <li><b>Modell</b>: Rothermel (1972) INT-115; Albini (1976) INT-30; Anderson (1982) INT-122; Anderson (1983) INT-305. Gleichungen aus der Literatur übertragen, Abgleich mit Primärquelle offen.</li>
    <li><b>Geländewind</b>: Abschattungsmaß Sx nach Winstral, Elder &amp; Davis (2002); Luv-/Leehang angelehnt an MicroMet (Liston &amp; Elder 2006); Sonnenstand nach den NOAA-Formeln „General Solar Position Calculations“. Gewichte, Grenzen, Hangwind- und Feuchtewerte sind eigene Annahmen (zu prüfen).</li>
  </ul>`;

  // ---------------------------------------------------------------- Karte
  const map = L.map("map", { zoomControl: false, tap: true }).setView(S.poly ? centroid(S.poly) : CENTER, 14);
  const baseLayers = {};
  // URLs/Layer per GetCapabilities geprüft (21.11.2026): nw_dop_rgb, nw_dtk_col, nw_dgm-schummerung_pan; EPSG:3857 unterstützt.
  const linkNRW = '<a href="https://www.bezreg-koeln.nrw.de/geobasis-nrw" target="_blank" rel="noopener">Geobasis NRW</a>';
  const attrNRW = `Luftbild: ${linkNRW} (dl-de/zero-2-0)`;
  const attrDTK = `Topo: ${linkNRW}; P10/DTK250/DTK500: © GeoBasis-DE / BKG (${new Date().getFullYear()}) dl-de/by-2-0`;
  baseLayers["Luftbild NRW (DOP)"] = L.tileLayer.wms("https://www.wms.nrw.de/geobasis/wms_nw_dop", {
    layers: "nw_dop_rgb", format: "image/jpeg", maxZoom: 20, attribution: attrNRW,
  });
  baseLayers["Topografie NRW (DTK)"] = L.tileLayer.wms("https://www.wms.nrw.de/geobasis/wms_nw_dtk", {
    layers: "nw_dtk_col", format: "image/png", maxZoom: 20, attribution: attrDTK,
  });
  baseLayers["OpenStreetMap"] = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
  });
  baseLayers["Ohne Hintergrund"] = L.layerGroup();
  for (const [name, layer] of Object.entries(baseLayers)) {
    if (layer.on) layer.on("tileerror", () => { S.tileErrors++; updateHeader(); });
    if (layer.on) layer.on("tileload", () => { if (S.tileErrors) { S.tileErrors = 0; updateHeader(); } });
  }
  baseLayers["Luftbild NRW (DOP)"].addTo(map);
  const layerCtl = L.control.layers(baseLayers, {}, { collapsed: true, position: "topright" }).addTo(map);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
  setupGoogle();

  async function setupGoogle() {
    const key = (CFG.googleMapsApiKey || "").trim();
    if (!key) return; // Ohne Key kein Umschalter
    try {
      // Google Map Tiles API (2D). Zu prüfen: Nutzungsbedingungen, Attributionsanzeige (viewport-Info).
      const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapType: "satellite", language: "de-DE", region: "DE" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const gl = L.tileLayer(`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${j.session}&key=${encodeURIComponent(key)}`, {
        maxZoom: 21, attribution: "Kartendaten © Google (nur Anzeige, keine Auswertung)",
      });
      layerCtl.addBaseLayer(gl, "Google Luftbild (nur Anzeige)");
    } catch (e) {
      $("hdr-status").textContent = `Google-Karte nicht verfügbar (${e.message}).`;
    }
  }

  const polyLayer = L.layerGroup().addTo(map);
  const drawLayer = L.layerGroup().addTo(map);
  const overlayLayer = L.layerGroup().addTo(map);
  const fuelLayer = L.layerGroup();
  const sugLayer = L.layerGroup().addTo(map);
  const waterLayer = L.layerGroup().addTo(map);
  const stationLayer = L.layerGroup().addTo(map);
  const gpsLayer = L.layerGroup().addTo(map);
  layerCtl.addOverlay(overlayLayer, "Prognose");
  layerCtl.addOverlay(sugLayer, "Vorschläge");
  layerCtl.addOverlay(waterLayer, "Wasserentnahmestellen");
  layerCtl.addOverlay(fuelLayer, "Brennstoffkarte");
  layerCtl.addOverlay(stationLayer, "Wachen");
  // Geländewind-Pfeile in eigener Ebene über der Prognose
  map.createPane("twind");
  map.getPane("twind").style.zIndex = 450;
  map.getPane("twind").classList.add("leaflet-twind-pane");
  const twindLayer = L.layerGroup();
  layerCtl.addOverlay(twindLayer, "Geländewind");

  // Schummerung: eigene Ebene unter den Prognose-Overlays
  map.createPane("hillshade");
  map.getPane("hillshade").style.zIndex = 350;
  map.getPane("hillshade").style.pointerEvents = "none";
  const shadeLayer = L.layerGroup();
  const shadeWms = L.tileLayer.wms("https://www.wms.nrw.de/geobasis/wms_nw_dgm-schummerung", {
    layers: "nw_dgm-schummerung_pan", format: "image/png", transparent: true, opacity: 0.45, maxZoom: 20, pane: "hillshade",
    attribution: `Schummerung: ${linkNRW} (dl-de/zero-2-0)`,
  });
  layerCtl.addOverlay(shadeWms, "Schummerung NRW (WMS, online)");

  function centroid(pts) {
    const n = pts.length;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }

  // ---------------------------------------------------------------- Zeichnen
  const vxIcon = () => L.divIcon({ className: "", html: '<div class="vx-marker"></div>', iconSize: [34, 34], iconAnchor: [17, 17] });

  function setMode(m) {
    S.mode = m;
    $("btn-draw").classList.toggle("active", m === "poly");
    $("btn-point").classList.toggle("active", m === "point");
    $("btn-addwater").classList.toggle("active", m === "water");
    $("btn-undo").hidden = m !== "poly";
    $("btn-finish").hidden = m !== "poly";
    const hint = $("map-hint");
    const texts = {
      poly: "Eckpunkte der Brandfläche nacheinander antippen. Punkte lassen sich verschieben. Mindestens 3 Punkte, dann „Fläche fertig“.",
      point: "Zündpunkt auf der Karte antippen. Radius im Bedienfeld wählen.",
      water: "Position der Entnahmestelle antippen.",
    };
    hint.hidden = !m;
    hint.textContent = texts[m] || "";
    map.getContainer().style.cursor = m ? "crosshair" : "";
  }

  function drawTmp() {
    drawLayer.clearLayers();
    if (!S.tmpPts.length) return;
    L.polygon(S.tmpPts, { color: "#ff3b30", weight: 3, dashArray: "6 6", fillOpacity: 0.15 }).addTo(drawLayer);
    S.tmpPts.forEach((p, k) => {
      const m = L.marker(p, { icon: vxIcon(), draggable: true, keyboard: false }).addTo(drawLayer);
      m.on("drag", (e) => { S.tmpPts[k] = [e.latlng.lat, e.latlng.lng]; drawLayer.eachLayer((l) => { if (l instanceof L.Polygon) l.setLatLngs(S.tmpPts); }); });
    });
  }

  function drawPoly() {
    polyLayer.clearLayers();
    if (!S.poly) { $("poly-status").textContent = "Noch keine Fläche. „Brandfläche zeichnen“ und Punkte auf der Karte antippen."; return; }
    L.polygon(S.poly, { color: "#ff1a0d", weight: 4, fillColor: "#ff1a0d", fillOpacity: 0.35 }).addTo(polyLayer);
    S.poly.forEach((p, k) => {
      const m = L.marker(p, { icon: vxIcon(), draggable: true, keyboard: false, opacity: 0.85 }).addTo(polyLayer);
      m.on("dragend", (e) => {
        S.poly[k] = [e.latlng.lat, e.latlng.lng];
        savePoly("Brandfläche bearbeitet (Punkt verschoben)");
      });
    });
    const areaHa = polyAreaHa(S.poly);
    $("poly-status").innerHTML = `Brandfläche mit ${S.poly.length} Punkten, ca. <b>${fmtNum(areaHa, 2)} ha</b>. Punkte auf der Karte verschiebbar. Automatisch gespeichert.`;
  }

  function polyAreaHa(pts) {
    const pr = Grid.makeProjection(...centroid(pts));
    const xy = pts.map((p) => pr.toXY(p[0], p[1]));
    let a = 0;
    for (let i = 0; i < xy.length; i++) { const j = (i + 1) % xy.length; a += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1]; }
    return Math.abs(a / 2) / 1e4;
  }

  function savePoly(logText) {
    store.set("wb_poly", S.poly);
    drawPoly();
    Protocol.add("brandflaeche", { text: logText, polygon: S.poly });
    refreshProtocol();
  }

  map.on("click", (e) => {
    const p = [e.latlng.lat, e.latlng.lng];
    if (S.mode === "poly") { S.tmpPts.push(p); drawTmp(); }
    else if (S.mode === "point") {
      const r = Number($("sel-radius").value);
      const pr = Grid.makeProjection(p[0], p[1]);
      S.poly = Array.from({ length: 24 }, (_, k) => pr.toLatLng(Math.sin((k / 24) * 2 * Math.PI) * r, Math.cos((k / 24) * 2 * Math.PI) * r));
      setMode(null);
      savePoly(`Zündpunkt mit Radius ${r} m gesetzt`);
    } else if (S.mode === "water") {
      const w = { id: `manuell/${Date.now()}`, lat: p[0], lon: p[1], kind: "manuell erfasst", source: "manuell", verified: true };
      S.manualWater.push(w);
      store.set("wb_water_manual", S.manualWater);
      Protocol.add("entnahmestelle", { aktion: "hinzugefügt", ...w });
      setMode(null);
      renderWater(); refreshProtocol();
    }
  });

  $("btn-draw").onclick = () => { if (S.mode === "poly") { setMode(null); S.tmpPts = []; drawTmp(); return; } S.tmpPts = []; drawTmp(); setMode("poly"); };
  $("btn-point").onclick = () => setMode(S.mode === "point" ? null : "point");
  $("btn-addwater").onclick = () => setMode(S.mode === "water" ? null : "water");
  $("btn-undo").onclick = () => { S.tmpPts.pop(); drawTmp(); };
  $("btn-finish").onclick = () => {
    if (S.tmpPts.length < 3) { $("map-hint").textContent = "Mindestens 3 Punkte setzen."; return; }
    S.poly = S.tmpPts.slice(); S.tmpPts = []; drawTmp(); setMode(null);
    savePoly("Brandfläche gezeichnet");
  };
  $("btn-clear").onclick = () => {
    S.poly = null; S.tmpPts = []; drawTmp(); store.del("wb_poly"); drawPoly();
    overlayLayer.clearLayers(); sugLayer.clearLayers();
    Protocol.add("brandflaeche", { text: "Brandfläche gelöscht" }); refreshProtocol();
  };
  $("btn-gps").onclick = () => {
    if (!navigator.geolocation) { $("hdr-status").textContent = "Standortbestimmung wird von diesem Gerät nicht unterstützt."; return; }
    // Standort nur nach Einwilligung (Browser-Abfrage), nur lokal verwendet.
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      gpsLayer.clearLayers();
      L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="gps-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(gpsLayer)
        .bindTooltip(`Mein Standort (±${Math.round(pos.coords.accuracy)} m)`, { permanent: false });
      map.setView(ll, 16);
    }, (err) => { $("hdr-status").textContent = `Standort nicht verfügbar: ${err.message}`; }, { enableHighAccuracy: true, timeout: 15000 });
  };

  // ---------------------------------------------------------------- Wetter
  function wxLocation() {
    if (S.poly) return centroid(S.poly);
    const c = map.getCenter(); return [c.lat, c.lng];
  }
  $("btn-wx").onclick = async () => {
    const [lat, lon] = wxLocation();
    $("wx-status").innerHTML = msg("", "Lade Wetter von Open-Meteo …");
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
      S.wx = await Weather.fetchOpenMeteo(lat, lon, CFG.openMeteoUrl, ctl.signal);
      clearTimeout(to);
      store.set("wb_wx", S.wx);
      Protocol.add("wetter", { quelle: S.wx.source, abgerufen: new Date(S.wx.fetchedAt).toISOString(), lat: S.wx.lat, lon: S.wx.lon });
    } catch (e) {
      const cached = store.get("wb_wx", null);
      $("wx-status").innerHTML = msg("err", `Wetter konnte nicht geladen werden (${esc(e.name === "AbortError" ? "Zeitüberschreitung" : e.message)}). ${cached ? "Zuletzt geladene Daten werden weiter verwendet (Alter beachten)." : "Bitte Werte manuell eingeben oder Beispieldaten verwenden."}`);
      Protocol.add("wetter", { fehler: String(e.message || e) });
      refreshProtocol(); renderWx(true); return;
    }
    refreshProtocol(); renderWx();
  };
  $("btn-wx-sample").onclick = () => {
    S.wx = Weather.sampleWeather(Date.now());
    store.set("wb_wx", S.wx);
    Protocol.add("wetter", { quelle: S.wx.source, hinweis: "Beispieldaten aktiviert" });
    refreshProtocol(); renderWx();
  };
  const OV_KEYS = ["windKmh", "windDirDeg", "gustKmh", "tempC", "rh", "rain24", "rain72"];
  for (const k of OV_KEYS) {
    const el = $(`ov-${k}`);
    if (S.overrides[k] !== undefined && S.overrides[k] !== null) el.value = S.overrides[k];
    el.addEventListener("change", () => {
      const v = el.value.trim();
      if (v === "") delete S.overrides[k]; else S.overrides[k] = Number(v);
      store.set("wb_overrides", S.overrides);
      Protocol.add("wetter_ueberschreibung", { feld: k, wert: v === "" ? null : Number(v) });
      refreshProtocol(); renderWx();
    });
  }
  $("btn-ov-clear").onclick = () => {
    S.overrides = {}; store.set("wb_overrides", S.overrides);
    for (const k of OV_KEYS) $(`ov-${k}`).value = "";
    Protocol.add("wetter_ueberschreibung", { text: "alle Überschreibungen gelöscht" }); refreshProtocol(); renderWx();
  };

  function renderWx(keepStatus) {
    const now = Date.now();
    const prep = Weather.prepareHours(S.wx, now, Math.max(...P.horizonsH), S.overrides);
    const parts = [];
    if (S.wx) {
      const age = Weather.ageHours(S.wx, now);
      const cls = S.wx.kind === "sample" ? "err" : age > P.weather.maxAgeH ? "err" : "ok";
      parts.push(msg(cls, `${S.wx.kind === "sample" ? '<b class="tag">Beispieldaten</b>' : '<b class="tag">aktiv</b>'}Quelle: <b>${esc(S.wx.source)}</b>, abgerufen ${fmtTime(S.wx.fetchedAt)} (vor ${fmtNum(age * 60, 0)} min).${age > P.weather.maxAgeH ? ` <br>WARNUNG: Wetterdaten älter als ${P.weather.maxAgeH} h.` : ""}`));
    } else parts.push(msg("warn", "Keine Wetterdaten. Laden, Beispieldaten wählen oder alle Werte manuell eingeben."));
    if (prep.missing.length) parts.push(msg("warn", `Für ${prep.missing.length} Stunde(n) fehlen Werte; nächstliegender Wert wird verwendet.`));
    const ov = Object.keys(S.overrides);
    if (ov.length) parts.push(msg("", `Manuell überschrieben: ${ov.map((k) => labelOf(k)).join(", ")}.`));
    if (!keepStatus) $("wx-status").innerHTML = parts.join("");
    else $("wx-status").innerHTML += parts.join("");
    const t = $("wx-table");
    const cell = (r, k, d) => `<td class="num${r.overridden.includes(k) ? " ov" : ""}">${fmtNum(r[k], d)}${r.overridden.includes(k) ? "*" : ""}</td>`;
    t.innerHTML = `<thead><tr><th>Zeit</th><th class="num">Wind km/h</th><th class="num">aus °</th><th class="num">Böen</th><th class="num">°C</th><th class="num">rF %</th><th class="num">Regen 24 h</th></tr></thead><tbody>` +
      prep.hours.map((r) => `<tr><td>${fmtHour(r.t)}</td>${cell(r, "windKmh", 0)}${cell(r, "windDirDeg", 0)}${cell(r, "gustKmh", 0)}${cell(r, "tempC", 1)}${cell(r, "rh", 0)}${cell(r, "rain24", 1)}</tr>`).join("") +
      `</tbody>` + (ov.length ? `<caption class="small muted" style="caption-side:bottom;text-align:left">* manuell überschrieben</caption>` : "");
    updateHeader();
  }
  function labelOf(k) {
    return { windKmh: "Wind", windDirDeg: "Windrichtung", gustKmh: "Böen", tempC: "Temperatur", rh: "rel. Feuchte", rain24: "Regen 24 h", rain72: "Regen 72 h" }[k] || k;
  }

  // ---------------------------------------------------------------- OSM
  const selFuel = $("sel-fuel");
  for (const k of CLASS_LIST) {
    const c = P.fuelClasses[k];
    if (!c.model) continue;
    const o = document.createElement("option");
    o.value = k; o.textContent = `${c.label} (${P.fuelModels[c.model].name})`;
    selFuel.appendChild(o);
  }
  selFuel.value = store.get("wb_fuel_fallback", "nadelwald");
  selFuel.onchange = () => { store.set("wb_fuel_fallback", selFuel.value); Protocol.add("brennstoff", { ersatzbrennstoff: selFuel.value }); refreshProtocol(); };

  function domainBounds() {
    if (!S.poly) return null;
    const [lat, lon] = centroid(S.poly);
    return Grid.makeGrid(lat, lon, P.grid.halfSizeM, P.grid.cellM, CLASS_LIST).bounds;
  }
  $("btn-osm").onclick = async () => {
    const b = domainBounds();
    if (!b) { $("osm-status").innerHTML = msg("err", "Zuerst die Brandfläche einzeichnen. Das Rechengebiet richtet sich nach ihr."); return; }
    $("osm-status").innerHTML = msg("", "Lade OSM-Daten (Overpass) für das Rechengebiet 10 × 10 km … das kann bis zu einer Minute dauern.");
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 100000);
      const json = await Osm.fetchOsm(b, CFG.overpassUrl, ctl.signal);
      clearTimeout(to);
      setOsm(json, b, "Overpass API");
    } catch (e) {
      $("osm-status").innerHTML = msg("err", `OSM-Daten nicht verfügbar (${esc(e.name === "AbortError" ? "Zeitüberschreitung" : e.message)}). Es wird mit dem Ersatz-Brennstoff ohne Barrieren gerechnet.`);
      Protocol.add("osm", { fehler: String(e.message || e) }); refreshProtocol();
    }
  };
  function setOsm(json, bounds, source) {
    S.osm = { json, bounds, source, loadedAt: Date.now(), timestamp: json.osm3s?.timestamp_osm_base || null };
    const n = (json.elements || []).length;
    $("osm-status").innerHTML = msg("ok", `<b class="tag">aktiv</b>OSM-Daten: ${n} Elemente (${esc(source)}), Datenstand ${esc(S.osm.timestamp || "unbekannt")}. Nicht verifiziert.`);
    Protocol.add("osm", { quelle: source, elemente: n, datenstand: S.osm.timestamp });
    refreshProtocol();
  }

  // ---------------------------------------------------------------- Geländemodell (DGM)
  function initDem() {
    if (window.__INLINE_DGM) {
      // Einzeldatei-Vorschau: DGM eingebettet (Base64)
      try { S.dem = Dem.fromBase64(window.__INLINE_DGM.meta, window.__INLINE_DGM.b64); } catch (e) { S.demError = String(e.message || e); }
      S.demPromise = Promise.resolve();
      afterDem();
      return;
    }
    S.demPromise = Dem.load(asset(P.dem.url)).then(({ dem, error }) => { S.dem = dem; S.demError = error; afterDem(); });
  }
  function afterDem() {
    const d = Dem.describe(S.dem);
    if (S.dem) {
      const st = S.dem.meta.stats || {};
      $("dem-status").innerHTML = msg("ok", `<b class="tag">aktiv</b>Geländemodell: <b>DGM1 NRW</b>, auf ca. 25 m gemittelt (offline). Stand ${esc(d.stand)}, abgerufen ${fmtTime(d.abgerufen)}. Höhen ${fmtNum(st.min_m, 0)}–${fmtNum(st.max_m, 0)} m. Quelle: ${esc(S.dem.meta.attribution)}. Hangneigung vereinfacht berücksichtigt.`);
      $("chk-shade").disabled = false;
      layerCtl.addOverlay(shadeLayer, "Schummerung DGM (offline)");
      Protocol.add("gelaende", { text: "Geländemodell geladen", ...d });
    } else {
      $("dem-status").innerHTML = msg("warn", `Kein Geländemodell (${esc(S.demError || "nicht geladen")}). <b>Hangneigung wird nicht berücksichtigt.</b> Erzeugen mit <code>tools/build-dgm.py</code>.`);
      Protocol.add("gelaende", { fehler: S.demError, hinweis: "Hangneigung nicht berücksichtigt" });
    }
    refreshProtocol();
  }
  function buildShade() {
    if (S.shadeBuilt || !S.dem) return;
    const hs = Dem.hillshadeRGBA(S.dem, P.dem.hillshade);
    const cv = document.createElement("canvas"); cv.width = hs.width; cv.height = hs.height;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(hs.width, hs.height); img.data.set(hs.rgba); ctx.putImageData(img, 0, 0);
    const m = S.dem.meta;
    // Reguläres lat/lon-Raster: lineare Streckung in Web Mercator, Lagefehler in der Mitte ca. 10 m
    L.imageOverlay(cv.toDataURL(), [[m.south, m.west], [m.north, m.east]], { pane: "hillshade", className: "wb-shade", interactive: false, opacity: 1, attribution: `Gelände: ${linkNRW} (DGM1, dl-de/zero-2-0)` }).addTo(shadeLayer);
    S.shadeBuilt = true;
  }
  function setShade(on) {
    if (on && S.dem) { buildShade(); if (!map.hasLayer(shadeLayer)) shadeLayer.addTo(map); }
    else if (map.hasLayer(shadeLayer)) map.removeLayer(shadeLayer);
    $("chk-shade").checked = !!(on && S.dem);
    store.set("wb_shade", !!on);
  }
  $("chk-shade").onchange = () => setShade($("chk-shade").checked);
  map.on("overlayadd", (e) => { if (e.layer === shadeLayer) setShade(true); });
  map.on("overlayremove", (e) => { if (e.layer === shadeLayer) setShade(false); });

  // ---------------------------------------------------------------- Prognose
  function buildInputs(scenario) {
    const errors = [], warnings = [];
    if (!S.poly || S.poly.length < 3) errors.push("Keine Brandfläche eingezeichnet.");
    const now = Date.now();
    const prep = Weather.prepareHours(S.wx, now, Math.max(...P.horizonsH), S.overrides);
    if (prep.incomplete) errors.push("Wetterdaten unvollständig: Wind, Windrichtung, Temperatur und rel. Feuchte werden benötigt (laden, Beispieldaten oder manuell eingeben).");
    if (errors.length) return { errors };
    let hours = prep.hours.map((r) => ({ ...r, rain24: r.rain24 ?? 0, rain72: r.rain72 ?? 0 }));
    if (scenario) {
      hours = hours.map((r) => {
        const o = { ...r };
        if (scenario.fixDir !== null) o.windDirDeg = scenario.fixDir;
        o.windDirDeg = (((o.windDirDeg + scenario.dDir) % 360) + 360) % 360;
        o.windKmh = o.windKmh * scenario.speed;
        o.rh = Math.max(1, Math.min(100, o.rh + scenario.drh));
        return o;
      });
    }
    if (S.wx?.kind === "sample") warnings.push("BEISPIELDATEN: Wetter ist fiktiv. Ergebnis nicht für den Einsatz verwenden.");
    const age = Weather.ageHours(S.wx, now);
    if (S.wx && age > P.weather.maxAgeH) warnings.push(`Wetterdaten sind ${fmtNum(age, 1)} h alt (Grenze ${P.weather.maxAgeH} h).`);
    if (!S.wx) warnings.push("Keine Wetterquelle: Rechnung nur mit manuell eingegebenen Werten.");
    if (prep.missing.length) warnings.push(`Für ${prep.missing.length} Stunde(n) fehlen Wetterwerte, nächstliegender Wert verwendet.`);
    const [lat, lon] = centroid(S.poly);
    const grid = Grid.makeGrid(lat, lon, P.grid.halfSizeM, P.grid.cellM, CLASS_LIST, S.dem);
    let osmApplied = null;
    if (S.osm) {
      osmApplied = Osm.applyOsm(grid, S.osm.json, P);
      const b = S.osm.bounds, gb = grid.bounds;
      if (gb.south < b.south - 1e-4 || gb.north > b.north + 1e-4 || gb.west < b.west - 1e-4 || gb.east > b.east + 1e-4) {
        warnings.push("OSM-Daten decken das Rechengebiet nur teilweise ab (Brandfläche verschoben). OSM-Daten neu laden.");
      }
    } else {
      grid.fuel.fill(CLASS_LIST.indexOf(selFuel.value));
      warnings.push(`Keine Brennstoffkarte: einheitlich „${P.fuelClasses[selFuel.value].label}“ angenommen, keine Barrieren, keine Objekte.`);
    }
    let terrain;
    if (!S.dem) {
      warnings.push(`Hangneigung nicht berücksichtigt (kein Geländemodell: ${S.demError || "nicht geladen"}).`);
      terrain = { hang: false, grund: S.demError || "kein DGM" };
    } else if (grid.elevMissing >= grid.nx * grid.ny) {
      delete grid.elev; delete grid.slope; delete grid.aspect;
      warnings.push("Hangneigung nicht berücksichtigt: Rechengebiet liegt außerhalb des DGM-Ausschnitts (Neunkirchen-Seelscheid + 5 km).");
      terrain = { hang: false, grund: "Rechengebiet außerhalb des DGM" };
    } else {
      if (grid.elevMissing) warnings.push(`Geländemodell deckt das Rechengebiet nur zu ${fmtNum(100 * (1 - grid.elevMissing / (grid.nx * grid.ny)), 0)} % ab; außerhalb ohne Hangneigung gerechnet.`);
      const ts = grid.terrainStats || {};
      terrain = { hang: true, ...Dem.describe(S.dem), max_tan_hang: P.dem.maxTanSlope, rechengebiet: { hoehe_min_m: +(ts.elevMin ?? 0).toFixed(1), hoehe_max_m: +(ts.elevMax ?? 0).toFixed(1), neigung_mittel_pct: +(100 * (ts.meanTan ?? 0)).toFixed(1), neigung_max_pct: +(100 * (ts.maxTan ?? 0)).toFixed(1), zellen_ohne_hoehe: grid.elevMissing } };
    }
    const ignition = Grid.polygonCells(grid, S.poly);
    // Geländewind (Schalter im UI): nur mit Höhenraster
    const tw = { wind: !!S.tw.wind, moisture: !!S.tw.moisture };
    let terrainWind;
    if (!grid.elev) terrainWind = { aktiv: false, grund: "kein Geländemodell", option: false };
    else if (!tw.wind && !tw.moisture) terrainWind = { aktiv: false, grund: "ausgeschaltet", option: false };
    else terrainWind = { aktiv: true, wind: tw.wind, feuchte: tw.moisture, option: tw };
    return { grid, ignition, hours, warnings, osmApplied, startTime: now, prep, terrain, terrainWind };
  }

  async function runForecast(scenario) {
    if (S.demPromise) await S.demPromise; // DGM-Ladevorgang abwarten (Datei lokal, kurz)
    const inp = buildInputs(scenario);
    const errBox = scenario ? $("sc-result") : $("run-errors");
    if (inp.errors) { errBox.innerHTML = inp.errors.map((e) => msg("err", esc(e))).join(""); return null; }
    errBox.innerHTML = "";
    const prog = $("run-progress");
    prog.hidden = false;
    const bar = prog.querySelector(".bar"), ptext = prog.querySelector(".ptext");
    const setP = (d, t) => { bar.style.width = `${Math.round((d / t) * 100)}%`; ptext.textContent = `${scenario ? "Szenario B: " : ""}Ensemble-Lauf ${d} von ${t}`; };
    setP(0, P.ensemble.runs);
    await new Promise((r) => setTimeout(r, 30));
    const result = await FireModel.runEnsemble({
      grid: inp.grid, classList: CLASS_LIST, ignition: inp.ignition, weatherHours: inp.hours, P, terrain: inp.terrainWind.option,
    }, async (d, t) => { setP(d, t); await new Promise((r) => setTimeout(r, 0)); });
    prog.hidden = true;
    const metrics = FireModel.metrics(result, inp.grid, inp.ignition, P);
    const reach = {};
    if (inp.osmApplied) {
      for (const [k, m] of Object.entries(inp.osmApplied.objects)) {
        reach[k] = { ref: FireModel.reachTime(m, result.reference, inp.grid), earliest: FireModel.reachTime(m, result.earliest, inp.grid) };
      }
    }
    const run = { ...inp, result, metrics, reach, scenario: scenario || null, finishedAt: Date.now() };
    Protocol.add(scenario ? "prognose_szenario_b" : "prognose", {
      modell: P.modelName, version: P.version, start: new Date(inp.startTime).toISOString(),
      wetterquelle: S.wx?.source || "manuell", wetter_abgerufen: S.wx ? new Date(S.wx.fetchedAt).toISOString() : null,
      ueberschrieben: S.overrides, szenario: scenario || null,
      eingang_stunden: inp.hours.map((h) => ({ t: new Date(h.t).toISOString(), wind: h.windKmh, dir: h.windDirDeg, temp: h.tempC, rh: h.rh, rain24: h.rain24 })),
      brennstoff: S.osm ? `OSM (${S.osm.timestamp || "Stand unbekannt"})` : `einheitlich ${selFuel.value}`,
      gelaende: inp.terrain,
      gelaendewind: twProto(result.terrainWind),
      parameter: { grid: P.grid, ensemble: P.ensemble, waf: P.waf, moisture: P.moisture, dem: { maxTanSlope: P.dem.maxTanSlope }, terrain: result.terrainWind?.active ? P.terrain : null },
      polygon: S.poly, warnungen: inp.warnings,
      ergebnis: { flaechen: metrics.perH, hauptrichtung: metrics.mainDirDeg, spitzenrate_m_min: metrics.peakRosMMin, erreichbarkeit: reach },
      rechenzeit_ms: result.durationMs,
    });
    refreshProtocol();
    return run;
  }

  function twProto(t) {
    if (!t || !t.active) return { aktiv: false, grund: t ? t.reason : "unbekannt" };
    return { aktiv: true, wind: t.wind, feuchte_exposition: t.moisture, staerke_ensemble: t.strengthRange, stunden_mit_hangwind: t.thermalHours, tageszeit_bekannt: t.timeKnown, stunden: t.hours };
  }
  function twText(run) {
    const t = run.result.terrainWind;
    if (!t || !t.active) return `<b>aus</b>${t && t.reason ? ` (${esc(t.reason)})` : ""} – einheitlicher Wind wie Version 0.3.0`;
    const parts = [];
    if (t.wind) parts.push("Windfeld aus DGM (Exposition/Abschattung, Talkanalisierung" + (t.thermalHours ? `, Hangwind in ${t.thermalHours} von ${t.hours.length} h` : ", kein Hangwind: Wind zu stark") + ")");
    if (t.moisture) parts.push("Feuchte nach Exposition");
    const sun = run.grid && run.hours[0] && Number.isFinite(run.hours[0].t) ? TerrainWind.sunTimes(run.hours[0].t, run.grid.proj.lat0, run.grid.proj.lon0) : null;
    return `<b>aktiv</b> – ${parts.join(", ")}; Stärke im Ensemble ×${t.strengthRange.map((v) => fmtNum(v, 1)).join("–")}${sun ? `; Sonnenaufgang/-untergang (berechnet) ${fmtHour(sun.sunrise)} / ${fmtHour(sun.sunset)}` : ""}. Vereinfachte Annahme, kein Strömungsmodell, kein Föhn.`;
  }

  $("btn-run").onclick = async () => {
    $("btn-run").disabled = true;
    try {
      const run = await runForecast(null);
      if (!run) return;
      S.run = run; S.runB = null; S.mapShows = "A"; $("sc-result").innerHTML = "";
      S.sugState = { locked: new Map(), excluded: new Set() };
      renderOverlay(run); renderResults(run);
      computeSuggestions(false);
      renderFuel();
      renderTwind();
      renderVehicles();
    } catch (e) {
      $("run-errors").innerHTML = msg("err", `Fehler bei der Berechnung: ${esc(e.message)}`);
      console.error(e);
    } finally { $("btn-run").disabled = false; updateHeader(); }
  };

  // ---------------------------------------------------------------- Darstellung Prognose
  // "kontur": Isochronen je Horizont (Marching Squares, Chaikin-Glättung) – Standard
  // "raster": 25-m-Zellen ungeglättet (Umrisse entlang der Zellränder) – für Fachleute
  S.display = store.get("wb_display", P.display.defaultMode) === "raster" ? "raster" : "kontur";
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  (function createPatterns() {
    // Schraffur als SVG-Pattern im Bildschirmmaß (gleich dicht bei jeder Zoomstufe)
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute"; svg.id = "wb-patterns";
    const defs = document.createElementNS(NS, "defs");
    HZ_COLORS.forEach((c, h) => {
      const pt = document.createElementNS(NS, "pattern");
      pt.setAttribute("id", `wb-hatch-${h}`); pt.setAttribute("patternUnits", "userSpaceOnUse");
      pt.setAttribute("width", "9"); pt.setAttribute("height", "9"); pt.setAttribute("patternTransform", "rotate(45)");
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("width", "3.5"); r.setAttribute("height", "9"); r.setAttribute("fill", rgb(c)); r.setAttribute("fill-opacity", "0.75");
      pt.appendChild(r); defs.appendChild(pt);
    });
    svg.appendChild(defs); document.body.appendChild(svg);
  })();

  function setDisplay(mode, rerender = true) {
    S.display = mode === "raster" ? "raster" : "kontur";
    store.set("wb_display", S.display);
    document.querySelectorAll(".lg-btn").forEach((b) => b.setAttribute("aria-checked", b.dataset.mode === S.display ? "true" : "false"));
    $("legend").dataset.mode = S.display;
    if (rerender) {
      const run = S.mapShows === "B" && S.runB ? S.runB : S.run;
      if (run) { renderOverlay(run, true); Protocol.add("anzeige", { darstellung: S.display }); refreshProtocol(); }
    }
  }
  document.querySelectorAll(".lg-btn").forEach((b) => b.addEventListener("click", () => setDisplay(b.dataset.mode)));

  function renderOverlay(run, keepView) {
    overlayLayer.clearLayers();
    const { grid: g, result } = run;
    const H = result.horizons;
    const pP = P.ensemble.possible;
    const ref = result.reference;
    const mode = S.display;
    const layers = Contour.displayLayers(g.nx, g.ny, result, P, { mode, ignition: run.ignition });
    const toLL = (r) => r.map(([x, y]) => g.proj.toLatLng(g.x0 + x * g.cell, g.y0 + y * g.cell));
    const ringsLL = (rings) => rings.map(toLL);
    const cls = mode === "raster" ? "wb-raster" : "wb-contour";
    const base = { interactive: false, smoothFactor: 0.3, fillRule: "evenodd" };
    // 1) Flächen als Bänder (Horizont h ohne Horizont h-1), damit sich Transparenzen nicht aufaddieren
    const band = (name, h) => [...layers[h][name].rings, ...(h > 0 ? layers[h - 1][name].rings : [])];
    for (let h = H.length - 1; h >= 0; h--) {
      const rr = band("likely", h);
      if (rr.length) L.polygon(ringsLL(rr), { ...base, stroke: false, fillColor: rgb(HZ_COLORS[h]), fillOpacity: 0.42, className: `${cls} wb-likely` }).addTo(overlayLayer);
    }
    for (let h = H.length - 1; h >= 0; h--) {
      const rr = band("possible", h);
      if (rr.length) L.polygon(ringsLL(rr), { ...base, stroke: false, fillColor: `url(#wb-hatch-${h})`, fillOpacity: 1, className: `${cls} wb-possible` }).addTo(overlayLayer);
    }
    // 2) Ränder: wahrscheinlich durchgezogen, möglich gestrichelt (Farbe des Horizonts), Referenzlauf als dünne Linie
    for (let h = H.length - 1; h >= 0; h--) {
      const L1 = layers[h];
      if (L1.likely.rings.length) L.polygon(ringsLL(L1.likely.rings), { ...base, fill: false, color: rgb(HZ_COLORS[h]), weight: 2.5, opacity: 0.95, className: `${cls} wb-likely-edge` }).addTo(overlayLayer);
      if (L1.possible.rings.length) L.polygon(ringsLL(L1.possible.rings), { ...base, fill: false, color: rgb(HZ_COLORS[h]), weight: 2.5, opacity: 0.95, dashArray: "7 5", className: `${cls} wb-possible-edge` }).addTo(overlayLayer);
    }
    for (let h = H.length - 1; h >= 0; h--) {
      const rr = layers[h].reference.rings;
      if (rr.length) L.polygon(ringsLL(rr), { ...base, fill: false, color: "#111", weight: 1.5, opacity: 0.9, className: `${cls} wb-ref` }).addTo(overlayLayer);
    }
    // Flächenabweichung Darstellung vs. Rasterfläche: Flächen ab 100 Zellen (6,25 ha) und kleinere getrennt
    let maxDev = 0, maxDevSmall = 0;
    for (const l of layers) for (const k of ["likely", "possible"]) {
      const st = l.stats[k];
      if (!st.rasterCells) continue;
      const dv = Math.abs(st.shownCells / st.rasterCells - 1) * 100;
      if (st.rasterCells >= 100) maxDev = Math.max(maxDev, dv); else maxDevSmall = Math.max(maxDevSmall, dv);
    }
    const warnPct = P.display.contour.warnAreaDevPct;
    run.display = { mode, maxAreaDevPct: maxDev, maxAreaDevSmallPct: maxDevSmall, stats: layers.map((l) => ({ H: l.H, ...l.stats })) };
    const note = $("lg-note");
    if (mode === "raster") note.textContent = "Rasteransicht: 25-m-Zellen ungeglättet, Umrisse entlang der Zellränder.";
    else note.textContent = `Konturen: geglättete Darstellung des 25-m-Rasters (Flächenabweichung max. ${fmtNum(maxDev, 1)} %${maxDevSmall > warnPct ? `; Flächen unter 6 ha bis ${fmtNum(maxDevSmall, 0)} %, dort Rasteransicht prüfen` : ""}).`;
    note.classList.toggle("warn", mode === "kontur" && maxDev > warnPct);
    // Beschriftung der Horizonte (Form/Text zusätzlich zur Farbe)
    const dir = run.metrics.mainDirDeg ?? (result.refInfo[0].headDeg);
    const ux = Math.sin((dir * Math.PI) / 180), uy = Math.cos((dir * Math.PI) / 180);
    const ign = run.ignition;
    let cx = 0, cy = 0;
    for (const k of ign) { const [x, y] = Grid.cellCenter(g, k); cx += x; cy += y; }
    cx /= ign.length; cy /= ign.length;
    H.forEach((hh, h) => {
      let best = -1, bestD = -Infinity;
      for (let k = 0; k < ref.length; k++) {
        if (ref[k] > hh * 60) continue;
        const [x, y] = Grid.cellCenter(g, k);
        const d = (x - cx) * ux + (y - cy) * uy;
        if (d > bestD) { bestD = d; best = k; }
      }
      if (best >= 0) {
        L.marker(Grid.cellLatLng(g, best), { icon: L.divIcon({ className: "", html: `<span class="hz-label">${hh} h</span>`, iconSize: null, iconAnchor: [14, -4] }), interactive: false, keyboard: false }).addTo(overlayLayer);
      }
    });
    if (!map.hasLayer(overlayLayer)) overlayLayer.addTo(map);
    // Karte auf den "möglich"-Bereich des letzten Horizonts einpassen
    const last = result.counts[H.length - 1];
    let minI = Infinity, maxI = -1, minJ = Infinity, maxJ = -1;
    for (let k = 0; k < last.length; k++) {
      if (last[k] / result.runs < pP) continue;
      const i = k % g.nx, j = (k - i) / g.nx;
      if (i < minI) minI = i; if (i > maxI) maxI = i; if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
    }
    if (maxI >= 0 && !keepView) {
      const sw = g.proj.toLatLng(g.x0 + minI * g.cell, g.y0 + minJ * g.cell);
      const ne = g.proj.toLatLng(g.x0 + (maxI + 1) * g.cell, g.y0 + (maxJ + 1) * g.cell);
      map.fitBounds(L.latLngBounds([sw, ne]).pad(0.8), { maxZoom: 17 });
    }
  }

  function renderFuel() {
    fuelLayer.clearLayers();
    const run = S.run;
    if (!run || !$("chk-fuelmap").checked) { map.removeLayer(fuelLayer); return; }
    const g = run.grid;
    const cv = document.createElement("canvas"); cv.width = g.nx; cv.height = g.ny;
    const ctx = cv.getContext("2d"); const img = ctx.createImageData(g.nx, g.ny);
    const cols = CLASS_LIST.map((k) => { const h = P.fuelClasses[k].color; return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; });
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const c = cols[g.fuel[j * g.nx + i]]; const o = ((g.ny - 1 - j) * g.nx + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 170;
    }
    ctx.putImageData(img, 0, 0);
    const b = g.bounds;
    L.imageOverlay(cv.toDataURL(), [[b.south, b.west], [b.north, b.east]], { className: "wb-overlay", interactive: false }).addTo(fuelLayer);
    fuelLayer.addTo(map);
    overlayLayer.bringToFront?.();
  }
  $("chk-fuelmap").onchange = renderFuel;

  function reachRow(label, r) {
    if (!r) return `<tr><td>${label}</td><td colspan="2">nicht verfügbar (keine OSM-Daten)</td></tr>`;
    return `<tr><td>${label}</td><td class="num">${Suggest.fmtMin(r.earliest)}</td><td class="num">${Suggest.fmtMin(r.ref)}</td></tr>`;
  }

  function inputMeta(run) {
    const wx = S.wx;
    const ov = Object.keys(S.overrides);
    return `<div class="meta">
      <div>Berechnet: <b>${fmtTime(run.finishedAt)}</b>, Prognosebeginn ${fmtTime(run.startTime)}</div>
      <div>Modell: <b>${esc(P.modelName)}</b>, Version ${esc(P.version)}, ${run.result.runs} Ensemble-Läufe + Referenzlauf, Raster ${P.grid.cellM} m, ${fmtNum(run.result.durationMs / 1000, 1)} s</div>
      <div>Wetter: <b>${esc(wx ? wx.source : "nur manuelle Eingabe")}</b>${wx ? `, abgerufen ${fmtTime(wx.fetchedAt)}, Alter bei Rechnung ${fmtNum(Weather.ageHours(wx, run.startTime) * 60, 0)} min` : ""}${ov.length ? `; manuell überschrieben: ${ov.map(labelOf).join(", ")}` : ""}</div>
      <div>Brennstoff: <b>${S.osm ? `OSM, Datenstand ${esc(S.osm.timestamp || "unbekannt")}` : `einheitlich ${esc(P.fuelClasses[selFuel.value].label)}`}</b> (Zuordnung: Annahme)</div>
      <div>Geländewind: ${twText(run)}</div>
      <div>Gelände: ${run.terrain && run.terrain.hang ? `<b>DGM1 NRW</b> (${esc(run.terrain.attribution)}), Stand ${esc(run.terrain.stand)}, auf ca. 25 m gemittelt; Hangzuschlag bergauf nach Rothermel, vereinfacht (max. Neigung ${fmtNum(P.dem.maxTanSlope * 100, 0)} %)` : `<b>kein Geländemodell</b> – Hangneigung nicht berücksichtigt`}</div>
      ${run.scenario ? `<div>Szenario B: ${esc(scenarioText(run.scenario))}</div>` : ""}
      ${run.display ? `<div>Kartendarstellung: <b>${run.display.mode === "raster" ? "Raster 25 m (ungeglättet)" : "Konturen"}</b>${run.display.mode === "raster" ? "" : ` – Glättung des 25-m-Rasters (Marching Squares + Chaikin), Flächenabweichung zur Rasterfläche max. ${fmtNum(run.display.maxAreaDevPct, 1)} %; Kennzahlen unten beruhen immer auf dem Raster`}. Umschalten in der Legende.</div>` : ""}
    </div>`;
  }

  function renderResults(run) {
    const m = run.metrics;
    const w = run.warnings.map((t) => msg(/BEISPIEL|alt/.test(t) ? "err" : "warn", esc(t))).join("");
    const rows = m.perH.map((r) => `<tr><td>${r.H} h</td><td class="num">${fmtNum(r.likelyHa)}</td><td class="num">${fmtNum(r.possibleHa)}</td><td class="num">${fmtNum(r.refHa)}</td><td class="num">${fmtNum(r.possibleHa - m.initialHa)}</td></tr>`).join("");
    const r = run.reach;
    $("results").innerHTML = `
      <div class="msg warn"><b>Modellprognose, unvalidiert.</b> Unsicherheitsband aus ${run.result.runs} Läufen (Wind ±${P.ensemble.windDirDeg}°, Windstärke ×${P.ensemble.windSpeedFactor.join("–")}, Feuchte ±${P.ensemble.deadMoistureAbs} %-Pkt.).</div>
      ${w}
      ${inputMeta(run)}
      <div class="tablewrap"><table class="data">
        <thead><tr><th>Horizont</th><th class="num">wahrscheinlich ha</th><th class="num">möglich ha</th><th class="num">Referenz ha</th><th class="num">Zuwachs (möglich) ha</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <dl class="kv">
        <dt>Ausgangsfläche (Raster)</dt><dd>${fmtNum(m.initialHa, 2)} ha</dd>
        <dt>Spitzen-Ausbreitungsrate</dt><dd>${fmtNum(m.peakRosMMin, 1)} m/min (Kopffeuer in der Ebene, Referenz${run.terrain && run.terrain.hang ? ", ohne Hangzuschlag" : ""})</dd>
        ${run.terrain && run.terrain.hang ? `<dt>Gelände im Rechengebiet</dt><dd>${fmtNum(run.terrain.rechengebiet.hoehe_min_m, 0)}–${fmtNum(run.terrain.rechengebiet.hoehe_max_m, 0)} m, Neigung Mittel ${fmtNum(run.terrain.rechengebiet.neigung_mittel_pct, 0)} %, max. ${fmtNum(run.terrain.rechengebiet.neigung_max_pct, 0)} %</dd>` : ""}
        <dt>Hauptausbreitungsrichtung</dt><dd>${m.mainDirDeg === null ? "keine deutliche Richtung" : `${Math.round(m.mainDirDeg)}° (${compass(m.mainDirDeg)})`}</dd>
      </dl>
      <div class="tablewrap"><table class="data">
        <thead><tr><th>Objekt erreicht</th><th class="num">frühestens (Ensemble)</th><th class="num">Referenzlauf</th></tr></thead>
        <tbody>${reachRow("Wohnbebauung/Gebäude", r.wohnbebauung)}${reachRow("Hauptstraßen", r.strasse)}${reachRow("Bahnlinie", r.bahn)}${reachRow("Schutzgebiete", r.schutzgebiet)}</tbody>
      </table></div>`;
  }

  // ---------------------------------------------------------------- Szenario
  function scenarioText(s) {
    return `${s.fixDir !== null ? `Wind aus ${s.fixDir}°` : ""}${s.dDir ? ` Windrichtung ${s.dDir > 0 ? "+" : ""}${s.dDir}°` : ""}${s.speed !== 1 ? ` Wind ×${s.speed}` : ""}${s.drh ? ` rF ${s.drh > 0 ? "+" : ""}${s.drh} %-Pkt.` : ""}`.trim() || "keine Änderung";
  }
  $("btn-scenario").onclick = async () => {
    if (!S.run) { $("sc-result").innerHTML = msg("err", "Zuerst die Prognose (Szenario A) berechnen."); return; }
    const fd = $("sc-fixdir").value.trim();
    const sc = { dDir: Number($("sc-dir").value), speed: Number($("sc-speed").value), drh: Number($("sc-rh").value), fixDir: fd === "" ? null : Number(fd) };
    $("btn-scenario").disabled = true;
    try {
      const run = await runForecast(sc);
      if (!run) return;
      S.runB = run;
      renderScenario();
    } finally { $("btn-scenario").disabled = false; }
  };
  function renderScenario() {
    const A = S.run, B = S.runB;
    if (!A || !B) return;
    const rows = A.metrics.perH.map((a, k) => {
      const b = B.metrics.perH[k];
      return `<tr><td>${a.H} h</td><td class="num">${fmtNum(a.likelyHa)} / ${fmtNum(a.possibleHa)}</td><td class="num">${fmtNum(b.likelyHa)} / ${fmtNum(b.possibleHa)}</td></tr>`;
    }).join("");
    const reachCmp = (k, label) => A.reach[k] ? `<tr><td>${label} frühestens</td><td class="num">${Suggest.fmtMin(A.reach[k].earliest)}</td><td class="num">${Suggest.fmtMin(B.reach[k].earliest)}</td></tr>` : "";
    $("sc-result").innerHTML = `
      ${msg("", `Szenario B: <b>${esc(scenarioText(B.scenario))}</b>. Beide Ergebnisse sind Modellprognosen mit Unsicherheitsband.`)}
      <div class="tablewrap"><table class="data"><thead><tr><th>Horizont</th><th class="num">A wahrsch. / mögl. ha</th><th class="num">B wahrsch. / mögl. ha</th></tr></thead>
      <tbody>${rows}
      <tr><td>Hauptrichtung</td><td class="num">${A.metrics.mainDirDeg === null ? "–" : Math.round(A.metrics.mainDirDeg) + "° " + compass(A.metrics.mainDirDeg)}</td><td class="num">${B.metrics.mainDirDeg === null ? "–" : Math.round(B.metrics.mainDirDeg) + "° " + compass(B.metrics.mainDirDeg)}</td></tr>
      ${reachCmp("wohnbebauung", "Bebauung")}</tbody></table></div>
      <div class="btnrow"><button class="btn${S.mapShows === "A" ? " primary" : ""}" id="btn-show-a" type="button">Karte: A zeigen</button><button class="btn${S.mapShows === "B" ? " primary" : ""}" id="btn-show-b" type="button">Karte: B zeigen</button></div>`;
    $("btn-show-a").onclick = () => { S.mapShows = "A"; renderOverlay(S.run); renderScenario(); renderTwind(); updateHeader(); };
    $("btn-show-b").onclick = () => { S.mapShows = "B"; renderOverlay(S.runB); renderScenario(); renderTwind(); updateHeader(); };
  }

  // ---------------------------------------------------------------- Vorschläge
  function allWaterPoints() {
    const base = [...(S.run?.osmApplied?.waterPoints || []), ...S.manualWater];
    return base.map((w) => ({ ...w, ...(S.waterEdits[w.id] || {}) })).filter((w) => !w.deleted);
  }

  function computeSuggestions(isRecompute) {
    const run = S.run;
    if (!run) return;
    const osm = run.osmApplied ? { ...run.osmApplied, waterPoints: allWaterPoints() } : (allWaterPoints().length ? { waterPoints: allWaterPoints(), candidates: [], drivable: null, objects: null, _waterOnly: true } : null);
    const useOsm = osm && !osm._waterOnly ? osm : null;
    const old = S.sug;
    const res = Suggest.compute(run.grid, run.result, useOsm, run.ignition, S.vehicles, P, run.metrics.mainDirDeg, S.sugState, { stations: S.stations, maxAnfahrtMin: S.maxAnf, grundschutzOverride: S.gsOverride, grenzen: S.grenzen, teilMode: S.teilMode });
    updateTeilStatus(res.lineInfo.teil);
    if (!useOsm && osm) {
      // nur manuelle Entnahmestellen vorhanden: Wasserinfo trotzdem ergänzen
      for (const v of res.vehicles) if (!v.water?.length) v.water = [];
    }
    S.sugCtx = res.ctx;
    S.sug = res;
    $("btn-resuggest").disabled = false;
    const d = isRecompute ? Suggest.diff(old, res) : null;
    $("sug-diff").innerHTML = d ? msg("", `Neu berechnet: ${d.added.length} neu, ${d.removed.length} entfallen, ${d.changed.length} geändert. Gesperrte/verschobene Elemente bleiben erhalten.${d.removed.length ? `<br>Entfallen: ${d.removed.map(esc).join(", ")}` : ""}`) : "";
    Protocol.add(isRecompute ? "vorschlaege_neu" : "vorschlaege", {
      linien: res.lines.map((l) => ({ id: l.id, laenge_m: Math.round(l.lengthM), frueheste_ankunft_moeglich_min: Math.round(l.minArrivalMin), vorlauf_nach_bereitschaft_min: l.leadMin !== undefined ? Math.round(l.leadMin) : null, begruendung: l.reason, gesperrt: !!l.locked })),
      fahrzeuge: res.vehicles.map((v) => ({ id: v.id, aufgabe: v.task, lat: +v.lat.toFixed(6), lon: +v.lon.toFixed(6), begruendung: v.reason, gesperrt: !!v.locked, verschoben: !!v.moved, pflicht: !!v.pflicht, anfahrt_min_geschaetzt: v.anfahrt && v.anfahrt.ok ? Math.round(v.anfahrt.min) : null, zu_spaet_fuer: v.lateFor || null })),
      hinweise: res.notes, warnungen: res.alerts, differenz: d,
      gemeindeteil: res.lineInfo.teil ? { teil: res.lineInfo.teil.teil, innerhalb: res.lineInfo.teil.innerhalb, quelle: res.lineInfo.teil.quelle, annahme: res.lineInfo.teil.annahme, modus: S.teilMode } : null,
      riegel_pruefung: { bereitschaft_min: res.lineInfo.readyMin, bereitschaft_text: res.lineInfo.readyText, zweite_pruefgrenze: res.lineInfo.second, anfahrt_min: res.lineInfo.anfahrtMin, anfahrt_quelle: res.lineInfo.anfahrtSource, anfahrt_text: res.lineInfo.anfahrtText, aufbau_min: res.lineInfo.setupMin, gefunden: res.lineInfo.found, verworfen: res.lineInfo.rejected, begruendung: res.lineInfo.reason },
      anfahrt: { methode: "Luftlinie × Umwegfaktor ÷ Geschwindigkeit + Ausrückzeit (geschätzt, kein Routing)", umwegfaktor: P.anfahrt.umwegfaktor, max_anfahrt_min: res.dispatch.maxAnfahrtMin, ohne_koordinate: res.dispatch.noCoord, zu_weit: res.dispatch.tooFar, zu_spaet: res.dispatch.late, pflichtfahrzeuge: res.dispatch.pflicht },
      grundschutz: gsProto(res.grundschutz),
      bereitstellungsraum: res.stageInfo ? { lat: +res.stageInfo.lat.toFixed(6), lon: +res.stageInfo.lon.toFixed(6), fahrzeuge: res.stageInfo.vehicleIds } : null,
    });
    refreshProtocol();
    renderSuggestions();
  }
  $("btn-resuggest").onclick = () => computeSuggestions(true);

  // Gemeindeteil (Bereitschaftsvorgabe eigene Wehr): Grenzdatei laden, Auswahl automatisch/manuell
  async function loadGrenzen() {
    try {
      if (window.__INLINE_GEMEINDETEILE) { S.grenzen = window.__INLINE_GEMEINDETEILE; return; }
      const r = await fetch(asset(P.bereitschaftEigeneWehr.grenzenUrl), { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S.grenzen = await r.json();
    } catch (e) { S.grenzen = null; $("teil-status").textContent = `Gemeindeteil-Grenzen nicht geladen (${e.message}); automatisch: 40 min für beide Löschzüge (Annahme). Manuelle Wahl möglich.`; }
  }
  function updateTeilStatus(t) {
    const B = P.bereitschaftEigeneWehr;
    if (!t && S.poly) t = Dispatch.gemeindeteil(...centroid(S.poly), S.grenzen, S.teilMode);
    const head = `Bereitschaft der eigenen Löschzüge (${B.quelle}): gleicher Gemeindeteil ${B.gleicherTeil} min, anderer ${B.andererTeil} min nach Alarm (inkl. Ausrücken, Anfahrt, Aufbau).`;
    $("teil-status").textContent = !t ? head : `${head} Einsatzort: ${t.teil ? `Gemeindeteil ${t.teil}` : t.innerhalb === false ? "außerhalb des Gemeindegebiets (beide Löschzüge: Anfahrt geschätzt + Aufbau, mind. " + B.ausserhalbMinMin + " min; Annahme)" : "Gemeindeteil unbekannt (beide " + B.unbekanntMin + " min; Annahme)"} – ${t.quelle}${t.annahme ? " (ANNAHME, zu prüfen)" : ""}.`;
  }
  $("sel-teil").value = S.teilMode;
  $("sel-teil").onchange = () => {
    S.teilMode = $("sel-teil").value; store.set("wb_teil", S.teilMode);
    Protocol.add("gemeindeteil_wahl", { modus: S.teilMode, hinweis: S.teilMode === "auto" ? "automatisch aus Gemarkung" : "manuelle Wahl überschreibt die automatische Bestimmung" });
    if (S.run) computeSuggestions(true); else { updateTeilStatus(); refreshProtocol(); }
  };

  function gsProto(list) {
    return (list || []).map((a) => ({ geraetehaus: a.wache ? a.wache.name : a.wacheId, fahrzeug: a.vehicle ? a.vehicle.id : null, bezeichnung: a.vehicle ? a.vehicle.bezeichnung || a.vehicle.typ : null, kommune: a.kommune || null, anfahrt_min_geschaetzt: a.anfahrt && a.anfahrt.ok ? Math.round(a.anfahrt.min) : null, anfahrt: a.anfahrt ? (a.anfahrt.ok ? a.anfahrt.text : `unbekannt (${a.anfahrt.reason})`) : null, manuell: !!a.manual, status: a.vehicle ? "Grundschutz" : "nicht sichergestellt" }));
  }
  /** Grundschutz: aus der letzten Vorschlagsrechnung, sonst Vorschau ohne Einsatz. */
  function currentGrundschutz() {
    if (S.sug && S.sug.grundschutz) return { list: S.sug.grundschutz, preview: false };
    const gs = Suggest.grundschutz(S.vehicles, S.stations, P, new Set(), S.gsOverride);
    return { list: gs.assignments, preview: true, alerts: gs.alerts, notes: gs.notes };
  }

  function vehShort(v) {
    const w = v.wache === "lz-nk" ? "NK" : v.wache === "lz-se" ? "SE" : (v.kurz || v.wache || "");
    return `${v.typ}${w ? " " + String(w).slice(0, 14) : ""}`;
  }
  const anfLabel = (a) => (!a ? "–" : a.ok ? `${a.short}${a.fallback ? "" : " (geschätzt, kein Routing)"}` : `unbekannt (${a.reason})`);

  function vehCard(v, sub) {
    const tank = v.vehicle.tank_l === null || v.vehicle.tank_l === undefined ? "Tank offen" : `${v.vehicle.tank_l} l`;
    return `<div class="${sub ? "sug-sub" : "sug"}${v.locked ? " locked" : ""}${v.moved ? " moved" : ""}" data-id="${esc(v.id)}">
        <h3><span class="badge v">${esc(vehShort(v.vehicle))}</span> ${esc(v.task)} ${v.pflicht ? '<span class="flag w">Pflichtfahrzeug</span>' : ""}${(v.lateFor || []).map((l) => `<span class="flag late">zu spät für Riegel ${esc(l)}</span>`).join("")}${v.moved ? '<span class="flag a">manuell verschoben</span>' : ""}${v.locked && !v.moved ? '<span class="flag w">gesperrt</span>' : ""}</h3>
        <p class="small anf"><b>Anfahrt:</b> ${esc(anfLabel(v.anfahrt))}</p>
        <p>${esc(sub ? v.reason.replace(S.sug.stageInfo?.reason || "\u0000", "").trim() : v.reason)}</p>
        ${v.check ? `<p class="${v.check.ok ? "" : "ov"}"><b>Prüfung nach Verschieben:</b> ${esc(v.check.text)}</p>` : ""}
        ${v.waterInfo ? `<p><b>Wasser:</b> ${esc(v.waterInfo)}</p>` : ""}
        <p class="muted small">${esc(v.vehicle.bezeichnung || "")}, ${esc(tank)} (${esc(v.vehicle.tank_quelle || "")}). Quelle: ${esc(v.source)}</p>
        <div class="btnrow"><button class="btn small" data-act="lock" type="button">${v.locked ? "Entsperren" : "Sperren (behalten)"}</button><button class="btn small danger" data-act="discard" type="button">Verwerfen</button><button class="btn small" data-act="zoom" type="button">Zeigen</button></div>
      </div>`;
  }

  /**
   * Fahrzeuge auf der Karte kollisionsfrei: gleiche Position (Bereitstellungsraum) oder auf dem Bildschirm
   * näher als ca. 40 px -> EIN Marker mit Liste. Wird bei jeder Zoomänderung neu gruppiert.
   */
  function vehicleGroups(list) {
    const groups = [];
    for (const v of list) {
      const p = map.latLngToLayerPoint([v.lat, v.lon]);
      const gq = groups.find((gr) => (gr.stage && v.stage && map.distance([gr.lat, gr.lon], [v.lat, v.lon]) < 1) || gr.p.distanceTo(p) < 40);
      if (gq) gq.items.push(v); else groups.push({ lat: v.lat, lon: v.lon, p, stage: !!v.stage, items: [v] });
    }
    return groups;
  }
  const vehLayer = L.layerGroup().addTo(sugLayer);
  function renderVehicleMarkers() {
    vehLayer.clearLayers();
    const res = S.sug;
    if (!res) return;
    for (const gr of vehicleGroups(res.vehicles)) {
      const isStage = gr.items.every((v) => v.stage);
      let icon, tip;
      if (gr.items.length === 1) {
        const v = gr.items[0];
        icon = L.divIcon({ className: "", html: `<span class="veh-marker${v.locked ? " locked" : ""}">${esc(vehShort(v.vehicle))}</span>`, iconSize: null, iconAnchor: [30, 14] });
        tip = `${esc(v.vehicle.bezeichnung || v.vehicle.typ)}: ${esc(v.task)}<br>Anfahrt ${esc(anfLabel(v.anfahrt))}${(v.lateFor || []).length ? `<br>zu spät für Riegel ${esc(v.lateFor.join(", "))}` : ""}`;
      } else if (isStage) {
        icon = L.divIcon({ className: "", html: `<div class="veh-group stage"><b>Bereitstellungsraum</b> <span class="cnt">${gr.items.length}</span><ul>${gr.items.map((v) => `<li>${esc(vehShort(v.vehicle))} – ${esc(v.role || v.task)}</li>`).join("")}</ul></div>`, iconSize: null, iconAnchor: [14, 14] });
        tip = `Bereitstellungsraum:<br>${gr.items.map((v) => `${esc(vehShort(v.vehicle))} – ${esc(v.role || "")}, Anfahrt ${esc(anfLabel(v.anfahrt))}`).join("<br>")}`;
      } else {
        // dicht beieinander (Bildschirm): kompakter Sammelmarker, Liste im Tooltip; hineinzoomen trennt
        icon = L.divIcon({ className: "", html: `<span class="veh-marker multi">${gr.items.length} Fz</span>`, iconSize: null, iconAnchor: [18, 14] });
        tip = gr.items.map((v) => `${esc(vehShort(v.vehicle))}: ${esc(v.task)}, Anfahrt ${esc(anfLabel(v.anfahrt))}`).join("<br>");
      }
      const mk = L.marker([gr.lat, gr.lon], { icon, draggable: true, keyboard: false }).addTo(vehLayer);
      mk.bindTooltip(tip);
      mk.on("dragend", (e) => {
        for (const v of gr.items) moveVehicle(v, e.latlng.lat, e.latlng.lng);
        refreshProtocol(); renderSuggestions();
      });
    }
  }
  map.on("zoomend", renderVehicleMarkers);

  function moveVehicle(v, lat, lon) {
    v.lat = lat; v.lon = lon; v.moved = true; v.locked = true;
    const st = Dispatch.stationMap(S.stations);
    const e = Dispatch.estimate(v.vehicle, st, lat, lon, P);
    const setup = v.taskKind === "Objektschutz" ? P.suggestions.objectSetupMin : P.suggestions.setupMin;
    const chk = Suggest.checkPosition(S.run.grid, S.run.result, S.sugCtx, P, v.lat, v.lon, e.ok ? e.min + setup : undefined);
    if (e.ok) v.anfahrt = e;
    v.check = chk;
    S.sugState.locked.set(v.id, v);
    Protocol.add("vorschlag_verschoben", { id: v.id, lat: +v.lat.toFixed(6), lon: +v.lon.toFixed(6), pruefung: chk.text });
  }

  function renderSuggestions() {
    sugLayer.clearLayers();
    vehLayer.addTo(sugLayer);
    const res = S.sug;
    if (!res) { $("suggestions").innerHTML = ""; return; }
    const html = [];
    const li = res.lineInfo;
    if (res.alerts && res.alerts.length) html.push(res.alerts.map((a) => `<div class="msg err alert-msg">${esc(a)}</div>`).join(""));
    if (li) html.push(msg(li.anfahrtSource === "pauschal" ? "warn" : "", `Früheste Einsatzbereitschaft eines Löschfahrzeugs: <b>${li.readyMin} min</b> nach Prognosebeginn – ${esc(li.readyText)}.${li.second ? ` Weitere Fahrzeuge später, z. B. ${esc(li.second.text)} (zweite, fein gepunktete Prüfgrenze bei ${li.second.checkMin} min).` : ""} Je Riegelabschnitt wird geprüft, ob das zugeordnete Fahrzeug rechtzeitig bereit ist. Vorgeschlagen werden nur Linien, die zu diesem Zeitpunkt zuzüglich ${li.leadMinRequired} min Mindest-Wirkzeit (also bei ${li.checkMin} min, lila gepunktete Linie auf der Karte) vollständig außerhalb der „möglich“-Zone liegen, quer zur Hauptausbreitungsrichtung und vor der Front.`));
    if (li && !res.lines.length) html.push(`<div class="msg err" id="no-line">${esc(li.reason)}</div>`);
    // Prüfgrenze der Riegel: "möglich"-Zone zum Prüfzeitpunkt (Bereitschaft + Mindest-Wirkzeit) als Linie
    if (li && S.run) {
      const g = S.run.grid, tP = Suggest.possibleTimes(S.run.result, P);
      const c = Contour.contourPolygons(tP, g.nx, g.ny, li.checkMin, { smooth: P.display.contour.chaikinIterations, simplify: P.display.contour.simplifyCells, maxValid: Math.max(...S.run.result.horizons) * 60, source: (() => { const m = new Uint8Array(g.nx * g.ny); for (const k of S.run.ignition) m[k] = 1; return m; })() });
      const toLL = (r) => r.map(([x, y]) => g.proj.toLatLng(g.x0 + x * g.cell, g.y0 + y * g.cell));
      if (c.rings.length) {
        L.polygon(c.rings.map(toLL), { fill: false, color: "#6a1b9a", weight: 2.5, dashArray: "2 6", lineCap: "round", interactive: false, className: "wb-ready" }).addTo(sugLayer);
        const ring = c.rings.reduce((a, b) => (b.length > a.length ? b : a));
        const dir = (S.run.metrics.mainDirDeg ?? 0) * Math.PI / 180;
        const top = ring.reduce((a, b) => (b[0] * Math.sin(dir) + b[1] * Math.cos(dir) > a[0] * Math.sin(dir) + a[1] * Math.cos(dir) ? b : a));
        L.marker(toLL([top])[0], { icon: L.divIcon({ className: "", html: `<span class="ready-label">„möglich“ bei ${li.checkMin} min</span>`, iconSize: null, iconAnchor: [-6, 24] }), interactive: false, keyboard: false }).addTo(sugLayer);
      }
      // zweite Prüfgrenze (z. B. Löschzug aus dem anderen Gemeindeteil, 40 min + Wirkzeit)
      if (li.second) {
        const c2 = Contour.contourPolygons(tP, g.nx, g.ny, li.second.checkMin, { smooth: P.display.contour.chaikinIterations, simplify: P.display.contour.simplifyCells, maxValid: Math.max(...S.run.result.horizons) * 60, source: (() => { const m = new Uint8Array(g.nx * g.ny); for (const k of S.run.ignition) m[k] = 1; return m; })() });
        if (c2.rings.length) {
          L.polygon(c2.rings.map(toLL), { fill: false, color: "#6a1b9a", weight: 1.8, opacity: 0.8, dashArray: "1 9", lineCap: "round", interactive: false, className: "wb-ready2" }).addTo(sugLayer);
          const ring2 = c2.rings.reduce((a, b) => (b.length > a.length ? b : a));
          const d2 = (S.run.metrics.mainDirDeg ?? 0) * Math.PI / 180;
          const top2 = ring2.reduce((a, b) => (b[0] * Math.sin(d2) + b[1] * Math.cos(d2) > a[0] * Math.sin(d2) + a[1] * Math.cos(d2) ? b : a));
          L.marker(toLL([top2])[0], { icon: L.divIcon({ className: "", html: `<span class="ready-label r2">„möglich“ bei ${li.second.checkMin} min</span>`, iconSize: null, iconAnchor: [-6, 24] }), interactive: false, keyboard: false }).addTo(sugLayer);
        }
      }
    }
    if (res.notes.length) html.push(res.notes.map((n) => msg("warn", esc(n))).join(""));
    res.lines.forEach((l, idx) => {
      const name = `R${idx + 1}`;
      L.polyline(l.latlngs, { color: "#ffffff", weight: 12, opacity: 0.9 }).addTo(sugLayer);
      L.polyline(l.latlngs, { color: "#6a1b9a", weight: 7, dashArray: l.locked ? null : "14 8" }).addTo(sugLayer);
      const mid = l.latlngs[Math.floor(l.latlngs.length / 2)];
      L.marker(mid, { icon: L.divIcon({ className: "", html: `<span class="line-label">${name}${l.locked ? " (gesperrt)" : ""}</span>`, iconSize: null, iconAnchor: [-8, 10] }), keyboard: false }).addTo(sugLayer);
      const nVeh = res.vehicles.filter((v) => v.lineId === l.id).length;
      html.push(`<div class="sug${l.locked ? " locked" : ""}" data-id="${esc(l.id)}">
        <h3><span class="badge l">${name}</span> Riegelstellung / Abwehrlinie ${l.locked ? '<span class="flag w">gesperrt</span>' : ""}</h3>
        <p>${esc(l.reason)}</p>
        <p class="small"><b>Vorlauf:</b> ${l.leadMin !== undefined ? esc(Suggest.fmtMin(l.leadMin)) : "–"} nach Einsatzbereitschaft · <b>Fahrzeuge:</b> ${nVeh}</p>
        <p class="muted small">Quelle: ${esc(l.source)}</p>
        <div class="btnrow"><button class="btn small" data-act="lock" type="button">${l.locked ? "Entsperren" : "Sperren (behalten)"}</button><button class="btn small danger" data-act="discard" type="button">Verwerfen</button><button class="btn small" data-act="zoom" type="button">Zeigen</button></div>
      </div>`);
    });
    renderVehicleMarkers();
    const stageVeh = res.vehicles.filter((v) => v.stage && !v.moved);
    res.vehicles.filter((v) => !(v.stage && !v.moved)).forEach((v) => html.push(vehCard(v, false)));
    if (stageVeh.length) {
      html.push(`<div class="sug stage" data-id="stage">
        <h3><span class="badge v">BR</span> Bereitstellungsraum (${stageVeh.length} Fahrzeuge)</h3>
        <p>${esc(res.stageInfo?.reason || "")}</p>
        ${stageVeh.map((v) => vehCard(v, true)).join("")}
      </div>`);
    }
    if (!res.lines.length && !res.vehicles.length) html.push(msg("warn", "Keine Vorschläge möglich (z. B. keine Ausbreitung im Horizont oder keine sicheren Standorte)."));
    html.push(gsHtml(res.grundschutz, false));
    $("suggestions").innerHTML = html.join("");
    renderWater();
    renderStations();
    renderVehicles();
  }

  function gsHtml(list, preview) {
    if (!list || !list.length) return "";
    const rows = list.map((a) => {
      const name = a.wache ? a.wache.name : a.wacheId;
      const v = a.vehicle;
      const opts = [`<option value="">automatisch</option>`, ...a.candidates.map((id) => { const c = S.vehicles.find((x) => x.id === id); return `<option value="${esc(id)}"${S.gsOverride[a.wacheId] === id ? " selected" : ""}>${esc(c ? `${c.bezeichnung || c.typ} (${c.kommune || "?"})` : id)}</option>`; })];
      return `<div class="sug-sub gs" data-gs="${esc(a.wacheId)}">
        <h3><span class="badge gsb">GS</span> Grundschutz ${esc(name)} ${v ? `<span class="flag w">${a.manual ? "manuell" : "automatisch"}</span>` : '<span class="flag o">nicht sichergestellt</span>'}</h3>
        ${v ? `<p><b>${esc(v.bezeichnung || v.typ)}</b> (${esc(a.kommune || "")}) – Anfahrt zum Gerätehaus: ${esc(a.anfahrt && a.anfahrt.ok ? a.anfahrt.text : `unbekannt (${a.anfahrt ? a.anfahrt.reason : "–"})`)}</p>` : `<p class="ov">Kein Fahrzeug aus Nachbarkommune verfügbar – Grundschutz nicht sichergestellt.</p>`}
        ${a.wache && !Dispatch.hasCoord(a.wache) ? '<p class="small muted">Gerätehaus ohne Koordinate: Auswahl nur nach Typ/Listenreihenfolge, Anfahrtszeit unbekannt.</p>' : ""}
        ${a.candidates.length ? `<label class="small">Fahrzeug tauschen <select data-gs-sel="${esc(a.wacheId)}">${opts.join("")}</select></label>` : ""}
      </div>`;
    }).join("");
    return `<div class="sug gsbox" id="gs-box"><h3><span class="badge gsb">GS</span> Grundschutz Gerätehäuser (Fahrzeuge aus Nachbarkommunen)${preview ? " – Vorschau ohne Einsatz" : ""}</h3>
      <p class="small muted">Annahme: je Gerätehaus ein wasserführendes Fahrzeug einer anderen Kommune, bevorzugt HLF/LF, dann TLF/MLF/TSF-W, kürzeste geschätzte Anfahrt; nicht im Einsatz eingeplant, nicht doppelt.</p>${rows}</div>`;
  }
  document.addEventListener("change", (e) => {
    const sel = e.target.closest && e.target.closest("select[data-gs-sel]");
    if (!sel) return;
    const id = sel.dataset.gsSel;
    if (sel.value) S.gsOverride[id] = sel.value; else delete S.gsOverride[id];
    store.set("wb_gs_override", S.gsOverride);
    Protocol.add("grundschutz_manuell", { geraetehaus: id, fahrzeug: sel.value || "automatisch" });
    if (S.run) computeSuggestions(true); else { renderVehicles(); renderStations(); refreshProtocol(); }
  });

  $("suggestions").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("[data-id]").dataset.id;
    const all = [...S.sug.lines, ...S.sug.vehicles];
    const s = all.find((x) => x.id === id);
    if (!s) return;
    const act = btn.dataset.act;
    if (act === "zoom") {
      if (s.type === "linie") map.fitBounds(L.latLngBounds(s.latlngs).pad(0.5)); else map.setView([s.lat, s.lon], 16);
      return;
    }
    if (act === "lock") {
      s.locked = !s.locked;
      if (s.locked) S.sugState.locked.set(s.id, s); else { S.sugState.locked.delete(s.id); s.moved = false; }
      Protocol.add("vorschlag_sperre", { id: s.id, gesperrt: s.locked });
    } else if (act === "discard") {
      S.sugState.locked.delete(s.id);
      S.sugState.excluded.add(s.type === "linie" ? s.candId : s.vehicleId);
      S.sug.lines = S.sug.lines.filter((x) => x.id !== id);
      S.sug.vehicles = S.sug.vehicles.filter((x) => x.id !== id);
      Protocol.add("vorschlag_verworfen", { id: s.id });
      $("sug-diff").innerHTML = msg("", "Vorschlag verworfen. „Vorschläge neu berechnen“ verteilt die Fahrzeuge neu.");
    }
    refreshProtocol(); renderSuggestions();
  });

  // ---------------------------------------------------------------- Wasser
  function renderWater() {
    waterLayer.clearLayers();
    for (const w of allWaterPoints()) {
      const icon = L.divIcon({ className: "", html: `<div class="water-marker${w.verified ? " v" : ""}">W</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      const m = L.marker([w.lat, w.lon], { icon, keyboard: false }).addTo(waterLayer);
      m.bindPopup(`<b>${esc(w.kind)}</b><br>Quelle: ${esc(w.source)} – ${w.verified ? "verifiziert" : "nicht verifiziert"}<br>
        <div class="btnrow" style="margin-top:6px"><button class="btn small" data-w="verify" data-id="${esc(w.id)}" type="button">${w.verified ? "Als unverifiziert markieren" : "Vor Ort verifiziert"}</button>
        <button class="btn small danger" data-w="delete" data-id="${esc(w.id)}" type="button">Löschen</button></div>`);
    }
  }
  map.on("popupopen", (e) => {
    const el = e.popup.getElement();
    el.querySelectorAll("button[data-w]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.id;
      const cur = allWaterPoints().find((w) => w.id === id);
      const ed = S.waterEdits[id] || {};
      if (b.dataset.w === "verify") ed.verified = !(cur && cur.verified);
      else ed.deleted = true;
      S.waterEdits[id] = ed;
      store.set("wb_water_edits", S.waterEdits);
      Protocol.add("entnahmestelle", { id, aenderung: ed });
      map.closePopup(); renderWater(); refreshProtocol();
    }));
  });

  // ---------------------------------------------------------------- Fahrzeuge
  async function loadVehicles(forceBundled) {
    const saved = forceBundled ? null : store.get("wb_vehicles", null);
    if (saved) { applyVehicleData(saved, "lokal geänderte Liste (dieses Gerät)"); return; }
    try {
      let data = window.__INLINE_FAHRZEUGE;
      if (!data) {
        const r = await fetch(asset("data/fahrzeuge.json"), { cache: "no-cache" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        data = await r.json();
      }
      applyVehicleData(data, "mitgelieferte Datei data/fahrzeuge.json");
    } catch (e) {
      $("veh-errors").innerHTML = msg("err", `Fahrzeugliste konnte nicht geladen werden (${esc(e.message)}). Liste importieren.`);
      applyVehicleData({ fahrzeuge: [], wachen: [] }, "keine");
    }
  }
  function applyVehicleData(data, label) {
    const nd = Dispatch.normalize(data);
    S.vehMeta = { ...nd.meta };
    S.vehicles = nd.fahrzeuge.map((v) => ({ ...v }));
    S.stations = nd.wachen.map((w) => ({ ...w }));
    $("veh-source").innerHTML = `Quelle: ${esc(label)}. ${esc(data.hinweis || "")}`;
    fillVehFilters();
    renderVehicles(); renderStations();
  }
  function saveVehicles() {
    store.set("wb_vehicles", { ...(S.vehMeta || {}), fahrzeuge: S.vehicles, wachen: S.stations });
  }
  function flag(q) {
    if (!q) return "";
    if (/^Annahme/i.test(q)) return '<span class="flag a" title="' + esc(q) + '">Annahme: Normwert</span>';
    if (/^Offen/i.test(q)) return '<span class="flag o" title="' + esc(q) + '">Offen</span>';
    if (/^Website/i.test(q)) return '<span class="flag w" title="' + esc(q) + '">Website</span>';
    return '<span class="flag w" title="' + esc(q) + '">belegt (Quelle)</span>';
  }
  const isPflicht = (v) => v.pflicht === true || (v.pflicht === undefined && (P.pflichtFahrzeuge || []).includes(v.id));
  function fillVehFilters() {
    const uniq = (a) => [...new Set(a.filter(Boolean).map(String))].sort((x, y) => x.localeCompare(y, "de"));
    const fill = (id, vals, cur) => { const el = $(id); el.innerHTML = `<option value="">alle</option>` + vals.map((v) => `<option${v === cur ? " selected" : ""}>${esc(v)}</option>`).join(""); };
    fill("vf-kommune", uniq(S.vehicles.map((v) => v.kommune)), S.vf.kommune);
    fill("vf-typ", uniq(S.vehicles.map((v) => v.typ)), S.vf.typ);
    $("vf-sort").value = S.vf.sort; $("vf-avail").checked = !!S.vf.onlyAvail;
    $("inp-maxanf").value = S.maxAnf;
  }
  for (const [id, key, prop] of [["vf-kommune", "kommune", "value"], ["vf-typ", "typ", "value"], ["vf-sort", "sort", "value"], ["vf-avail", "onlyAvail", "checked"]]) {
    $(id).addEventListener("change", () => { S.vf[key] = $(id)[prop]; store.set("wb_vf", S.vf); renderVehicles(); });
  }
  $("inp-maxanf").addEventListener("change", () => {
    const v = Number($("inp-maxanf").value);
    if (!(v > 0)) { $("inp-maxanf").value = S.maxAnf; return; }
    S.maxAnf = v; store.set("wb_maxanf", v);
    Protocol.add("anfahrt_grenze", { max_anfahrt_min: v }); refreshProtocol();
    renderVehicles();
  });
  /** Status eines Fahrzeugs aus der letzten Vorschlagsrechnung bzw. Grundschutz. */
  function vehStatus(v) {
    const parts = [];
    if (isPflicht(v)) parts.push('<span class="flag w">Pflicht</span>');
    const gs = currentGrundschutz().list.find((a) => a.vehicle && a.vehicle.id === v.id);
    if (gs) parts.push(`<span class="flag a">Grundschutz ${esc(gs.wache ? gs.wache.name : gs.wacheId)}</span>`);
    const sv = S.sug ? S.sug.vehicles.find((x) => x.vehicleId === v.id) : null;
    if (sv) parts.push(`<span class="small">${esc(sv.task)}</span>`);
    if (sv && sv.lateFor) parts.push(sv.lateFor.map((l) => `<span class="flag late">zu spät für Riegel ${esc(l)}</span>`).join(""));
    else if (S.sug && S.sug.dispatch.late[v.id]) parts.push(S.sug.dispatch.late[v.id].map((l) => `<span class="flag late">zu spät für Riegel ${esc(l)}</span>`).join(""));
    return parts.join(" ");
  }
  function vehEstimates() {
    const est = new Map();
    if (!S.poly) return est;
    const [la, lo] = centroid(S.poly);
    const st = Dispatch.stationMap(S.stations);
    for (const v of S.vehicles) est.set(v.id, Dispatch.estimate(v, st, la, lo, P));
    return est;
  }
  function renderVehicles() {
    const t = $("veh-table");
    const est = vehEstimates();
    const list = S.vf.sort === "liste" ? Dispatch.filterSort(S.vehicles, { ...S.vf, sort: null }, est) : Dispatch.filterSort(S.vehicles, S.vf, est);
    const stName = (id) => S.stations.find((s) => s.id === id)?.name || id || "";
    $("veh-count").textContent = `${list.length} von ${S.vehicles.length} Fahrzeugen angezeigt. Anfahrt zur Brandfläche: ${S.poly ? "geschätzt aus Luftlinie × " + fmtNum(P.anfahrt.umwegfaktor, 1) + " ÷ Geschwindigkeit + Ausrückzeit, kein Routing" : "erst nach Einzeichnen der Brandfläche"}. Einplanung bis ${S.maxAnf} min (Pflichtfahrzeuge immer).`;
    t.innerHTML = `<thead><tr><th>Verf.</th><th>Pflicht</th><th>Fahrzeug</th><th>Kommune / Wache</th><th class="num">Anfahrt</th><th class="num">Tank l</th><th class="num">Pumpe l/min</th><th>Status</th></tr></thead><tbody>` +
      list.map((v) => {
        const k = S.vehicles.indexOf(v);
        const e = est.get(v.id);
        const anf = !S.poly ? "–" : e && e.ok ? `<span class="anf${e.min > S.maxAnf ? " ov" : ""}" title="${esc(e.text)}">${esc(e.short)}</span><br><span class="small muted">geschätzt</span>` : `<span class="flag o" title="${esc(e ? e.reason : "")}">unbekannt</span>`;
        return `<tr data-vid="${esc(v.id)}">
        <td><input type="checkbox" class="veh-av" data-k="${k}" ${v.verfuegbar !== false ? "checked" : ""} aria-label="${esc(v.bezeichnung || v.id)} verfügbar" style="width:28px;height:28px"></td>
        <td><input type="checkbox" class="veh-pf" data-k="${k}" ${isPflicht(v) ? "checked" : ""} aria-label="${esc(v.bezeichnung || v.id)} Pflichtfahrzeug" style="width:28px;height:28px"></td>
        <td><b>${esc(v.typ)}</b><br><span class="small muted">${esc(v.bezeichnung || "")}${v.einheit ? " · " + esc(v.einheit) : ""}${v.loeschfahrzeug === false ? " · kein Löschfahrzeug" : ""}</span>${v.quelle ? `<br><a class="small" href="${esc(v.quelle)}" target="_blank" rel="noopener">Quelle</a>` : ""}${v.quellentyp ? ` <span class="small muted">(${esc(v.quellentyp)})</span>` : ""}${/suchindex|websuche/i.test(String(v.zugriff || "")) ? ' <span class="flag a" title="Angaben aus Suchindex-Zusammenfassungen, Originalseiten nicht abrufbar">ungeprüft, aus Websuche</span>' : ""}</td>
        <td>${esc(v.kommune || "–")}<br><span class="small muted">${esc(stName(v.wache))}</span></td>
        <td class="num">${anf}</td>
        <td class="num">${v.tank_l ?? "–"}<br>${flag(v.tank_quelle)}</td>
        <td class="num">${v.pumpe_lpm ?? "–"}<br>${flag(v.pumpe_quelle)}</td>
        <td>${vehStatus(v)}</td></tr>`;
      }).join("") + "</tbody>";
    t.querySelectorAll(".veh-av").forEach((cb) => cb.addEventListener("change", () => {
      const v = S.vehicles[Number(cb.dataset.k)];
      v.verfuegbar = cb.checked;
      saveVehicles();
      Protocol.add("fahrzeug_verfuegbarkeit", { id: v.id, verfuegbar: v.verfuegbar, pflicht: isPflicht(v) }); refreshProtocol();
      if (!cb.checked && isPflicht(v)) $("veh-errors").innerHTML = msg("err", `ACHTUNG: Pflichtfahrzeug ${esc(v.bezeichnung || v.id)} ist nicht verfügbar und wird nicht eingeplant.`);
    }));
    t.querySelectorAll(".veh-pf").forEach((cb) => cb.addEventListener("change", () => {
      const v = S.vehicles[Number(cb.dataset.k)];
      v.pflicht = cb.checked;
      saveVehicles();
      Protocol.add("pflichtfahrzeug", { id: v.id, pflicht: v.pflicht }); refreshProtocol();
    }));
    renderGsPanel();
  }
  function renderGsPanel() {
    const el = $("gs-panel");
    if (!el) return;
    const g = currentGrundschutz();
    el.innerHTML = gsHtml(g.list, g.preview) + (g.preview && g.alerts ? g.alerts.map((a) => msg("err", esc(a))).join("") : "") + (g.preview && g.notes ? g.notes.map((a) => msg("warn", esc(a))).join("") : "");
  }

  // Wachen-Marker: bildschirmbezogen gruppiert (ohne Zusatzbibliothek), neu bei Zoom/Verschieben
  function renderStationMarkers() {
    stationLayer.clearLayers();
    const gsList = currentGrundschutz().list;
    const pts = S.stations.filter((s) => Dispatch.hasCoord(s));
    for (const gr of Dispatch.groupByScreen(pts, (s) => map.latLngToLayerPoint([s.lat, s.lon]), 46)) {
      const gsHere = gr.items.map((s) => gsList.find((a) => a.wacheId === s.id && a.vehicle)).filter(Boolean);
      let icon, tip;
      if (gr.items.length === 1) {
        const s = gr.items[0];
        icon = L.divIcon({ className: "", html: `<span class="veh-marker st-marker" style="background:#7a0a0a">${esc((s.kurz || s.id).toUpperCase().slice(0, 10))}</span>${gsHere.length ? `<span class="gs-marker">GS ${esc(vehShort(gsHere[0].vehicle))}</span>` : ""}`, iconSize: null });
        tip = `${esc(s.name)}${s.kommune ? ` (${esc(s.kommune)})` : ""}${gsHere.length ? `<br>Grundschutz: ${esc(gsHere[0].vehicle.bezeichnung || gsHere[0].vehicle.typ)}, Anfahrt ${esc(anfLabel(gsHere[0].anfahrt))}` : ""}`;
      } else {
        icon = L.divIcon({ className: "", html: `<span class="st-group">${gr.items.length} Wachen${gsHere.length ? " · GS" : ""}</span>`, iconSize: null });
        tip = gr.items.map((s) => esc(s.name)).slice(0, 15).join("<br>") + (gr.items.length > 15 ? `<br>… (${gr.items.length - 15} weitere)` : "");
      }
      const avg = [gr.items.reduce((a, s) => a + s.lat, 0) / gr.items.length, gr.items.reduce((a, s) => a + s.lon, 0) / gr.items.length];
      const mk = L.marker(avg, { icon, keyboard: false }).addTo(stationLayer).bindTooltip(tip);
      if (gr.items.length > 1) mk.on("click", () => map.fitBounds(L.latLngBounds(gr.items.map((s) => [s.lat, s.lon])).pad(0.3)));
    }
  }
  map.on("zoomend", renderStationMarkers);

  function renderStations() {
    renderStationMarkers();
    const kf = S.vf.kommune;
    const list = S.stations.map((s, k) => ({ s, k })).filter(({ s }) => !kf || (s.kommune || "") === kf);
    $("stations").innerHTML = (kf ? `<p class="small muted">Gefiltert nach Kommune „${esc(kf)}“ (${list.length} von ${S.stations.length}).</p>` : "") + list.map(({ s, k }) => {
      const has = Dispatch.hasCoord(s);
      return `<div class="sug"><h3>${esc(s.name)}${s.kommune ? ` <span class="small muted">${esc(s.kommune)}</span>` : ""}</h3><p>${esc(s.adresse || "")}</p>
        <p class="small">${has ? `Koordinate: ${Number(s.lat).toFixed(5)}, ${Number(s.lon).toFixed(5)} <span class="flag a">${esc(s.koordinate_status || "")}</span>` : `<span class="flag o">${esc(s.koordinate_status || "Offen: Koordinate prüfen")}</span> Fahrzeuge dieser Wache werden ohne Koordinate nicht eingeplant (Pflichtfahrzeuge mit pauschaler Anfahrt).`}</p>
        <p class="muted small">Quelle: ${esc(s.adresse_quelle || s.quelle || "")}${s.quellentyp ? ` (${esc(s.quellentyp)})` : ""}</p>
        <div class="st-coord"><input type="text" inputmode="decimal" placeholder="Breite, z. B. 50.85" data-lat="${k}" aria-label="Breite ${esc(s.name)}"><input type="text" inputmode="decimal" placeholder="Länge, z. B. 7.33" data-lon="${k}" aria-label="Länge ${esc(s.name)}"><button class="btn small" data-setc="${k}" type="button">Koordinate übernehmen</button></div>
        <div class="btnrow"><button class="btn small" data-geo="${k}" type="button">Koordinate aus Adresse suchen (Nominatim)</button></div></div>`;
    }).join("");
    $("stations").querySelectorAll("button[data-setc]").forEach((b) => b.addEventListener("click", () => {
      const k = Number(b.dataset.setc), s = S.stations[k];
      const la = Number(String($("stations").querySelector(`[data-lat="${k}"]`).value).replace(",", ".")), lo = Number(String($("stations").querySelector(`[data-lon="${k}"]`).value).replace(",", "."));
      if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || !la || !lo) { $("veh-errors").innerHTML = msg("err", `Ungültige Koordinate für ${esc(s.name)}.`); return; }
      setStationCoord(s, la, lo, `Manuell eingegeben (${new Date().toLocaleDateString("de-DE")}), zu prüfen`);
    }));
    $("stations").querySelectorAll("button[data-geo]").forEach((b) => b.addEventListener("click", async () => {
      const s = S.stations[Number(b.dataset.geo)];
      b.disabled = true; b.textContent = "Suche …";
      try {
        const r = await fetch(`${CFG.nominatimUrl}?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(s.adresse)}`, { headers: { "Accept-Language": "de" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j.length) throw new Error("Adresse nicht gefunden");
        setStationCoord(s, Number(j[0].lat), Number(j[0].lon), `Geokodiert aus Website-Adresse (Nominatim/OSM, ${new Date().toLocaleDateString("de-DE")}), zu prüfen`);
        return;
      } catch (e) {
        $("veh-errors").innerHTML = msg("err", `Geokodierung für ${esc(s.name)} nicht möglich (${esc(e.message)}). Koordinate bleibt offen.`);
      }
      renderStations();
    }));
  }
  function setStationCoord(s, lat, lon, status) {
    s.lat = lat; s.lon = lon; s.koordinate_status = status;
    saveVehicles();
    Protocol.add("wache_koordinate", { id: s.id, lat, lon, status });
    refreshProtocol();
    renderStations(); renderVehicles();
  }

  // Import mit Validierung
  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const sep = lines[0].includes(";") ? ";" : ",";
    const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((l) => {
      const cells = l.split(sep); const o = {};
      head.forEach((h, k) => { o[h] = (cells[k] ?? "").trim(); });
      return o;
    });
  }
  function validateVehicles(list) {
    const errors = [], out = [], ids = new Set();
    list.forEach((v, k) => {
      const row = `Zeile ${k + 1}`;
      if (!v.id) errors.push(`${row}: Feld „id“ fehlt.`);
      if (!v.typ) errors.push(`${row}: Feld „typ“ fehlt.`);
      if (v.id && ids.has(v.id)) errors.push(`${row}: id „${v.id}“ doppelt.`);
      ids.add(v.id);
      const num = (f) => {
        if (v[f] === "" || v[f] === undefined || v[f] === null) return null;
        const n = Number(String(v[f]).replace(",", "."));
        if (Number.isNaN(n) || n < 0) { errors.push(`${row}: „${f}“ ist keine gültige Zahl (${v[f]}).`); return null; }
        return n;
      };
      const bool = (x, d) => x === undefined || x === "" ? d : x === true || /^(1|ja|true|x)$/i.test(String(x));
      out.push({
        ...v, tank_l: num("tank_l"), pumpe_lpm: num("pumpe_lpm"),
        loeschfahrzeug: bool(v.loeschfahrzeug, P.suggestions.suppressionTypes.includes(v.typ)),
        verfuegbar: bool(v.verfuegbar, true),
        pflicht: v.pflicht === undefined || v.pflicht === "" ? undefined : bool(v.pflicht, false),
        lat: v.lat === undefined || v.lat === null || v.lat === "" ? undefined : num("lat"), lon: v.lon === undefined || v.lon === null || v.lon === "" ? undefined : num("lon"),
        tank_quelle: v.tank_quelle || "Import (Quelle nicht angegeben)", pumpe_quelle: v.pumpe_quelle || "Import (Quelle nicht angegeben)",
        quelle: v.quelle || "Import",
      });
    });
    return { errors, out };
  }
  $("file-veh").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      let raw;
      if (/\.csv$/i.test(f.name) || f.type === "text/csv") raw = parseCsv(text);
      else raw = JSON.parse(text);
      const nd = Dispatch.normalize(raw); // kompatibel mit schema_version 1 und Synonymen (siehe js/dispatch.js)
      const wachen = nd.wachen.length ? nd.wachen : S.stations;
      const { errors, out } = validateVehicles(nd.fahrzeuge);
      if (errors.length) { $("veh-errors").innerHTML = msg("err", `Import abgelehnt:<br>${errors.map(esc).join("<br>")}`); return; }
      S.vehicles = out; S.stations = wachen;
      if (!Array.isArray(raw)) S.vehMeta = { ...(S.vehMeta || {}), ...nd.meta };
      saveVehicles(); fillVehFilters(); renderVehicles(); renderStations();
      const noC = out.filter((v) => !Dispatch.estimate(v, Dispatch.stationMap(wachen), 50.85, 7.33, P).ok).length;
      $("veh-errors").innerHTML = msg("ok", `${out.length} Fahrzeuge, ${wachen.length} Wachen importiert aus ${esc(f.name)}.${noC ? ` ${noC} Fahrzeuge ohne Koordinate (werden nicht eingeplant).` : ""}`) + nd.warnings.slice(0, 10).map((w) => msg("warn", esc(w))).join("") + (nd.warnings.length > 10 ? msg("warn", `… ${nd.warnings.length - 10} weitere Hinweise`) : "");
      Protocol.add("fahrzeugliste_import", { datei: f.name, anzahl: out.length, wachen: wachen.length, hinweise: nd.warnings.length }); refreshProtocol();
    } catch (err) {
      $("veh-errors").innerHTML = msg("err", `Import fehlgeschlagen: ${esc(err.message)}`);
    } finally { e.target.value = ""; }
  });
  $("btn-veh-export").onclick = () => openExport("fahrzeuge.json", JSON.stringify({ ...(S.vehMeta || {}), fahrzeuge: S.vehicles, wachen: S.stations }, null, 2));
  $("btn-veh-reset").onclick = () => { store.del("wb_vehicles"); loadVehicles(true); $("veh-errors").innerHTML = msg("ok", "Mitgelieferte Liste geladen."); };

  // ---------------------------------------------------------------- Protokoll & Export
  function refreshProtocol() {
    const all = Protocol.all();
    const v = Protocol.verify();
    $("proto-verify").innerHTML = v.ok ? msg("ok", `Prüfsummenkette intakt (${v.count} Einträge, SHA-256).`) : msg("err", `Prüfsummenkette verletzt ab Eintrag ${v.at}.`);
    $("proto-list").innerHTML = all.slice(-80).reverse().map((e) => `<div class="pe"><b>#${e.nr} ${esc(e.typ)}</b> · ${fmtTime(e.zeit)}<br><code>${esc(JSON.stringify(e.daten).slice(0, 220))}</code><br><code>hash ${e.hash.slice(0, 16)}…</code></div>`).join("");
  }
  function openExport(name, text) {
    $("exp-title").textContent = `Export: ${name}`;
    $("exp-text").value = text;
    $("modal-export").hidden = false;
    $("btn-exp-download").hidden = ARTIFACT;
    $("btn-exp-download").onclick = () => {
      const blob = new Blob([text], { type: name.endsWith(".json") || name.endsWith(".geojson") ? "application/json" : "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
  }
  $("btn-exp-copy").onclick = async () => {
    const ta = $("exp-text");
    try { await navigator.clipboard.writeText(ta.value); $("btn-exp-copy").textContent = "Kopiert"; }
    catch { ta.select(); $("btn-exp-copy").textContent = "Text markiert – Strg+C"; }
    setTimeout(() => { $("btn-exp-copy").textContent = "Kopieren"; }, 2500);
  };
  $("btn-exp-close").onclick = () => { $("modal-export").hidden = true; };
  $("btn-proto-json").onclick = () => openExport(`protokoll_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify({ app: "Waldbrand-Lagebild NKS", version: P.version, hinweis: "TESTVERSION – nicht für den Einsatz", grundschutz: gsProto(currentGrundschutz().list), export: new Date().toISOString(), pruefung: Protocol.verify(), eintraege: Protocol.all() }, null, 2));
  $("btn-proto-clear").onclick = () => {
    const b = $("btn-proto-clear");
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Wirklich leeren? Erneut tippen"; setTimeout(() => { b.dataset.confirm = ""; b.textContent = "Protokoll leeren"; }, 4000); return; }
    b.dataset.confirm = ""; b.textContent = "Protokoll leeren";
    Protocol.clear(); Protocol.add("protokoll", { text: "Protokoll geleert (neue Kette)" }); refreshProtocol();
  };
  $("btn-print").hidden = ARTIFACT;
  $("btn-print").onclick = () => window.print();

  function cellsToMultiPolygon(g, pred) {
    const polys = [];
    for (let j = 0; j < g.ny; j++) {
      let i = 0;
      while (i < g.nx) {
        if (!pred(j * g.nx + i)) { i++; continue; }
        const i0 = i;
        while (i < g.nx && pred(j * g.nx + i)) i++;
        const x0 = g.x0 + i0 * g.cell, x1 = g.x0 + i * g.cell, y0 = g.y0 + j * g.cell, y1 = y0 + g.cell;
        const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => { const [la, lo] = g.proj.toLatLng(x, y); return [+lo.toFixed(7), +la.toFixed(7)]; });
        polys.push([ring]);
      }
    }
    return { type: "MultiPolygon", coordinates: polys };
  }
  $("btn-geojson").onclick = () => {
    const feats = [];
    const meta = { modell: P.modelName, version: P.version, hinweis: "TESTVERSION – nicht für den Einsatz. Modellprognose, unvalidiert. Keine Handlungsanweisung." };
    if (S.poly) feats.push({ type: "Feature", properties: { typ: "brandflaeche", ...meta }, geometry: { type: "Polygon", coordinates: [[...S.poly, S.poly[0]].map(([a, b]) => [b, a])] } });
    const run = S.run;
    if (run) {
      const g = run.grid, r = run.result;
      r.horizons.forEach((H, h) => {
        for (const [name, thr] of [["wahrscheinlich", P.ensemble.likely], ["moeglich", P.ensemble.possible]]) {
          feats.push({ type: "Feature", properties: { typ: "prognose", horizont_h: H, klasse: name, schwelle: thr, berechnet: new Date(run.finishedAt).toISOString(), wetter: S.wx?.source || "manuell", gelaende: run.terrain?.hang ? `DGM1 NRW (${run.terrain.attribution}), Stand ${run.terrain.stand}` : "ohne Hangneigung", gelaendewind: run.result.terrainWind?.active ? "aktiv (vereinfacht)" : "aus", ...meta }, geometry: cellsToMultiPolygon(g, (k) => r.counts[h][k] / r.runs >= thr) });
        }
      });
    }
    if (S.sug) {
      S.sug.lines.forEach((l) => feats.push({ type: "Feature", properties: { typ: "abwehrlinie_vorschlag", id: l.id, begruendung: l.reason, gesperrt: !!l.locked }, geometry: { type: "LineString", coordinates: l.latlngs.map(([a, b]) => [b, a]) } }));
      S.sug.vehicles.forEach((v) => feats.push({ type: "Feature", properties: { typ: "fahrzeug_vorschlag", fahrzeug: v.vehicle.bezeichnung, aufgabe: v.task, begruendung: v.reason, verschoben: !!v.moved, gesperrt: !!v.locked, pflicht: !!v.pflicht, anfahrt: v.anfahrt ? (v.anfahrt.ok ? v.anfahrt.text : v.anfahrt.reason) : null, zu_spaet_fuer: v.lateFor || null }, geometry: { type: "Point", coordinates: [v.lon, v.lat] } }));
    }
    for (const a of gsProto(currentGrundschutz().list)) {
      const st = S.stations.find((x) => x.name === a.geraetehaus || x.id === a.geraetehaus);
      feats.push({ type: "Feature", properties: { typ: "grundschutz", ...a }, geometry: st && Dispatch.hasCoord(st) ? { type: "Point", coordinates: [Number(st.lon), Number(st.lat)] } : null });
    }
    allWaterPoints().forEach((w) => feats.push({ type: "Feature", properties: { typ: "entnahmestelle", art: w.kind, quelle: w.source, verifiziert: !!w.verified }, geometry: { type: "Point", coordinates: [w.lon, w.lat] } }));
    Protocol.add("export", { format: "GeoJSON", features: feats.length }); refreshProtocol();
    openExport("lage.geojson", JSON.stringify({ type: "FeatureCollection", features: feats }));
  };

  // ---------------------------------------------------------------- Geländewind: Schalter und Ebene
  const TW_COLORS = [["#2b6fd6", 0.75], ["#9cc7ff", 0.95], ["#ffffff", 1.05], ["#7cf2a0", 1.2], ["#10a85a", Infinity]];
  function syncTwControls() {
    $("chk-twind").checked = !!S.tw.wind; $("chk-tmoist").checked = !!S.tw.moisture;
    $("chk-twlayer").checked = !!S.twLayer; $("sel-twhour").value = String(S.twHour);
    $("tw-status").textContent = !S.dem ? "Kein Geländemodell: Geländewind wirkt nicht." : (S.tw.wind || S.tw.moisture) ? "Geländewind aktiv für die nächste Rechnung (vereinfachte Annahme, kein Strömungsmodell, kein Föhn)." : "Aus: Rechnung wie Version 0.3.0 (einheitlicher Wind).";
  }
  $("chk-twind").onchange = () => { S.tw.wind = $("chk-twind").checked; store.set("wb_tw", S.tw); Protocol.add("gelaendewind_schalter", { wind: S.tw.wind, feuchte: S.tw.moisture }); refreshProtocol(); syncTwControls(); };
  $("chk-tmoist").onchange = () => { S.tw.moisture = $("chk-tmoist").checked; store.set("wb_tw", S.tw); Protocol.add("gelaendewind_schalter", { wind: S.tw.wind, feuchte: S.tw.moisture }); refreshProtocol(); syncTwControls(); };
  $("chk-twlayer").onchange = () => { S.twLayer = $("chk-twlayer").checked; store.set("wb_twlayer", S.twLayer); renderTwind(); };
  $("sel-twhour").onchange = () => { S.twHour = Number($("sel-twhour").value); renderTwind(); };
  map.on("overlayadd", (e) => { if (e.layer === twindLayer && !S.twLayer) { S.twLayer = true; store.set("wb_twlayer", true); syncTwControls(); renderTwind(); } });
  map.on("overlayremove", (e) => { if (e.layer === twindLayer && S.twLayer) { S.twLayer = false; store.set("wb_twlayer", false); syncTwControls(); renderTwind(); } });

  /** Pfeile des Geländewindes (Referenzstärke, ausgedünnt) für die angezeigte Prognose. */
  function renderTwind() {
    twindLayer.clearLayers();
    const run = S.mapShows === "B" && S.runB ? S.runB : S.run;
    const lg = $("lg-wind");
    if (!S.twLayer || !run || !run.grid.elev) {
      lg.hidden = true;
      if (map.hasLayer(twindLayer)) map.removeLayer(twindLayer);
      if (S.twLayer && run && !run.grid.elev) $("tw-status").textContent = "Ebene „Geländewind“: kein Geländemodell im Rechengebiet.";
      return;
    }
    const g = run.grid, T = P.terrain.wind;
    const step = Math.max(1, Math.round(T.displaySpacingM / g.cell));
    const cells = [];
    for (let j = Math.floor(step / 2); j < g.ny; j += step) for (let i = Math.floor(step / 2); i < g.nx; i += step) { const k = j * g.nx + i; if (!Number.isNaN(g.elev[k])) cells.push(k); }
    const h = Math.min(S.twHour, run.hours.length - 1);
    const f = TerrainWind.sampleField(g, run.hours, P, h, cells, { wind: true, moisture: false });
    const halo = [], byCol = TW_COLORS.map(() => []);
    for (const pnt of f.points) {
      const [x, y] = Grid.cellCenter(g, pnt.i);
      const len = T.displayArrowM * Math.max(0.45, Math.min(1.8, pnt.ratio));
      const hx = pnt.ux * len / 2, hy = pnt.uy * len / 2;
      const tip = [x + hx, y + hy], tail = [x - hx, y - hy];
      const a = 0.38 * len, ca = Math.cos(2.6), sa = Math.sin(2.6);
      const w1 = [tip[0] + a * (pnt.ux * ca - pnt.uy * sa), tip[1] + a * (pnt.ux * sa + pnt.uy * ca)];
      const w2 = [tip[0] + a * (pnt.ux * ca + pnt.uy * sa), tip[1] + a * (-pnt.ux * sa + pnt.uy * ca)];
      const ll = (q) => g.proj.toLatLng(q[0], q[1]);
      const shapes = [[ll(tail), ll(tip)], [ll(w1), ll(tip), ll(w2)]];
      halo.push(...shapes);
      const c = TW_COLORS.findIndex(([, lim]) => pnt.ratio < lim);
      byCol[c < 0 ? TW_COLORS.length - 1 : c].push(...shapes);
    }
    L.polyline(halo, { pane: "twind", color: "#000", weight: 4.5, opacity: 0.85, interactive: false, className: "wb-twind-halo" }).addTo(twindLayer);
    byCol.forEach((sh, c) => { if (sh.length) L.polyline(sh, { pane: "twind", color: TW_COLORS[c][0], weight: 2.2, opacity: 1, interactive: false, className: "wb-twind" }).addTo(twindLayer); });
    if (!map.hasLayer(twindLayer)) twindLayer.addTo(map);
    lg.hidden = false;
    const t0 = run.hours[h] && Number.isFinite(run.hours[h].t) ? fmtHour(run.hours[h].t) : `+${h} h`;
    $("lg-wind-hour").textContent = `(${t0}, synoptisch ${fmtNum(f.synKmh, 0)} km/h aus ${Math.round(f.hour.dirFrom)}°${f.hour.thermal ? `, Hangwind ${f.hour.thermal}` : ""})`;
    run.twDisplay = { hour: h, arrows: f.points.length, ratioMin: Math.min(...f.points.map((q) => q.ratio)), ratioMax: Math.max(...f.points.map((q) => q.ratio)) };
  }

  // ---------------------------------------------------------------- Kopfzeile, Tabs, Theme
  function updateHeader() {
    const parts = [];
    if (S.wx?.kind === "sample") parts.push("Wetter: BEISPIELDATEN");
    else if (S.wx && Weather.ageHours(S.wx, Date.now()) > P.weather.maxAgeH) parts.push(`Wetter älter als ${P.weather.maxAgeH} h`);
    if (S.run) parts.push(`Prognose ${S.mapShows === "B" ? "Szenario B" : ""} vom ${fmtTime(S.run.finishedAt)}`);
    if (S.tileErrors) parts.push("Kartenhintergrund lädt nicht (Netz/Dienst)");
    $("hdr-status").textContent = parts.join(" · ");
  }
  setInterval(() => { updateHeader(); }, 60000);

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", x === t ? "true" : "false"));
    document.querySelectorAll(".tabpanel").forEach((p) => { p.hidden = p.id !== `panel-${t.dataset.tab}`; });
    store.set("wb_tab", t.dataset.tab);
  }));
  const savedTheme = store.get("wb_theme", null);
  if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  $("btn-theme").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const nxt = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nxt); store.set("wb_theme", nxt);
  };

  // ---------------------------------------------------------------- Start
  $("limits-text").innerHTML = LIMITS_HTML;
  $("hdr-version").textContent = `Version ${P.version}`;
  if (window.WB_VERSION && window.WB_VERSION !== P.version) $("hdr-status").textContent = `Versionskonflikt: Seite ${window.WB_VERSION}, Parameter ${P.version} – Seite neu laden.`;
  syncTwControls();
  $("ack-text").innerHTML = `<p><b>TESTVERSION – nicht für den Einsatz</b> (Version ${esc(P.version)}).</p><p>Diese App ist ein <b>unvalidierter Prototyp</b>. Sie zeigt eine Modellprognose mit Unsicherheitsband und einfache Vorschläge. Sie ersetzt weder Einsatzleitung noch Lageerkundung vor Ort.</p>${LIMITS_HTML}`;
  $("sources-text").innerHTML = SOURCES_HTML;
  document.querySelectorAll(".p-likely").forEach((e) => { e.textContent = Math.round(P.ensemble.likely * 100); });
  document.querySelectorAll(".p-possible").forEach((e) => { e.textContent = Math.round(P.ensemble.possible * 100); });

  let acked = false;
  try { acked = sessionStorage.getItem("wb_ack") === "1"; } catch { acked = false; }
  if (!acked) $("modal-ack").hidden = false;
  $("chk-ack").onchange = () => { $("btn-ack").disabled = !$("chk-ack").checked; };
  $("btn-ack").onclick = () => {
    try { sessionStorage.setItem("wb_ack", "1"); } catch { /* */ }
    $("modal-ack").hidden = true;
    Protocol.add("hinweis_bestaetigt", { text: "Modellgrenzen-Dialog bestätigt", version: P.version });
    refreshProtocol();
  };

  setDisplay(S.display, false);
  drawPoly(); renderWx(); refreshProtocol(); loadVehicles(false); renderWater(); updateHeader();
  loadGrenzen().then(() => updateTeilStatus());
  initDem();
  S.demPromise.then(syncTwControls);
  if (store.get("wb_shade", false)) S.demPromise.then(() => setShade(true));

  // Vorschau-Modus (Artifact): externe Dienste sind dort blockiert -> Demo mit Beispieldaten
  function startDemo() {
    if (!ARTIFACT) return;
    $("sec-flaeche").insertAdjacentHTML("beforeend", msg("warn", "<b>Vorschau-Seite:</b> Kartenkacheln, Open-Meteo und Overpass sind hier technisch gesperrt. Gezeigt wird eine fiktive Demo-Fläche mit Beispielwetter und einheitlichem Brennstoff. Eigene Fläche zeichnen ist möglich."));
    if (S.poly) return;
    const pr = Grid.makeProjection(CENTER[0], CENTER[1]);
    S.poly = [[-180, -120], [160, -150], [220, 90], [-120, 140]].map(([x, y]) => pr.toLatLng(x, y));
    savePoly("Demo-Fläche (fiktiv) für die Vorschau gesetzt");
    if (!S.wx || S.wx.kind !== "sample") $("btn-wx-sample").click();
    setTimeout(() => $("btn-run").click(), 200);
  }
  if (acked) startDemo(); else $("btn-ack").addEventListener("click", startDemo);
  setTimeout(() => map.invalidateSize(), 100);

  // ---------------------------------------------------------------- Testhook (nur für automatisierte Tests)
  window.__wb = {
    setPolygon(pts) { S.poly = pts; savePoly("Brandfläche per Testhook gesetzt"); map.fitBounds(L.latLngBounds(pts).pad(6)); },
    useSampleWeather() { $("btn-wx-sample").click(); },
    injectOsm(json, label) { const b = domainBounds(); setOsm(json, b, label || "Testdaten (synthetisch)"); },
    domainBounds,
    run() { return $("btn-run").onclick(); },
    demReady() { return S.demPromise; },
    setShade,
    setDisplay,
    setTerrain(o) { Object.assign(S.tw, o); store.set("wb_tw", S.tw); syncTwControls(); },
    setTwLayer(on, hour) { S.twLayer = !!on; if (hour !== undefined) S.twHour = hour; syncTwControls(); renderTwind(); },
    setStationCoords(m, status) { for (const s of S.stations) if (m[s.id]) { s.lat = m[s.id][0]; s.lon = m[s.id][1]; s.koordinate_status = status || "Testkoordinate (synthetisch)"; } saveVehicles(); renderStations(); renderVehicles(); },
    setTeil(m) { $("sel-teil").value = m; $("sel-teil").onchange(); },
    grenzenReady() { return S.grenzen; },
    setVehicles(data) { applyVehicleData(data, "Testdaten (synthetisch)"); saveVehicles(); },
    map,
    state: S,
  };
})();
