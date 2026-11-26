/*
 * Darstellung des Moduls "Safe Areas und Fluchtwege".
 *
 *  - eigene Kartenebene „Safe Areas“ (Flächen mit Status-Farbe, einbeschriebener Sicherheitskreis,
 *    Beschriftung) und „Fluchtwege“ (Linien mit Richtungspfeilen zur Fläche)
 *  - Legende
 *  - Tabelle in der Seitenleiste (Flächen, Fluchtwege/Warnungen)
 *
 * Reine Anzeige: keine Rechnung, keine Modellentscheidung. Tag-/Nachtmodus über die CSS-Variablen
 * der App (css/safearea.css), große Bedienelemente (Tablet).
 */
(function (root) {
  const SA = () => root.SafeArea;

  const STATUS = {
    geeignet:   { label: "geeignet",           color: "#1d6b3a", fill: "#2e9e57", cls: "ok" },
    bedingt:    { label: "bedingt geeignet",   color: "#8a6100", fill: "#e8b923", cls: "cond" },
    ungeeignet: { label: "ungeeignet",         color: "#9c1c13", fill: "#c0392b", cls: "bad" },
  };
  const WARN = {
    ok:       { label: "Rückzug gesichert", cls: "ok" },
    knapp:    { label: "knapp",             cls: "cond" },
    kritisch: { label: "WARNUNG",           cls: "bad" },
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => (Number.isFinite(v) ? Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
  const mins = (v) => (Number.isFinite(v) ? `${Math.round(v)} min` : "–");

  /**
   * Erzeugt die Kartenebenen und die Seitenleisten-Ausgabe.
   * @param opt {map, L, layerControl?, panelEl?, legendEl?, onDismiss?, onFocus?, declutter?}
   *   declutter: Funktion des Wirts, die überlappende Kartenbeschriftungen entzerrt. In der App ist
   *   das scheduleDeclutter() aus js/app.js (declutterLabels); dieses Modul bringt BEWUSST keine
   *   zweite Lösung mit, sondern meldet sich nach jedem Zeichnen bei der vorhandenen an.
   *   Dazu müssen in app.js die Auswahl-Klassen ".sa-label,.sa-warnbadge" in LABEL_SEL ergänzt werden.
   * @returns {render(res, grid), layers, destroy()}
   */
  function create(opt) {
    const { map, L } = opt;
    const declutter = typeof opt.declutter === "function" ? opt.declutter : null;
    const areaLayer = L.layerGroup();
    const routeLayer = L.layerGroup();
    if (opt.show !== false) { areaLayer.addTo(map); routeLayer.addTo(map); }
    if (opt.layerControl) {
      opt.layerControl.addOverlay(areaLayer, "Safe Areas");
      opt.layerControl.addOverlay(routeLayer, "Fluchtwege");
    }
    let last = null, lastGrid = null;
    if (declutter) map.on("zoomend moveend", declutter);

    function legendHtml() {
      return `<div class="sa-lg">
        <div class="sa-lg-title">Rückzugsflächen und Fluchtwege</div>
        <div class="sa-lg-row"><span class="sa-sw ok"></span><span>geeignet (Soll-Radius erfüllt)</span></div>
        <div class="sa-lg-row"><span class="sa-sw cond"></span><span>bedingt geeignet (Begründung in der Tabelle)</span></div>
        <div class="sa-lg-row"><span class="sa-sw bad"></span><span>ungeeignet (zu klein)</span></div>
        <div class="sa-lg-row"><span class="sa-sw circ"></span><span>Sicherheitskreis (Soll-Radius)</span></div>
        <div class="sa-lg-row"><span class="sa-sw route"></span><span>Fluchtweg Fahrzeug (Pfeil = Richtung)</span></div>
        <div class="sa-lg-row"><span class="sa-sw routefoot"></span><span>Fluchtweg zu Fuß</span></div>
        <div class="sa-lg-row"><span class="sa-sw warn"></span><span>Standort mit zu knapper Fluchtzeit</span></div>
        <div class="sa-lg-note">Flammenlänge nach Byram (1959), Soll-Radius nach Butler &amp; Cohen (1998) mit Hang-/Windzuschlag (Annahme). Vorschlag, keine Anordnung.</div>
      </div>`;
    }

    /** Pfeilspitzen entlang einer Linie (Richtung zur Fläche). */
    function arrows(latlngs, color, weight) {
      const out = [];
      const pts = latlngs;
      if (pts.length < 2) return out;
      // Pfeile in gleichmäßigem Abstand: alle n Punkte, mindestens einer am Ende
      const step = Math.max(1, Math.floor(pts.length / 5));
      for (let i = step; i < pts.length; i += step) {
        const a = pts[i - 1], b = pts[i];
        const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        out.push(L.marker(b, {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: "", iconSize: null, iconAnchor: [8, 8],
            html: `<span class="sa-arrow" style="--sa-arrow-color:${color};transform:rotate(${(90 - ang).toFixed(1)}deg)"></span>`,
          }),
        }));
      }
      return out;
    }

    function render(res, grid) {
      last = res; lastGrid = grid;
      areaLayer.clearLayers(); routeLayer.clearLayers();
      if (opt.legendEl) opt.legendEl.innerHTML = legendHtml();
      if (!res) { if (opt.panelEl) opt.panelEl.innerHTML = ""; return; }

      // --- Flächen
      for (const a of res.areas) {
        const st = STATUS[a.status];
        const rings = SA().areaRings(grid, a);
        const dim = a.dismissed;
        for (const r of rings) {
          L.polygon(r, {
            className: `sa-area ${st.cls}${dim ? " dismissed" : ""}`,
            color: st.color, weight: dim ? 1 : 3, opacity: dim ? 0.5 : 0.95,
            fillColor: st.fill, fillOpacity: dim ? 0.06 : 0.22,
            dashArray: dim ? "4 6" : null, interactive: true,
          }).bindTooltip(`<b>${esc(a.typLabel)}</b> – ${esc(st.label)}<br>${esc(a.reason)}`, { sticky: true }).addTo(areaLayer);
        }
        if (!dim) {
          L.circle([a.lat, a.lon], {
            radius: a.requiredRM, className: "sa-circle", color: st.color,
            weight: 2, dashArray: "6 5", fill: false, interactive: false,
          }).addTo(areaLayer);
        }
        L.marker([a.lat, a.lon], {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: "", iconSize: null, iconAnchor: [36, 12],
            html: `<span class="sa-label ${st.cls}${dim ? " dismissed" : ""}">${esc(a.typLabel)} · ${num(a.areaHa, 1)} ha · r ${num(a.inscribedRM)}/${num(a.requiredRM)} m</span>`,
          }),
        }).addTo(areaLayer);
      }

      // --- Fluchtwege
      const warnOf = new Map(res.warnings.map((w) => [w.positionId, w]));
      for (const r of res.routes) {
        const w = warnOf.get(r.positionId);
        const crit = w && w.status !== "ok";
        const best = r.fahrzeug || r.fuss;
        if (best && !best.atArea) {
          const color = crit ? "#9c1c13" : best.mode === "fuss" ? "#6a1b9a" : "#0b4f8a";
          L.polyline(best.latlngs, {
            className: `sa-route ${best.mode}${crit ? " crit" : ""}`, color,
            weight: crit ? 6 : 4, opacity: 0.95, dashArray: best.mode === "fuss" ? "8 6" : null,
          }).bindTooltip(`${esc(r.label || r.positionId)}: Fluchtweg ${best.mode === "fuss" ? "zu Fuß" : "mit Fahrzeug"} ${mins(best.timeMin)}, ${num(best.lengthM)} m`, { sticky: true }).addTo(routeLayer);
          for (const m of arrows(best.latlngs, color)) m.addTo(routeLayer);
        }
        if (crit) {
          L.marker([r.lat, r.lon], {
            interactive: false, keyboard: false,
            icon: L.divIcon({
              className: "", iconSize: null, iconAnchor: [18, 34],
              html: `<span class="sa-warnbadge ${WARN[w.status].cls}">${w.status === "kritisch" ? "Rückzug!" : "knapp"}</span>`,
            }),
          }).addTo(routeLayer);
        }
      }

      if (opt.panelEl) renderPanel(res);
      if (declutter) declutter();
    }

    function renderPanel(res) {
      const h = [];
      const crit = res.warnings.filter((w) => w.status === "kritisch");
      const tight = res.warnings.filter((w) => w.status === "knapp");
      if (crit.length) {
        h.push(`<div class="sa-msg bad" role="alert"><b>Rückzug nicht gesichert bei ${crit.length} Standort(en).</b><ul>${
          crit.map((w) => `<li>${esc(w.label || w.positionId)}: ${esc(w.text)}</li>`).join("")}</ul></div>`);
      }
      if (tight.length) {
        h.push(`<div class="sa-msg cond"><b>Knapp bei ${tight.length} Standort(en).</b><ul>${
          tight.map((w) => `<li>${esc(w.label || w.positionId)}: ${esc(w.text)}</li>`).join("")}</ul></div>`);
      }

      h.push(`<h3 class="sa-h">Rückzugsflächen (${res.areas.filter((a) => !a.dismissed).length} von ${res.allAreaCount})</h3>`);
      // Spalten bewusst knapp: in der App ist die Seitenleiste 360–440 px breit. Größe und Flammenlänge
      // stehen in der Begründungszeile darunter, damit der Knopf „verwerfen“ ohne waagerechtes Scrollen
      // erreichbar bleibt (Befund bei der Integration 0.7.0).
      h.push(`<div class="sa-tablewrap"><table class="sa-table areas"><thead><tr>
        <th>Fläche</th><th>Status</th><th class="num">Radius<br>frei / Soll</th>
        <th></th></tr></thead><tbody>`);
      for (const a of res.areas) {
        const st = STATUS[a.status];
        const zu = a.drivable === 2 ? "Zufahrt über eine Straße (OSM)." : a.drivable === 1 ? "Zufahrt über einen Weg (OSM), Befahrbarkeit prüfen." : "";
        h.push(`<tr class="sa-main${a.dismissed ? " sa-dismissed" : ""}" data-sa-row="${esc(a.id)}">
          <td><button type="button" class="sa-link" data-sa-focus="${esc(a.id)}">${esc(a.typLabel)}</button></td>
          <td><span class="sa-badge ${st.cls}">${esc(st.label)}</span></td>
          <td class="num">${num(a.inscribedRM)} / <b>${num(a.requiredRM)}</b> m</td>
          <td><button type="button" class="sa-btn small" data-sa-dismiss="${esc(a.id)}">${a.dismissed ? "aufnehmen" : "verwerfen"}</button></td>
        </tr>
        <tr class="sa-why${a.dismissed ? " sa-dismissed" : ""}"><td colspan="4">${esc(a.reason)} ${esc(zu)}
          ${a.hinweise.length ? `<ul class="sa-hints">${a.hinweise.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
          <span class="sa-sub">Größe ${num(a.areaHa, 1)} ha, Flammenlänge ${num(a.flameM, 1)} m, Randbrennstoff ${esc(a.edgeClass || "–")}, Hang ${num(100 * a.slopeTan)} %, Wind ${num(a.windKmh)} km/h, Faktor Δ ${num(a.delta, 1)} · ${esc(a.id)}</span></td></tr>`);
      }
      h.push(`</tbody></table></div>`);

      h.push(`<h3 class="sa-h">Fluchtwege je Fahrzeug</h3>`);
      h.push(`<div class="sa-tablewrap"><table class="sa-table routes"><thead><tr>
        <th>Fahrzeug / Aufgabe</th><th class="num">Fahrzeug</th><th class="num">zu&nbsp;Fuß</th>
        <th class="num">Front</th><th class="num">Reserve</th></tr></thead><tbody>`);
      for (const r of res.routes) {
        const w = res.warnings.find((x) => x.positionId === r.positionId) || {};
        const cls = WARN[w.status] ? WARN[w.status].cls : "";
        const best = r.fahrzeug || r.fuss;
        h.push(`<tr class="sa-main">
          <td><b>${esc(r.label || r.positionId)}</b><br><span class="sa-sub">${esc(r.vehicleId || "")}</span></td>
          <td class="num">${r.fahrzeug ? (r.fahrzeug.atArea ? "0 min" : mins(r.fahrzeug.timeMin)) : "–"}</td>
          <td class="num">${r.fuss ? (r.fuss.atArea ? "0 min" : mins(r.fuss.timeMin)) : "–"}</td>
          <td class="num">${mins(w.frontMin)}</td>
          <td class="num"><span class="sa-badge ${cls}">${Number.isFinite(w.reserveMin) ? `${Math.round(w.reserveMin)} min` : w.status === "ok" ? "offen" : "–"}</span></td>
        </tr>
        <tr class="sa-why"><td colspan="5">${esc(w.text || "")}${best ? ` <span class="sa-sub">Strecke ${num(best.lengthM)} m, Anstieg ${num(best.ascentM)} m.</span>` : ""}</td></tr>`);
      }
      h.push(`</tbody></table></div>`);

      if (res.notes.length) {
        h.push(`<h3 class="sa-h">Hinweise und Grenzen</h3><ul class="sa-notes">${res.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
      }
      h.push(`<p class="sa-sub">Sicherheitspuffer ${res.params.bufferMin} min, Reaktionszeit ${res.params.reactionMin} min, Fahrzeug ${res.params.roadKmh}/${res.params.trackKmh} km/h (Straße/Weg) – alles Annahmen, siehe ASSUMPTIONS.md. Rechenzeit ${res.durationMs} ms.</p>`);
      opt.panelEl.innerHTML = h.join("");

      for (const b of opt.panelEl.querySelectorAll("[data-sa-dismiss]")) {
        b.onclick = () => opt.onDismiss && opt.onDismiss(b.getAttribute("data-sa-dismiss"));
      }
      for (const b of opt.panelEl.querySelectorAll("[data-sa-focus]")) {
        b.onclick = () => {
          const a = res.areas.find((x) => x.id === b.getAttribute("data-sa-focus"));
          if (!a) return;
          if (opt.onFocus) opt.onFocus(a);
          else map.setView([a.lat, a.lon], Math.max(map.getZoom(), 15));
        };
      }
    }

    return {
      render, layers: { areaLayer, routeLayer }, legendHtml,
      redraw: () => render(last, lastGrid),
      destroy() { if (declutter) map.off("zoomend moveend", declutter); areaLayer.remove(); routeLayer.remove(); },
    };
  }

  const SafeAreaUI = { create, STATUS, WARN };
  root.SafeAreaUI = SafeAreaUI;
  if (typeof module !== "undefined" && module.exports) module.exports = SafeAreaUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
