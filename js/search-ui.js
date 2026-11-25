/*
 * Bedienoberfläche der Ortssuche (Leaflet). Klassisches Skript, braucht window.L (Leaflet 1.9) und window.Search.
 *
 *   SearchUI.init({ map, onIgnition(lat, lon, hit), onSelect(hit), limit, searchConfig })
 *     - Markup aus ui-snippet.html muss im DOM stehen (IDs sx-*).
 *     - Suchindex wird erst beim ersten Fokus/Antippen geladen (Search.ensureLoaded).
 *     - ARIA-Combobox (Eingabe) + Listbox (Treffer), Tastatur: Pfeile, Enter, Esc, Pos1/Ende.
 *     - Auswahl: Karte fliegt hin; Marker (Adresse, Rettungspunkt, Koordinate) bzw. Rechteck (Straße, Ortsteil, Kommune);
 *       Ergebniskarte mit Quelle und Knopf "Als Zündpunkt setzen".
 *     - Online-Suche (OpenStreetMap/Nominatim) nur als ausdrücklich gekennzeichneter Listeneintrag bei keinem Offline-Treffer.
 *   SearchUI.rettungspunkteLayer(map, {minZoom, labelZoom, onWarn, obstacleSelector}) -> L.LayerGroup (Kartenebene, lädt
 *     Daten beim Einschalten; onWarn(text) wird gerufen, wenn die KWF-Version älter als 7 Monate ist;
 *     obstacleSelector = bestehende Kartenbeschriftungen, die von den Nummern nicht überdeckt werden dürfen)
 */
(function (root) {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduceMotion = () => !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const fmtDeg = (v, p, n) => `${Math.abs(v).toFixed(6).replace(".", ",")}° ${v >= 0 ? p : n}`;

  // Typ-Symbole (inline SVG, currentColor) + Klartext für Screenreader
  const SVG = (d, extra) => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>${extra || ""}`;
  const TYP = {
    adresse: { name: "Adresse", icon: SVG('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>') },
    strasse: { name: "Straße", icon: SVG('<path d="M7 21L10 3"/><path d="M17 21L14 3"/><path d="M12 6v2M12 11v2M12 16v2"/>') },
    ortsteil: { name: "Ortsteil", icon: SVG('<path d="M3 21h18"/><path d="M5 21V11l4-3 4 3v10"/><path d="M13 21v-7l3-2 3 2v7"/>') },
    kommune: { name: "Kommune", icon: SVG('<path d="M4 5l5-2 6 2 5-2v16l-5 2-6-2-5 2z"/><path d="M9 3v16M15 5v16"/>') },
    rettungspunkt: { name: "Rettungspunkt", icon: '<span class="sx-rp-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" focusable="false"><rect x="1" y="1" width="22" height="22" rx="4" fill="#0a7a3d"/><path d="M12 5v14M5 12h14" stroke="#fff" stroke-width="4"/></svg></span>' },
    koordinate: { name: "Koordinate", icon: SVG('<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>') },
    online: { name: "Online (OSM)", icon: SVG('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>') },
    hinweis: { name: "Hinweis", icon: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/>') },
  };
  const AREA_TYPES = { strasse: 1, ortsteil: 1, kommune: 1 };

  // Quellenvermerk laut KWF (Doku/Metadaten v2.21): "© KWF-Rettungspunkte <Version>, Datenurheber, www.rettungspunkte-forst.de",
  // Version und Links kommen aus data/rettungspunkte-kwf.json (Search.rpInfo); dies ist nur der Ersatz ohne geladene Datei.
  const RP_ATTR_FALLBACK = '<a href="https://www.rettungspunkte-forst.de" target="_blank" rel="noopener">© KWF-Rettungspunkte</a>, ' +
    '<a href="https://docs.rettungspunkte-forst.de/Metadaten_KWF_Rettungspunkte.pdf" target="_blank" rel="noopener">Datenurheber</a>, ' +
    'www.rettungspunkte-forst.de (<a href="https://creativecommons.org/licenses/by-nd/4.0/deed.de" target="_blank" rel="noopener">CC BY-ND 4.0</a>; Inhalt unverändert, Gebietsausschnitt)';
  const HAFTUNG_URL = "https://kwf2020.kwf-online.de/rettungspunkte-download/";
  function rpAttrHtml() { const i = root.Search && root.Search.rpInfo ? root.Search.rpInfo() : null; return i ? i.attributionHtml : RP_ATTR_FALLBACK; }
  function rpStandHtml() {
    const i = root.Search && root.Search.rpInfo ? root.Search.rpInfo() : null;
    if (!i) return "";
    return `<div class="sx-rp-stand">Datenstand: KWF-Rettungspunkte v${esc(i.version)} (${esc(i.standText)})</div>` + (i.warnung ? `<div class="sx-warn">${esc(i.warnung)}</div>` : "");
  }
  const OSM_ATTR_HTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende (ODbL), Suche: Nominatim';

  function init(o) {
    const L = root.L, Search = root.Search, map = o.map;
    const $ = (id) => document.getElementById(id);
    const input = $("sx-input"), list = $("sx-list"), status = $("sx-status"), card = $("sx-card"), clearBtn = $("sx-clear"), box = $("sx-box");
    if (!input || !list) throw new Error("SearchUI: Markup (ui-snippet.html) fehlt");
    if (o.searchConfig) Search.configure(o.searchConfig);
    const limit = o.limit || 8;
    const resultLayer = L.layerGroup().addTo(map);
    let items = [], active = -1, timer = null, onlineRow = false, current = null, onlineBusy = false;

    // Leaflet: Klicks/Scrollen im Suchfeld nicht an die Karte weitergeben
    if (L.DomEvent && box) { L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box); }

    function setStatus(text, warn) { status.textContent = text || ""; status.classList.toggle("warn", !!warn); status.hidden = !text; }

    function ensure() {
      const st = Search.status();
      if (st.geladen || st.laedt) return;
      setStatus("Suchindex wird geladen …");
      Search.ensureLoaded().then(() => {
        const s = Search.status();
        const rpWarn = s.rp && s.rp.warnung;
        setStatus(s.rpFehler ? "Rettungspunkte nicht geladen (" + s.rpFehler + ")" : (rpWarn || ""), !!(s.rpFehler || rpWarn));
        if (input.value.trim()) run();
      }).catch((e) => setStatus("Suchindex nicht verfügbar (" + e.message + "). Koordinaten und Online-Suche funktionieren weiter.", true));
    }
    input.addEventListener("focus", ensure);
    input.addEventListener("pointerdown", ensure);
    input.addEventListener("input", () => {
      clearBtn.hidden = !input.value;
      if (!card.hidden) hideCard(); // neue Eingabe: alte Ergebniskarte weg (Marker bleibt bis zur nächsten Auswahl)
      clearTimeout(timer); timer = setTimeout(run, 120); // Entprellung nur für die OFFLINE-Suche
    });
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", () => setTimeout(() => { if (!box.contains(document.activeElement)) close(); }, 150));
    clearBtn.addEventListener("click", () => { input.value = ""; clearBtn.hidden = true; close(); hideCard(); resultLayer.clearLayers(); input.focus(); });

    function run() {
      const t = input.value.trim();
      if (!t) { close(); return; }
      items = Search.query(t, { limit });
      const real = items.filter((h) => h.typ !== "hinweis").length;
      onlineRow = !!(Search.config.online.enabled && t.length >= 3 && !real && !Search.parseCoordinate(t));
      render();
      const st = Search.status();
      if (!st.geladen && !items.length) setStatus(st.laedt ? "Suchindex wird geladen …" : "Suchindex nicht geladen", !st.laedt);
      else setStatus(real ? `${real} Treffer. Pfeiltasten zum Auswählen, Enter zum Anzeigen.` : (onlineRow ? "Kein Treffer in den Offline-Daten." : "Kein Treffer."));
    }

    function optHtml(h, i) {
      const T = TYP[h.typ] || TYP.hinweis;
      const meta = [T.name, h.typ === "online" ? "online" : null].filter(Boolean).join(" · ");
      return `<li role="option" id="sx-opt-${i}" class="sx-opt sx-${esc(h.typ)}" aria-selected="false" data-i="${i}">
        <span class="sx-ico">${T.icon}</span>
        <span class="sx-txt"><span class="sx-label">${esc(h.label)}</span>
        <span class="sx-sub"><span class="sx-typ">${esc(meta)}</span>${h.sub ? " · " + esc(h.sub) : ""}${h.hinweis ? ` · <em>${esc(h.hinweis)}</em>` : ""}</span></span></li>`;
    }

    function render() {
      let html = items.map(optHtml).join("");
      if (onlineRow) {
        html += `<li role="option" id="sx-opt-online" class="sx-opt sx-online-row" aria-selected="false" data-i="online">
          <span class="sx-ico">${TYP.online.icon}</span>
          <span class="sx-txt"><span class="sx-label">Online suchen: „${esc(input.value.trim())}“</span>
          <span class="sx-sub">OpenStreetMap/Nominatim · sendet den Suchtext an nominatim.openstreetmap.org · nur auf Knopfdruck</span></span></li>`;
      }
      list.innerHTML = html;
      const n = items.length + (onlineRow ? 1 : 0);
      list.hidden = !n;
      input.setAttribute("aria-expanded", n ? "true" : "false");
      active = -1; input.removeAttribute("aria-activedescendant");
    }

    function close() { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; }

    function setActive(i) {
      const opts = list.querySelectorAll("[role=option]");
      if (!opts.length) return;
      active = (i + opts.length) % opts.length;
      opts.forEach((el, k) => el.setAttribute("aria-selected", k === active ? "true" : "false"));
      input.setAttribute("aria-activedescendant", opts[active].id);
      opts[active].scrollIntoView({ block: "nearest" });
    }

    function choose(el) {
      if (!el) return;
      if (el.dataset.i === "online") { doOnline(); return; }
      const h = items[Number(el.dataset.i)];
      if (h && h.lat != null) select(h);
    }

    function onKey(e) {
      const open = !list.hidden;
      if (e.key === "ArrowDown") { e.preventDefault(); if (!open) { run(); setActive(0); } else setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (open) setActive(active - 1); }
      else if (e.key === "Home" && open && e.ctrlKey) { e.preventDefault(); setActive(0); }
      else if (e.key === "End" && open && e.ctrlKey) { e.preventDefault(); setActive(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(timer);
        if (!open || list.querySelectorAll("[role=option]").length === 0) run();
        const opts = list.querySelectorAll("[role=option]");
        choose(opts[active >= 0 ? active : 0]);
      } else if (e.key === "Escape") {
        if (open) { e.preventDefault(); close(); }
        else if (input.value) { e.preventDefault(); input.value = ""; clearBtn.hidden = true; hideCard(); }
      } else if (e.key === "Tab") close();
    }

    list.addEventListener("mousedown", (e) => e.preventDefault()); // Fokus im Eingabefeld behalten
    list.addEventListener("click", (e) => choose(e.target.closest("[role=option]")));

    function doOnline() {
      const t = input.value.trim();
      if (onlineBusy || t.length < 3) return;
      onlineBusy = true;
      setStatus("Online-Suche (OpenStreetMap) läuft …");
      Search.online(t).then((hits) => {
        items = hits.length ? hits : [{ typ: "hinweis", label: "Online kein Treffer im Gebiet", sub: "OpenStreetMap/Nominatim", lat: null, lon: null }];
        onlineRow = false; render(); setActive(0);
        setStatus(hits.length ? `${hits.length} Online-Treffer (© OpenStreetMap-Mitwirkende)` : "Online kein Treffer im Gebiet.");
      }).catch((err) => setStatus("Online-Suche nicht möglich: " + err.message, true)).then(() => { onlineBusy = false; });
    }

    function select(h) {
      current = h;
      close();
      setStatus("");
      input.value = h.label;
      clearBtn.hidden = false;
      showOnMap(h);
      showCard(h);
      if (typeof o.onSelect === "function") o.onSelect(h);
    }

    function showOnMap(h) {
      resultLayer.clearLayers();
      const animate = !reduceMotion();
      const isArea = AREA_TYPES[h.typ] || (h.typ === "online" && h.bbox && (h.bbox[2] - h.bbox[0] > 0.002 || h.bbox[3] - h.bbox[1] > 0.003));
      if (isArea && h.bbox) {
        const b = L.latLngBounds([h.bbox[0], h.bbox[1]], [h.bbox[2], h.bbox[3]]);
        L.rectangle(b.pad(h.typ === "strasse" ? 0.15 : 0), { color: "#0b4f8a", weight: 3, dashArray: "8 6", fillOpacity: 0.06, interactive: false }).addTo(resultLayer);
        L.circleMarker([h.lat, h.lon], { radius: 7, color: "#fff", weight: 3, fillColor: "#0b4f8a", fillOpacity: 1, interactive: false }).addTo(resultLayer);
        const opt = { padding: [40, 40], maxZoom: h.typ === "strasse" ? 18 : 16, animate };
        if (animate) map.flyToBounds(b, opt); else map.fitBounds(b, opt);
      } else {
        const cls = h.typ === "rettungspunkt" ? "sx-pin sx-pin-rp" : "sx-pin";
        L.marker([h.lat, h.lon], { icon: L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [30, 42], iconAnchor: [15, 42] }), keyboard: false, interactive: false }).addTo(resultLayer);
        const z = Math.max(map.getZoom(), h.typ === "koordinate" ? 16 : 18);
        if (animate) map.flyTo([h.lat, h.lon], z); else map.setView([h.lat, h.lon], z);
      }
    }

    function hideCard() { card.hidden = true; card.innerHTML = ""; current = null; }

    function showCard(h) {
      const T = TYP[h.typ] || TYP.hinweis;
      const utm = Search.wgs84ToUtm(h.lat, h.lon, 32);
      const rows = [];
      if (h.typ === "rettungspunkt") {
        if (h.ortsbeschr) rows.push(`<div><b>Beschreibung:</b> ${esc(h.ortsbeschr)}</div>`);
        rows.push(`<div><b>Schild:</b> ${esc(h.schild || "–")} · <b>Urheber:</b> ${esc(h.urheber || "–")}</div>`);
        rows.push(rpStandHtml());
      }
      (h.warnungen || []).forEach((w) => rows.push(`<div class="sx-warn">${esc(w)}</div>`));
      if (h.hinweis) rows.push(`<div class="sx-warn">${esc(h.hinweis)}</div>`);
      if (h.qualitaet && h.qualitaet !== "A") rows.push(`<div class="sx-warn">Lagequalität „${esc(h.qualitaet)}“ laut Gebäudereferenz (Bedeutung zu prüfen)</div>`);
      const src = h.typ === "rettungspunkt" ? rpAttrHtml() + `. Angaben ohne Gewähr (<a href="${HAFTUNG_URL}" target="_blank" rel="noopener">Haftungsausschluss</a>).`
        : h.typ === "online" ? OSM_ATTR_HTML : esc(h.quelle || "");
      const ignLabel = AREA_TYPES[h.typ] ? "Als Zündpunkt setzen (Mittelpunkt)" : "Als Zündpunkt setzen";
      card.innerHTML = `<div class="sx-card-head"><span class="sx-ico">${T.icon}</span><div><div class="sx-card-title">${esc(h.label)}</div>
        <div class="sx-sub"><span class="sx-typ">${esc(T.name)}</span>${h.sub ? " · " + esc(h.sub) : ""}</div></div></div>
        <div class="sx-coord">${fmtDeg(h.lat, "N", "S")} · ${fmtDeg(h.lon, "O", "W")} · UTM 32N ${Math.round(utm.e)} ${Math.round(utm.n)}</div>
        ${rows.join("")}
        <div class="sx-src">Quelle: ${src}</div>
        <div class="sx-actions">
          ${typeof o.onIgnition === "function" ? `<button type="button" class="tool primary" id="sx-ign">${ignLabel}</button>` : ""}
          <button type="button" class="tool" id="sx-card-close">Schließen</button>
        </div>`;
      card.hidden = false;
      const ign = $("sx-ign");
      if (ign) ign.onclick = () => { o.onIgnition(h.lat, h.lon, h); hideCard(); };
      $("sx-card-close").onclick = () => { hideCard(); resultLayer.clearLayers(); input.focus(); };
    }

    return { run, select, close, resultLayer, get current() { return current; }, get items() { return items; } };
  }

  /**
   * Kartenebene "Rettungspunkte (KWF)": Marker ab minZoom, Nummer als Beschriftung ab labelZoom, Popup mit allen Angaben.
   * opt.obstacleSelector (0.5.0): CSS-Auswahl bereits vorhandener Kartenbeschriftungen (z. B. Fahrzeug-Label der App);
   * Nummern, die diese oder eine andere Nummer überdecken würden, werden ausgeblendet (Marker bleibt antippbar).
   */
  function rettungspunkteLayer(map, opt) {
    const L = root.L, Search = root.Search;
    const minZoom = (opt && opt.minZoom) || 13, labelZoom = (opt && opt.labelZoom) || 14;
    const obstacleSel = (opt && opt.obstacleSelector) || null;
    const grp = L.layerGroup([], { attribution: RP_ATTR_FALLBACK });
    let markers = null;
    const icon = L.divIcon({ className: "", html: '<div class="sx-rp-marker" aria-hidden="true"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    function popup(r) {
      const rows = [["Beschreibung", r.ortsbeschr], ["Schild", r.schild], ["Urheber", r.urheber], ["Bundesland", r.bundesland]]
        .filter((x) => x[1] != null && x[1] !== "").map((x) => `<div><b>${esc(x[0])}:</b> ${esc(x[1])}</div>`).join("");
      return `<div class="sx-rp-pop"><div class="sx-card-title">Rettungspunkt ${esc(r.nr)}</div>${rows}
        <div class="sx-coord">${fmtDeg(r.lat, "N", "S")} · ${fmtDeg(r.lon, "O", "W")}</div>${rpStandHtml()}
        <div class="sx-src">${rpAttrHtml()}. Ohne Gewähr (<a href="${HAFTUNG_URL}" target="_blank" rel="noopener">Haftungsausschluss</a>).</div></div>`;
    }
    function build() {
      if (markers) return;
      markers = Search.rettungspunkte().map((r) => {
        const m = L.marker([r.lat, r.lon], { icon, keyboard: false, title: "Rettungspunkt " + r.nr, alt: "Rettungspunkt " + r.nr });
        m.bindPopup(() => popup(r), { maxWidth: 300 });
        m.bindTooltip(esc(r.nr), { permanent: true, direction: "right", offset: [10, 0], className: "sx-rp-label", interactive: false });
        return m;
      });
    }
    function update() {
      if (!markers || !map.hasLayer(grp)) return;
      const z = map.getZoom();
      const b = map.getBounds().pad(0.3);
      map.getContainer().classList.toggle("sx-rp-nolabels", z < labelZoom);
      for (const m of markers) {
        const show = z >= minZoom && b.contains(m.getLatLng());
        if (show && !grp.hasLayer(m)) grp.addLayer(m);
        else if (!show && grp.hasLayer(m)) grp.removeLayer(m);
      }
      scheduleDeclutter(z);
    }

    /** Überdeckte Nummern ausblenden (nur Anzeige). Läuft im nächsten Frame, damit Leaflet die Tooltips gesetzt hat. */
    let pending = false;
    function scheduleDeclutter(z) {
      if (pending || !root.requestAnimationFrame) return;
      pending = true;
      root.requestAnimationFrame(() => { pending = false; try { declutter(z); } catch (e) { /* nur Anzeige */ } });
    }
    function declutter(z) {
      const els = [];
      grp.eachLayer((m) => {
        const tt = m.getTooltip && m.getTooltip(), el = tt && tt.getElement();
        if (el) { el.classList.remove("sx-rp-label-off"); els.push(el); }
      });
      if (z < labelZoom || !els.length) return;
      const placed = (obstacleSel ? [...map.getContainer().querySelectorAll(obstacleSel)] : [])
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      const hits = (r) => placed.some((q) => r.left < q.right + 2 && r.right > q.left - 2 && r.top < q.bottom + 2 && r.bottom > q.top - 2);
      const items = els.map((el) => ({ el, r: el.getBoundingClientRect() })).filter((it) => it.r.width > 0)
        .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
      for (const it of items) {
        if (hits(it.r)) it.el.classList.add("sx-rp-label-off");
        else placed.push(it.r);
      }
    }
    grp.on("add", () => {
      Search.ensureLoaded().then(() => {
        const html = rpAttrHtml();
        if (html !== grp.options.attribution && map.attributionControl) {
          map.attributionControl.removeAttribution(grp.options.attribution);
          grp.options.attribution = html;
          map.attributionControl.addAttribution(html);
        }
        build(); update();
        const i = Search.rpInfo();
        if (i && i.warnung && typeof (opt && opt.onWarn) === "function") opt.onWarn(i.warnung);
      }).catch(() => {});
      map.on("moveend zoomend", update);
    });
    grp.on("remove", () => { map.off("moveend zoomend", update); });
    grp.refresh = update;
    grp.count = () => (markers ? markers.length : 0);
    return grp;
  }

  const SearchUI = { init, rettungspunkteLayer, rpAttrHtml, OSM_ATTR_HTML };
  root.SearchUI = SearchUI;
  if (typeof module !== "undefined" && module.exports) module.exports = SearchUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
