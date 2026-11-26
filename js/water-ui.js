/*
 * Modul Wasserversorgung – Oberfläche (Leaflet-Ebenen, Zeitregler, Diagramme, Kennzahlen).
 * Entwurf 0.1.0, passend zu js/water.js. Keine zusätzliche Abhängigkeit außer Leaflet (vendor/).
 *
 * SIMULATION MIT ANNAHMEN, KEINE EINSATZPLANUNG.
 *
 * Verwendung:
 *   const ui = WaterUI.create({ map, L, W: PARAMS.wasser, panel: document.getElementById("wasser-panel") });
 *   ui.setInput({ consumers, sources, vehicles, exclude, roads, terrain, hazard });  // rechnet sofort
 *   ui.setTime(90); ui.play(); ui.pause();
 *   ui.on("recompute", (res) => ...);   // res = {plan, sim, iterations, log}
 *
 * Die Ebenen liegen in ui.layers (sources, hoses, routes, basins, vehicles) und können einzeln in die
 * Layer-Steuerung der App gehängt werden. Alle Zahlen stammen aus js/water.js bzw. PARAMS.wasser.
 */
(function (root) {
  "use strict";
  const Water = root.Water;

  // ------------------------------------------------------------------ Hilfen
  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r0 = (v) => Math.round(v);
  const nf = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? "–" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }));
  /** Minuten -> "h:mm" */
  function fmtTime(min) {
    if (min === null || min === undefined || !isFinite(min)) return "–";
    const m = Math.max(0, Math.round(min));
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
  }
  const css = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  };

  const SRC_SYMBOL = { hydrant: "H", offen: "≈", behaelter: "T", unbekannt: "?" };
  const SRC_TITLE = { hydrant: "Hydrant", offen: "offenes Gewässer / Saugstelle", behaelter: "Löschwasserbehälter/-teich", unbekannt: "Entnahmestelle, Typ offen" };
  const STATE_CLASS = {
    anfahrt: "s-fahrt", rueckfahrt: "s-fahrt", fahrt_beladen: "s-voll", fuellen: "s-fuellen",
    entleeren: "s-entleeren", warten_quelle: "s-warten", warten_becken: "s-warten", pumpen: "s-pumpe", reserve: "s-reserve",
  };

  /**
   * Tatsächlich gefahrene Pendelrouten aus der Simulation ableiten (Quelle -> Becken je Fahrzeug).
   * Grundlage sind die Positionen in den Zuständen fuellen/entleeren; es gibt keine Routenplanung,
   * die Linie ist die LUFTLINIE (Fahrweg = Luftlinie x Umwegfaktor, siehe water.js).
   */
  function routesFromSim(plan, sim) {
    const near = (lat, lon, list) => {
      let best = null;
      for (const o of list) { const d = Water.distM({ lat, lon }, o); if (d < 30 && (!best || d < best.d)) best = { o, d }; }
      return best ? best.o : null;
    };
    const map = new Map();
    for (const v of sim.vehicles) {
      if (v.role !== "pendel") continue;
      let lastSrc = null, prev = null;
      for (let k = 0; k <= sim.N; k++) {
        const st = Water.STATES[v.state[k]];
        if (st === prev) continue;
        prev = st;
        if (Number.isNaN(v.lat[k])) continue;
        if (st === "fuellen") { const s = near(v.lat[k], v.lon[k], plan.sources); if (s) lastSrc = s; }
        if (st === "entleeren" && lastSrc) {
          const b = near(v.lat[k], v.lon[k], plan.basins);
          if (b) {
            const key = lastSrc.id + "\u0000" + b.id;
            const e = map.get(key) || { source: lastSrc, basin: b, trips: 0, vehicles: new Set() };
            e.trips++; e.vehicles.add(v.id); map.set(key, e);
          }
        }
      }
    }
    return [...map.values()].sort((a, b) => b.trips - a.trips);
  }

  // ------------------------------------------------------------------ Diagramm (Canvas, ohne Bibliothek)
  /**
   * Zeitdiagramm je Becken: Füllstand (Fläche, linke Achse, l), Zufluss und Verbrauch (Linien, rechte
   * Achse, l/min). Gezeichnet wird in einen Offscreen-Canvas; bei Zeitänderung wird nur der Cursor neu
   * gesetzt (deshalb auch bei 60-facher Geschwindigkeit flüssig).
   */
  function makeChart(canvas, opt) {
    const off = document.createElement("canvas");
    let data = null, dpr = 1, W = 0, H = 0;
    const PAD = { l: 48, r: 62, t: 10, b: 18 };

    function layout() {
      dpr = Math.min(2, root.devicePixelRatio || 1);
      W = Math.max(240, canvas.clientWidth || 320);
      H = opt && opt.height ? opt.height : 132;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.height = H + "px";
      off.width = canvas.width; off.height = canvas.height;
    }
    function drawStatic() {
      layout();
      const c = off.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      if (!data) return;
      const ink = css("--ink", "#111820"), muted = css("--muted", "#4a5662"), line = css("--line", "#c3ccd5");
      const colLevel = css("--w-level", "#2b7cd3"), colIn = css("--w-in", "#1d6b3a"), colOut = css("--w-out", "#b3261e");
      const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = H - PAD.b;
      const T = data.T, cap = data.cap;
      const fmax = Math.max(100, Math.ceil(Math.max(data.maxFlow, 1) / 100) * 100);
      const X = (t) => x0 + ((x1 - x0) * t) / T;
      const YL = (l) => y1 - ((y1 - y0) * Math.max(0, Math.min(cap, l))) / cap;
      const YF = (q) => y1 - ((y1 - y0) * Math.max(0, Math.min(fmax, q))) / fmax;
      // Raster: Stunden
      c.strokeStyle = line; c.fillStyle = muted; c.lineWidth = 1; c.font = "11px system-ui, sans-serif"; c.textAlign = "center";
      for (let h = 0; h <= T / 60; h++) {
        const x = Math.round(X(h * 60)) + 0.5;
        c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
        c.fillText(h + " h", x, H - 5);
      }
      c.beginPath(); c.moveTo(x0, y1 + 0.5); c.lineTo(x1, y1 + 0.5); c.stroke();
      // Füllstand als Fläche
      c.beginPath(); c.moveTo(X(0), YL(data.level[0]));
      for (let k = 1; k < data.level.length; k++) c.lineTo(X(k * data.dt), YL(data.level[k]));
      c.lineTo(X((data.level.length - 1) * data.dt), y1); c.lineTo(X(0), y1); c.closePath();
      c.fillStyle = colLevel + "33"; c.fill();
      c.beginPath(); c.moveTo(X(0), YL(data.level[0]));
      for (let k = 1; k < data.level.length; k++) c.lineTo(X(k * data.dt), YL(data.level[k]));
      c.strokeStyle = colLevel; c.lineWidth = 2; c.stroke();
      // Zufluss / Verbrauch (Treppe)
      const step = (arr, col) => {
        c.beginPath();
        for (let k = 0; k < arr.length; k++) {
          const xa = X(k * data.dt), xb = X((k + 1) * data.dt), y = YF(arr[k]);
          if (k === 0) c.moveTo(xa, y); else c.lineTo(xa, y);
          c.lineTo(xb, y);
        }
        c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
      };
      step(data.inflow, colIn);
      step(data.outflow, colOut);
      // Achsen
      c.fillStyle = muted; c.textAlign = "right"; c.font = "11px system-ui, sans-serif";
      c.fillText(nf(cap) + " l", x0 - 4, y0 + 9);
      c.fillText("0", x0 - 4, y1);
      c.textAlign = "left";
      c.fillStyle = colIn;
      c.fillText(nf(fmax) + " l/min", x1 + 4, y0 + 9);
      c.fillStyle = ink;
    }
    function paint(tMin) {
      const c = canvas.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.drawImage(off, 0, 0);
      if (!data) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = H - PAD.b;
      const x = Math.round(x0 + ((x1 - x0) * Math.max(0, Math.min(data.T, tMin))) / data.T) + 0.5;
      c.strokeStyle = css("--w-cursor", "#b3261e"); c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, y0 - 2); c.lineTo(x, y1 + 2); c.stroke();
      const k = Math.min(data.level.length - 1, Math.round(tMin / data.dt));
      c.fillStyle = css("--surface", "#fff"); c.strokeStyle = css("--line", "#c3ccd5");
      const lbl = nf(data.level[k]) + " l";
      c.font = "600 11px system-ui, sans-serif";
      const w = c.measureText(lbl).width + 8;
      const bx = Math.min(x1 - w, Math.max(x0, x - w / 2));
      c.fillRect(bx, y0 - 2, w, 14); c.strokeRect(bx, y0 - 2, w, 14);
      c.fillStyle = css("--ink", "#111820"); c.textAlign = "left";
      c.fillText(lbl, bx + 4, y0 + 9);
    }
    return {
      set(d) { data = d; drawStatic(); },
      resize() { drawStatic(); },
      paint,
    };
  }

  // ------------------------------------------------------------------ Hauptobjekt
  function create(opts) {
    const L = opts.L || root.L;
    const map = opts.map;
    const panel = opts.panel;
    const W = opts.W || (root.PARAMS && root.PARAMS.wasser) || root.WASSER_PARAMS;
    if (!Water) throw new Error("js/water.js fehlt");
    if (!L || !map) throw new Error("Leaflet-Karte fehlt");

    const listeners = {};
    const emit = (ev, a) => { (listeners[ev] || []).forEach((f) => { try { f(a); } catch (e) { console.error(e); } }); };

    const layers = {
      sources: L.layerGroup(), hoses: L.layerGroup(), routes: L.layerGroup(),
      basins: L.layerGroup(), vehicles: L.layerGroup(),
    };
    for (const k of ["routes", "hoses", "sources", "basins", "vehicles"]) layers[k].addTo(map);

    const S = {
      input: null, res: null, manualBasins: null, t: 0, playing: false, speed: 60,
      addMode: false, charts: [], basinMarkers: new Map(), vehMarkers: new Map(), raf: null, last: 0, basinSeq: 0,
    };

    // ---------------------------------------------------------------- Bedienfeld aufbauen
    panel.innerHTML = `
      <div class="w-ui">
        <p class="w-disclaimer" role="note"><strong>Simulation mit Annahmen, keine Einsatzplanung.</strong>
          Fahrwege sind Luftlinie × Umwegfaktor (kein Routing), Ergiebigkeiten und Zeiten sind Annahmen (docs/assumptions.md).</p>

        <section class="w-card" id="w-timecard">
          <h3>Zeitverlauf</h3>
          <div class="w-timerow">
            <button type="button" class="w-btn w-play" id="w-play" aria-label="Simulation abspielen" aria-pressed="false">▶ Start</button>
            <output class="w-clock" id="w-clock">0:00 h</output>
            <div class="w-speed" role="group" aria-label="Geschwindigkeit">
              <button type="button" class="w-btn w-sp" data-speed="1">1×</button>
              <button type="button" class="w-btn w-sp" data-speed="10">10×</button>
              <button type="button" class="w-btn w-sp is-on" data-speed="60">60×</button>
            </div>
          </div>
          <input type="range" id="w-time" class="w-range" min="0" max="360" step="1" value="0"
                 aria-label="Zeitpunkt der Simulation in Minuten nach Alarm">
          <div class="w-ticks" aria-hidden="true"><span>0</span><span>1 h</span><span>2 h</span><span>3 h</span><span>4 h</span><span>5 h</span><span>6 h</span></div>
          <p class="w-small" id="w-speedhint">1× = Echtzeit (1 Minute Simulation je Minute), 60× = 1 Stunde Simulation je Minute.</p>
        </section>

        <section class="w-card">
          <h3>Pufferbecken (<span id="w-bcount">0</span>)</h3>
          <div class="w-btnrow">
            <button type="button" class="w-btn" id="w-add">Becken hinzufügen</button>
            <button type="button" class="w-btn" id="w-auto">Automatisch neu setzen</button>
          </div>
          <p class="w-small">Becken auf der Karte verschieben (ziehen) oder über das Marker-Menü löschen – es wird jedes Mal neu gerechnet. Volumen je Becken ${nf((W && W.becken && W.becken.volumenL) || 5000)} l (Faltbehälter, Annahme/Vorgabe).</p>
          <div id="w-basinlist"></div>
        </section>

        <section class="w-card">
          <h3>Kennzahlen</h3>
          <div id="w-kpi"></div>
          <h4>Entnahmestellen</h4>
          <div id="w-srctable"></div>
        </section>

        <section class="w-card">
          <h3>Engpassdiagnose</h3>
          <div id="w-diag"></div>
        </section>

        <section class="w-card">
          <h3>Fahrzeuge (Zustand zum Zeitpunkt)</h3>
          <div id="w-vehtable"></div>
          <div id="w-excluded"></div>
        </section>
      </div>`;

    const $ = (id) => panel.querySelector("#" + id);
    const elClock = $("w-clock"), elRange = $("w-time"), elPlay = $("w-play");

    elRange.max = String((W && W.horizonMin) || 360);
    elRange.addEventListener("input", () => { pause(); setTime(Number(elRange.value)); });
    elPlay.addEventListener("click", () => (S.playing ? pause() : play()));
    panel.querySelectorAll(".w-sp").forEach((b) => b.addEventListener("click", () => {
      S.speed = Number(b.dataset.speed);
      panel.querySelectorAll(".w-sp").forEach((x) => x.classList.toggle("is-on", x === b));
    }));
    $("w-add").addEventListener("click", () => setAddMode(!S.addMode));
    $("w-auto").addEventListener("click", () => { S.manualBasins = null; recompute("automatische Becken", { aktion: "automatisch neu gesetzt", id: null, lat: null, lon: null }); });

    map.on("click", (e) => {
      if (!S.addMode) return;
      addBasin(e.latlng.lat, e.latlng.lng);
      setAddMode(false);
    });

    function setAddMode(on) {
      S.addMode = on;
      $("w-add").classList.toggle("is-on", on);
      $("w-add").textContent = on ? "Becken: Punkt auf der Karte antippen" : "Becken hinzufügen";
      const c = map.getContainer();
      c.style.cursor = on ? "crosshair" : "";
    }

    // ---------------------------------------------------------------- Becken bearbeiten
    function currentBasinsAsManual() {
      if (S.manualBasins) return S.manualBasins.slice();
      const bs = (S.res && S.res.plan.basins) || [];
      S.basinSeq = Math.max(S.basinSeq, bs.length);
      return bs.map((b) => ({ id: b.id, lat: b.lat, lon: b.lon }));
    }
    function addBasin(lat, lon) {
      const list = currentBasinsAsManual();
      S.basinSeq++;
      list.push({ id: "B" + (S.basinSeq + 100), lat, lon });
      S.manualBasins = list;
      recompute("Becken hinzugefügt", { aktion: "hinzugefügt", id: list[list.length - 1].id, lat, lon });
    }
    function moveBasin(id, lat, lon) {
      const list = currentBasinsAsManual();
      const b = list.find((x) => x.id === id);
      if (!b) return;
      b.lat = lat; b.lon = lon;
      S.manualBasins = list;
      recompute("Becken verschoben", { aktion: "verschoben", id, lat, lon });
    }
    function deleteBasin(id) {
      const list = currentBasinsAsManual().filter((x) => x.id !== id);
      S.manualBasins = list;
      recompute("Becken gelöscht", { aktion: "gelöscht", id, lat: null, lon: null });
    }

    // ---------------------------------------------------------------- Rechnen
    function setInput(input) {
      S.input = input;
      S.manualBasins = input && Array.isArray(input.basins) ? input.basins.slice() : null;
      recompute("Eingabe gesetzt");
    }

    /** why: Grund (Text); change: Beckenänderung für Protokoll/Export (oder null). */
    function recompute(why, change) {
      if (!S.input) return null;
      const t0 = (root.performance || Date).now();
      const res = Water.run(Object.assign({}, S.input, { W, basins: S.manualBasins }));
      const ms = (root.performance || Date).now() - t0;
      S.res = res; S.res.ms = ms; S.res.why = why || null; S.res.change = change || null;
      drawStatic();
      setTime(Math.min(S.t, res.sim.T));
      emit("recompute", res);
      return res;
    }

    // ---------------------------------------------------------------- Karte: statische Ebenen
    function sourceMarker(s) {
      const sym = SRC_SYMBOL[s.typ] || "?";
      const unverified = !s.verified;
      const html = `<div class="wsrc t-${esc(s.typ)}${unverified ? " unverified" : ""}" title="${esc(SRC_TITLE[s.typ] || "")}">
          <span class="sym">${esc(sym)}</span>${unverified ? '<span class="flag" aria-hidden="true">?</span>' : ""}</div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [30, 30], iconAnchor: [15, 15] });
      const m = L.marker([s.lat, s.lon], { icon, keyboard: false, zIndexOffset: 100 });
      const cap = s.capLpm === null ? "durch Fahrzeugpumpe begrenzt (Saugbetrieb)" : nf(s.capLpm) + " l/min";
      const vol = s.volumeL === Infinity ? "unbegrenzt (Annahme)" : nf(s.volumeL) + " l";
      m.bindPopup(`<div class="w-pop"><b>${esc(s.label)} <span class="w-id">${esc(s.id)}</span></b>
        <div>${s.verified ? "<b>geprüft</b>" : '<b class="w-warn">ungeprüft</b> (Quelle: ' + esc(s.source) + ")"}</div>
        <div>Ergiebigkeit: ${esc(cap)}<br><span class="w-small">${esc(s.capWhy || s.statusWhy || "")}</span></div>
        <div>Vorrat: ${esc(vol)}</div>
        <div>Füllplätze gleichzeitig: ${s.maxConcurrent} · Rüstzeit ${s.ruestMin} min (Annahme)</div>
        ${s.annahmen && s.annahmen.length ? `<div class="w-warn">Annahme ohne Beleg: ${esc(s.annahmen.join(", "))}</div>` : ""}
      </div>`);
      return m;
    }

    function basinMarker(b, sim) {
      const r = sim.basins.find((x) => x.id === b.id) || null;
      const html = `<div class="wbasin${b.manual ? " manual" : ""}${b.reserve ? " reserve" : ""}" data-basin="${esc(b.id)}">
          <div class="tank"><div class="fill" style="height:0%"></div><span class="pct">0%</span></div>
          <div class="lbl">${esc(b.id)}</div></div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [38, 50], iconAnchor: [19, 46] });
      const m = L.marker([b.lat, b.lon], { icon, draggable: true, keyboard: false, zIndexOffset: 300, autoPan: true });
      m.on("dragend", (e) => { const ll = e.target.getLatLng(); moveBasin(b.id, ll.lat, ll.lng); });
      const sup = b.supply || {};
      const supTxt = sup.kind === "schlauch" ? `Förderstrecke von ${esc(sup.sourceId)} (${nf(sup.hose.lengthM)} m, ${nf(sup.hose.flowLpm)} l/min, ${sup.hose.pumps} Pumpe(n))`
        : sup.kind === "schlauch+pendel" ? `Förderstrecke von ${esc(sup.sourceId)} (${nf(sup.hose.flowLpm)} l/min) + Pendelverkehr`
          : sup.kind === "pendel" ? "Pendelverkehr" : "keine Versorgung";
      m.bindPopup(`<div class="w-pop"><b>Pufferbecken ${esc(b.id)}</b> ${b.manual ? "(gesetzt)" : "(automatisch)"}
        ${b.reserve ? '<div class="w-warn">Reservestandort: kein Abnehmer zugeordnet. Nicht eingeplant (keine Versorgung, keine Pendelfahrzeuge) – Aufbau entscheidet die Einsatzleitung.</div>' : ""}
        <div>Volumen ${nf(W.becken.volumenL)} l · Bedarf ${nf(b.demandLpm)} l/min</div>
        <div>Versorgung: ${supTxt}</div>
        <div>Abnehmer: ${esc((b.consumerIds || []).join(", ") || "keine")}</div>
        <div>Standort: ${esc(b.siteNote || "")}</div>
        <div class="${b.safety && b.safety.level >= 2 ? "w-warn" : "w-small"}">${esc(b.safety ? b.safety.text : "")}</div>
        ${r && r.firstEmptyMin !== null ? `<div class="w-warn">läuft erstmals leer nach ${fmtTime(r.firstEmptyMin)}</div>` : ""}
        <div class="w-popbtns"><button type="button" class="w-btn w-del" data-del="${esc(b.id)}">Becken löschen</button></div>
      </div>`);
      m.on("popupopen", (e) => {
        const btn = e.popup.getElement().querySelector(".w-del");
        if (btn) btn.addEventListener("click", () => { map.closePopup(); deleteBasin(b.id); });
      });
      return m;
    }

    function drawStatic() {
      for (const k of Object.keys(layers)) layers[k].clearLayers();
      S.basinMarkers.clear(); S.vehMarkers.clear();
      if (!S.res) return;
      const { plan, sim } = S.res;

      for (const s of plan.sources) sourceMarker(s).addTo(layers.sources);
      for (const s of plan.sourcesRejected || []) {
        const icon = L.divIcon({ className: "", html: `<div class="wsrc t-aus" title="nicht berücksichtigt">×</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
        L.marker([s.lat, s.lon], { icon, keyboard: false }).bindPopup(`<div class="w-pop"><b>${esc(s.label)}</b><div>nicht berücksichtigt: ${esc(s.why || "")}</div></div>`).addTo(layers.sources);
      }

      // Schlauchleitungen: durchgezogen
      for (const b of plan.basins) {
        const h = b.supply && b.supply.hose;
        if (!h) continue;
        const s = plan.sources.find((x) => x.id === b.supply.sourceId);
        if (!s) continue;
        L.polyline([[s.lat, s.lon], [b.lat, b.lon]], { className: "w-hose", color: css("--w-hose", "#1d6b3a"), weight: 5, opacity: 0.95 })
          .bindPopup(`<div class="w-pop"><b>Förderstrecke ${esc(s.id)} → ${esc(b.id)}</b>
            <div>${nf(h.lengthM)} m Schlauchweg (Luftlinie ${nf(h.luftM)} m × ${W.schlauch.umwegFaktor})</div>
            <div>${nf(h.flowLpm)} l/min, ${h.pumps} Pumpe(n), davon ${h.boosters} Verstärker</div>
            <div>höchster Punkt +${nf(h.dhMaxM)} m${h.terrainOk ? " (DGM)" : " (Höhe nicht vollständig geprüft)"}</div>
            <div class="w-small">Aufbau ca. ${nf(h.setupMin)} min (Annahme)</div></div>`)
          .addTo(layers.hoses);
        (h.pumpPos || []).forEach((p, i) => {
          const icon = L.divIcon({ className: "", html: `<div class="wpump">${i === 0 ? "P" : "V"}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
          L.marker([p.lat, p.lon], { icon, keyboard: false }).bindTooltip(i === 0 ? "Pumpe an der Entnahmestelle" : "Verstärkerpumpe").addTo(layers.hoses);
        });
      }

      // Pendelrouten: gestrichelt
      for (const r of routesFromSim(plan, sim)) {
        L.polyline([[r.source.lat, r.source.lon], [r.basin.lat, r.basin.lon]], {
          className: "w-route", color: css("--w-route", "#0b4f8a"), weight: 3, opacity: 0.85, dashArray: "10 8",
        }).bindTooltip(`Pendelroute ${r.source.id} → ${r.basin.id}: ${r.trips} Fahrten, ${r.vehicles.size} Fahrzeug(e) (Luftlinie, kein Routing)`).addTo(layers.routes);
      }

      // Abnehmer
      for (const c of plan.consumers) {
        const icon = L.divIcon({ className: "", html: `<div class="wcons">${c.kind === "Objektschutz" ? "O" : "R"}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
        L.marker([c.lat, c.lon], { icon, keyboard: false })
          .bindTooltip(`${c.label}: ${nf(c.demandLpm)} l/min ab ${fmtTime(c.readyMin)}`).addTo(layers.sources);
      }

      // Becken
      for (const b of plan.basins) {
        const m = basinMarker(b, sim);
        m.addTo(layers.basins);
        S.basinMarkers.set(b.id, m);
      }

      // Fahrzeuge
      sim.vehicles.forEach((v, i) => {
        const p = plan.vehicles[i];
        if (p.role === "reserve") return;
        const icon = L.divIcon({ className: "", html: `<div class="wveh s-reserve"><span class="t">${esc(shortType(p))}</span><span class="bar"><i style="width:0%"></i></span></div>`, iconSize: [40, 26], iconAnchor: [-6, -2] });
        const m = L.marker([p.origin ? p.origin.lat : plan.basins[0] ? plan.basins[0].lat : 0, p.origin ? p.origin.lon : plan.basins[0] ? plan.basins[0].lon : 0], { icon, keyboard: false, zIndexOffset: 500 });
        m.bindTooltip(`${p.label} (${p.id})`, { direction: "top" });
        m.addTo(layers.vehicles);
        S.vehMarkers.set(p.id, { m, p, v });
      });

      renderBasinList();
      renderKpi();
      renderSources();
      renderDiagnosis();
      renderExcluded();
    }

    const shortType = (p) => {
      const t = String(p.typ || "");
      if (/^TW|^LTW|^WLF/.test(t)) return "TW";
      if (/^PTLF/.test(t)) return "PTLF";
      if (/^TLF/.test(t)) return "TLF";
      if (/^HLF/.test(t)) return "HLF";
      if (/^LF/.test(t)) return "LF";
      return t.split(" ")[0] || "FZ";
    };

    // ---------------------------------------------------------------- Panel-Inhalte
    function renderBasinList() {
      const { plan, sim } = S.res;
      $("w-bcount").textContent = String(plan.basins.length);
      const host = $("w-basinlist");
      host.innerHTML = "";
      S.charts = [];
      if (!plan.basins.length) { host.innerHTML = '<p class="w-small">Kein Becken geplant.</p>'; return; }
      for (const b of plan.basins) {
        const r = sim.basins.find((x) => x.id === b.id);
        const box = document.createElement("div");
        box.className = "w-basin";
        const sup = b.supply || {};
        box.innerHTML = `
          <div class="w-basinhead">
            <b>${esc(b.id)}</b> <span class="w-tag">${b.manual ? "gesetzt" : "automatisch"}</span>
            <span class="w-tag${b.reserve ? " w-tag-warn" : ""}">${esc(b.reserve ? "Reservestandort (ohne Abnehmer)" : sup.kind)}</span>
            <span class="w-small">Bedarf ${nf(b.demandLpm)} l/min</span>
          </div>
          <canvas class="w-chart" role="img"
            aria-label="Zeitdiagramm Becken ${esc(b.id)}: Füllstand, Zufluss und Verbrauch über 6 Stunden"></canvas>
          <p class="w-legend"><span class="k k-level"></span>Füllstand (l)
             <span class="k k-in"></span>Zufluss (l/min)
             <span class="k k-out"></span>Verbrauch (l/min)</p>
          <p class="w-small">${r && r.firstEmptyMin !== null ? `<b class="w-warn">erstes Leerlaufen ${fmtTime(r.firstEmptyMin)}</b> · ` : ""}bereit ab ${fmtTime(r.readyMin)} · Warten der Pendelfahrzeuge am Becken ${nf(r.waitMin)} min (Summe aller Fahrzeuge)</p>`;
        host.appendChild(box);
        const ch = makeChart(box.querySelector("canvas"));
        const dt = sim.dt;
        ch.set({
          T: sim.T, dt, cap: W.becken.volumenL, level: Array.from(r.level), inflow: Array.from(r.inflow), outflow: Array.from(r.outflow),
          maxFlow: Math.max(1, ...r.inflow, ...r.outflow, b.demandLpm),
        });
        S.charts.push(ch);
      }
    }

    function renderKpi() {
      const { plan, sim } = S.res;
      const k = sim.kpi;
      const firstEmpty = sim.basins.filter((b) => b.firstEmptyMin !== null).sort((a, b) => a.firstEmptyMin - b.firstEmptyMin)[0] || null;
      const hoseLpm = sim.basins.reduce((s, b) => s + b.inflowHose.reduce((a, v) => a + v, 0), 0) / Math.max(1, sim.N);
      $("w-kpi").innerHTML = `<table class="w-table">
        <caption class="w-small">Eingeschwungener Zustand ab ${fmtTime(k.window[0])} (Mittelwerte bis ${fmtTime(k.window[1])}).</caption>
        <tbody>
        <tr><th scope="row">Bedarf</th><td>${nf(k.demandLpm)} l/min</td></tr>
        <tr><th scope="row">Lieferung</th><td>${nf(k.deliveredLpm)} l/min <span class="w-small">(Pendel ${nf(k.shuttleLpm)}, Schlauch ${nf(hoseLpm)})</span></td></tr>
        <tr class="${k.unmetLpm > 1 ? "w-bad" : "w-good"}"><th scope="row">Defizit</th><td>${nf(k.unmetLpm)} l/min · Deckung ${nf(k.coveragePct)} %</td></tr>
        <tr><th scope="row">erstes Leerlaufen</th><td>${firstEmpty ? `Becken ${esc(firstEmpty.id)} nach ${fmtTime(firstEmpty.firstEmptyMin)}` : "kein Becken läuft leer"}</td></tr>
        <tr><th scope="row">Pendelfahrzeuge</th><td>${sim.shuttleStats.n} · je Fahrzeug ${nf(k.perTankerLpm)} l/min · Warten ${nf(100 * (k.waitSrcShare + k.waitBasinShare))} % der Einsatzzeit</td></tr>
        <tr><th scope="row">ungedeckt gesamt</th><td>${nf(k.totalUnmetL)} l von ${nf(k.totalDemandL)} l</td></tr>
        <tr><th scope="row">Rechenzeit</th><td>${nf(S.res.ms, 1)} ms (${S.res.iterations} Nachplanung(en))</td></tr>
        </tbody></table>`;
    }

    function renderSources() {
      const { sim } = S.res;
      const rows = sim.sources.map((s) => {
        const src = S.res.plan.sources.find((x) => x.id === s.id);
        const ausl = `${nf(s.utilization * 100)} %`;
        return `<tr class="${s.utilization >= 0.9 ? "w-bad" : ""}">
          <th scope="row">${esc(s.label)} <span class="w-id">${esc(s.id)}</span>${src && !src.verified ? ' <span class="w-tag w-tag-warn">ungeprüft</span>' : ""}</th>
          <td>${s.capLpm === null ? "Pumpe" : nf(s.capLpm) + " l/min"}</td>
          <td>${ausl}</td><td>${s.fills}</td><td>${nf(s.meanWaitMin, 1)} min</td>
          <td>${s.depletedAt !== null ? '<b class="w-warn">leer ' + fmtTime(s.depletedAt) + "</b>" : s.remainingL === Infinity ? "–" : nf(s.remainingL) + " l"}</td></tr>`;
      }).join("");
      $("w-srctable").innerHTML = `<table class="w-table w-src">
        <thead><tr><th scope="col">Entnahmestelle</th><th scope="col">Ergiebigkeit</th><th scope="col">Auslastung</th><th scope="col">Füllungen</th><th scope="col">Ø Warten</th><th scope="col">Rest</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">keine Entnahmestelle</td></tr>'}</tbody></table>`;
    }

    function renderDiagnosis() {
      const { plan, sim } = S.res;
      const items = sim.diagnosis.map((d) => `<li class="d-${esc(d.level)}"><b>${esc(d.level === "ok" ? "In Ordnung" : d.level === "kritisch" ? "Kritisch" : d.level === "warnung" ? "Warnung" : "Hinweis")}:</b> ${esc(d.text)}</li>`).join("");
      const warn = plan.warnings.map((t) => `<li class="d-warnung">${esc(t)}</li>`).join("");
      const notes = plan.notes.map((t) => `<li class="d-info">${esc(t)}</li>`).join("");
      $("w-diag").innerHTML = `<ul class="w-diag">${items}${warn}${notes}</ul>`;
    }

    function renderExcluded() {
      const ex = S.res.plan.excluded || [];
      $("w-excluded").innerHTML = ex.length
        ? `<details class="w-det"><summary>${ex.length} Fahrzeuge nicht für die Wasserversorgung (Grundschutz, Pflichtfahrzeuge, eigene Kommune)</summary>
            <ul class="w-small">${ex.map((e) => `<li>${esc(e.label)} <span class="w-id">${esc(e.id)}</span>: ${esc(e.reason)}</li>`).join("")}</ul></details>`
        : "";
    }

    // ---------------------------------------------------------------- Zeitabhängige Anzeige
    function setTime(min) {
      if (!S.res) return;
      const T = S.res.sim.T;
      S.t = Math.max(0, Math.min(T, min));
      elRange.value = String(Math.round(S.t));
      elClock.textContent = fmtTime(S.t);
      elClock.setAttribute("data-min", String(Math.round(S.t)));
      paintTime();
    }

    function paintTime() {
      const { plan, sim } = S.res;
      const k = Math.min(sim.N, Math.round(S.t / sim.dt));
      // Becken
      for (const b of plan.basins) {
        const r = sim.basins.find((x) => x.id === b.id);
        const m = S.basinMarkers.get(b.id);
        if (!m || !r) continue;
        const el = m.getElement();
        if (!el) continue;
        const lvl = r.level[k] || 0;
        const pct = Math.max(0, Math.min(100, (100 * lvl) / W.becken.volumenL));
        const fill = el.querySelector(".fill"), txt = el.querySelector(".pct");
        if (fill) fill.style.height = pct.toFixed(0) + "%";
        if (txt) txt.textContent = Math.round(pct) + "%";
        const box = el.querySelector(".wbasin");
        if (box) box.classList.toggle("empty", S.t >= r.readyMin && lvl < 1);
      }
      // Fahrzeuge
      for (const [, o] of S.vehMarkers) {
        const vi = plan.vehicles.indexOf(o.p);
        const st = Water.vehicleAt(sim, vi, S.t);
        const el = o.m.getElement();
        if (Number.isNaN(st.lat)) { if (el) el.style.display = "none"; continue; }
        if (el) el.style.display = "";
        o.m.setLatLng([st.lat, st.lon]);
        if (!el) continue;
        const box = el.querySelector(".wveh");
        if (box) {
          box.className = "wveh " + (STATE_CLASS[st.state] || "s-reserve");
          const bar = box.querySelector(".bar i");
          if (bar) bar.style.width = Math.round((100 * st.load) / Math.max(1, o.p.tankL || 1)) + "%";
        }
        o.m.setTooltipContent(`${o.p.label} (${o.p.id})<br>${Water.STATE_LABEL[st.state]} · ${nf(st.load)} l`);
      }
      // Diagramme
      for (const c of S.charts) c.paint(S.t);
      renderVehTable(k);
    }

    function renderVehTable(k) {
      const { plan, sim } = S.res;
      const rows = plan.vehicles.map((p, i) => {
        const v = sim.vehicles[i];
        const st = Water.STATES[v.state[Math.min(sim.N, k)]];
        const load = v.load[Math.min(sim.N, k)];
        return { p, v, st, load };
      }).filter((x) => x.p.role !== "reserve")
        .map((x) => `<tr><th scope="row">${esc(x.p.label)}</th><td>${esc(Water.ROLE_LABEL[x.p.role])}</td>
          <td class="${STATE_CLASS[x.st]}">${esc(Water.STATE_LABEL[x.st])}</td>
          <td>${nf(x.load)} l</td><td>${nf(x.v.deliveredL)} l</td></tr>`).join("");
      const res = plan.vehicles.filter((p) => p.role === "reserve").length;
      $("w-vehtable").innerHTML = `<table class="w-table"><thead><tr><th scope="col">Fahrzeug</th><th scope="col">Rolle</th><th scope="col">Zustand</th><th scope="col">Inhalt</th><th scope="col">geliefert gesamt</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">keine Fahrzeuge eingeplant</td></tr>'}</tbody></table>
        ${res ? `<p class="w-small">${res} geeignete Fahrzeuge nicht benötigt (Reserve).</p>` : ""}`;
    }

    // ---------------------------------------------------------------- Abspielen
    function play() {
      if (S.playing || !S.res) return;
      S.playing = true; S.last = (root.performance || Date).now();
      elPlay.textContent = "❚❚ Pause"; elPlay.setAttribute("aria-pressed", "true"); elPlay.classList.add("is-on");
      const step = (ts) => {
        if (!S.playing) return;
        const now = ts || (root.performance || Date).now();
        const dSec = Math.min(0.5, (now - S.last) / 1000);
        S.last = now;
        // Geschwindigkeit bezogen auf Echtzeit: 1x = 1 Simulationsminute je Minute
        setTime(S.t + (dSec * S.speed) / 60);
        if (S.t >= S.res.sim.T) { pause(); return; }
        S.raf = root.requestAnimationFrame(step);
      };
      S.raf = root.requestAnimationFrame(step);
    }
    function pause() {
      if (!S.playing) return;
      S.playing = false;
      if (S.raf) root.cancelAnimationFrame(S.raf);
      elPlay.textContent = "▶ Start"; elPlay.setAttribute("aria-pressed", "false"); elPlay.classList.remove("is-on");
    }

    function fitBounds(pad) {
      if (!S.res) return;
      const pts = [];
      for (const b of S.res.plan.basins) pts.push([b.lat, b.lon]);
      for (const s of S.res.plan.sources) pts.push([s.lat, s.lon]);
      for (const c of S.res.plan.consumers) pts.push([c.lat, c.lon]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(pad === undefined ? 0.25 : pad));
    }

    function redraw() { if (S.res) { drawStatic(); paintTime(); } }

    const api = {
      layers, setInput, recompute, setTime, play, pause, fitBounds, redraw,
      get result() { return S.res; },
      get time() { return S.t; },
      get playing() { return S.playing; },
      setSpeed(x) { const b = panel.querySelector(`.w-sp[data-speed="${x}"]`); if (b) b.click(); },
      addBasin, deleteBasin, moveBasin, setAddMode,
      get addMode() { return S.addMode; },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; },
      /** Kompakte Zusammenfassung für Protokoll/Export (ohne Zeitreihen). */
      summary() { return S.res ? Water.summary(S.res.plan, S.res.sim) : null; },
    };
    root.addEventListener("resize", () => { for (const c of S.charts) c.resize(); paintTime(); });
    return api;
  }

  root.WaterUI = { create, fmtTime, routesFromSim };
  if (typeof module !== "undefined" && module.exports) module.exports = root.WaterUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
