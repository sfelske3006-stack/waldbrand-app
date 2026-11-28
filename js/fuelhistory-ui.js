/*
 * Modul Vorgeschichte/Trockenheit - Oberfläche (Bedienfeld, Trockenheitsampel, Kurzdiagramm, Kennzahlen).
 * Entwurf 0.1.0, passend zu js/fuelhistory.js. KEINE zusätzliche Abhängigkeit (Canvas 2D, kein CDN).
 *
 * MODELLPROGNOSE MIT ANNAHMEN. Die Trockenheitsampel ist KEINE amtliche Waldbrandgefahrenstufe
 * (der DWD-Waldbrandgefahrenindex WBI ist nicht angebunden).
 *
 * Verwendung:
 *   const ui = FuelHistoryUI.create({
 *     panel: document.getElementById("vorgeschichte-panel"),
 *     FP: PARAMS.vorgeschichte,
 *     onChange: (opt) => { ... },   // {enabled, pastDays, manual} - Rechnung neu anstoßen
 *     onLoad: () => { ... },        // Knopf "Vorgeschichte laden"
 *   });
 *   ui.setState(FuelHistory.compute({...}));
 *
 * Dark/Light über die Variablen aus css/app.css (css/fuelhistory.css ergänzt nur eigene Farben).
 */
(function (root) {
  "use strict";

  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const nf = (v, d) => (isNum(v) ? Number(v).toLocaleString("de-DE", { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d }) : "–");
  const css = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  };
  const AMPEL_TEXT = { gruen: "grün", gelb: "gelb", rot: "rot", unbekannt: "unbekannt" };

  function create(opts) {
    const panel = opts.panel;
    const FP = opts.FP || root.FUELHISTORY_PARAMS;
    const FH = root.FuelHistory;
    if (!panel) throw new Error("FuelHistoryUI: panel fehlt");
    const listeners = { change: [], load: [] };
    if (opts.onChange) listeners.change.push(opts.onChange);
    if (opts.onLoad) listeners.load.push(opts.onLoad);
    // Startzustand: Vorgaben aus den Parametern, überschrieben von den gespeicherten Einstellungen
    // des Bedieners (opts.options, in js/app.js aus localStorage "wb_fh_opt"). ABWEICHUNG zum
    // Modulentwurf: dort war der Startzustand immer FP.enabled/FP.abruf.pastDaysDefault.
    const o0 = opts.options || {};
    const clampDays = (v) => Math.max(FP.abruf.pastDaysMin, Math.min(FP.abruf.pastDaysMax, Math.round(v)));
    const state = {
      st: null,
      enabled: typeof o0.enabled === "boolean" ? o0.enabled : FP.enabled,
      pastDays: Number.isFinite(o0.pastDays) ? clampDays(o0.pastDays) : FP.abruf.pastDaysDefault,
      manual: o0.manual ? { ...o0.manual } : {},
      manualOn: !!o0.manual,
    };

    // ---------------------------------------------------------------- Markup
    panel.classList.add("fh-ui");
    panel.innerHTML = `
      <p class="fh-disclaimer" role="note">Wettervorgeschichte und Dürre-Indikatoren mit <b>Annahmen</b>, unvalidiert.
        <b>Keine amtliche Waldbrandgefahrenstufe</b> (DWD-Waldbrandgefahrenindex ist nicht angebunden).</p>

      <div class="fh-card">
        <div class="fh-row">
          <label class="fh-check"><input type="checkbox" id="fh-on"> <span>Vorgeschichte einbeziehen</span></label>
          <label class="fh-sel">Vortage
            <select id="fh-days">
              <option value="30">30 Tage</option>
              <option value="40">40 Tage</option>
              <option value="50">50 Tage</option>
              <option value="60">60 Tage (Vorgabe)</option>
            </select>
          </label>
          <button type="button" class="fh-btn" id="fh-load">Vorgeschichte laden</button>
        </div>
        <p class="fh-small" id="fh-src">Noch keine Vorgeschichte geladen.</p>
      </div>

      <div class="fh-card">
        <div class="fh-ampel" id="fh-ampel" role="status" aria-live="polite">
          <span class="fh-dot" id="fh-dot" aria-hidden="true"></span>
          <span class="fh-ampel-txt" id="fh-ampel-txt">Trockenheit: unbekannt</span>
        </div>
        <p class="fh-small" id="fh-ampel-src"></p>
      </div>

      <div class="fh-card">
        <h4>Niederschlag und Brennstofffeuchte (<span id="fh-chart-days">60</span> Tage)</h4>
        <div class="fh-chartwrap"><canvas id="fh-chart" role="img" aria-label="Diagramm wird geladen"></canvas></div>
        <ul class="fh-legend" id="fh-legend">
          <li><span class="fh-sw fh-sw-rain"></span>Niederschlag (mm/Tag)</li>
          <li><span class="fh-sw fh-sw-d1"></span>Feuchte 1 h (%)</li>
          <li><span class="fh-sw fh-sw-d10"></span>10 h</li>
          <li><span class="fh-sw fh-sw-d100"></span>100 h</li>
          <li><span class="fh-sw fh-sw-last7"></span>letzte 7 Tage (hervorgehoben)</li>
        </ul>
      </div>

      <details class="fh-card fh-det" id="fh-kpi-box">
        <summary><h4>Kennzahlen und Rechenweg</h4></summary>
        <table class="fh-tab" id="fh-kpi"><tbody></tbody></table>
        <p class="fh-small" id="fh-kpi-note"></p>
      </details>

      <details class="fh-card fh-det" id="fh-man-box">
        <summary><h4>Manuelle Ersatzeingabe</h4></summary>
        <p class="fh-small">Nur nötig, wenn kein Wetterabruf möglich ist. Erzeugt eine <b>synthetische</b> Vorgeschichte aus wenigen Angaben.</p>
        <label class="fh-check"><input type="checkbox" id="fh-man-on"> <span>Ersatzeingabe verwenden</span></label>
        <div class="fh-grid" id="fh-man-fields">
          <label>Tage seit Regen ≥ 1 mm<input type="number" id="fh-man-d1" min="0" max="120" step="1" inputmode="numeric"></label>
          <label>Tage seit Regen ≥ 5 mm<input type="number" id="fh-man-d5" min="0" max="120" step="1" inputmode="numeric"></label>
          <label>Regen letzte 7 Tage (mm)<input type="number" id="fh-man-r7" min="0" max="500" step="0.1" inputmode="decimal"></label>
          <label>Regen letzte 30 Tage (mm)<input type="number" id="fh-man-r30" min="0" max="2000" step="0.1" inputmode="decimal"></label>
          <label>Temperatur mittags (°C)<input type="number" id="fh-man-t" min="-20" max="45" step="0.5" inputmode="decimal"></label>
          <label>rel. Feuchte mittags (%)<input type="number" id="fh-man-rh" min="1" max="100" step="1" inputmode="numeric"></label>
        </div>
      </details>

      <div id="fh-msgs" aria-live="polite"></div>
    `;

    const $ = (id) => panel.querySelector(`#${id}`);
    const chart = $("fh-chart");
    const emit = (name, arg) => { for (const f of listeners[name]) { try { f(arg); } catch (e) { console.error(e); } } };

    // ---------------------------------------------------------------- Bedienung
    $("fh-on").checked = !!state.enabled;
    $("fh-days").value = String(state.pastDays);
    if (!$("fh-days").value) { state.pastDays = FP.abruf.pastDaysDefault; $("fh-days").value = String(state.pastDays); }
    $("fh-man-on").checked = !!state.manualOn;
    // ABWEICHUNG zum Modulentwurf: Kennzahlen und Ersatzeingabe stehen in <details>, damit der
    // Abschnitt in der 360-440 px breiten Seitenleiste nicht über 2.700 px hoch wird (gemessen).
    if (state.manualOn) $("fh-man-box").open = true;
    for (const [id, key] of [["fh-man-d1", "tageSeitRegen1mm"], ["fh-man-d5", "tageSeitRegen5mm"], ["fh-man-r7", "regen7Tage"], ["fh-man-r30", "regen30Tage"], ["fh-man-t", "tempC"], ["fh-man-rh", "rh"]]) {
      if (isNum(state.manual[key])) $(id).value = String(state.manual[key]);
    }
    $("fh-on").addEventListener("change", () => { state.enabled = $("fh-on").checked; emit("change", options()); });
    $("fh-days").addEventListener("change", () => { state.pastDays = Number($("fh-days").value); emit("change", options()); });
    $("fh-load").addEventListener("click", () => emit("load", options()));
    $("fh-man-on").addEventListener("change", () => { state.manualOn = $("fh-man-on").checked; syncManual(); emit("change", options()); });
    for (const [id, key] of [["fh-man-d1", "tageSeitRegen1mm"], ["fh-man-d5", "tageSeitRegen5mm"], ["fh-man-r7", "regen7Tage"], ["fh-man-r30", "regen30Tage"], ["fh-man-t", "tempC"], ["fh-man-rh", "rh"]]) {
      $(id).addEventListener("change", () => {
        const v = $(id).value.trim();
        if (v === "") delete state.manual[key]; else state.manual[key] = Number(v);
        emit("change", options());
      });
    }
    function syncManual() {
      for (const id of ["fh-man-d1", "fh-man-d5", "fh-man-r7", "fh-man-r30", "fh-man-t", "fh-man-rh"]) $(id).disabled = !state.manualOn;
      $("fh-man-fields").classList.toggle("fh-off", !state.manualOn);
    }
    syncManual();
    function options() {
      return { enabled: state.enabled, pastDays: state.pastDays, manual: state.manualOn ? { ...state.manual } : null };
    }

    // ---------------------------------------------------------------- Diagramm (Canvas 2D)
    /**
     * Zeichnet Niederschlagsbalken (obere Hälfte, nach unten) und die Feuchtelinien (untere Hälfte).
     * Die letzten FP.abruf.hervorhebenTage Tage sind farblich hervorgehoben und mit Trennlinie markiert.
     */
    function draw() {
      const st = state.st;
      const wrap = chart.parentElement;
      const cssW = Math.max(FP.ui.diagrammMinBreite, wrap.clientWidth || FP.ui.diagrammMinBreite);
      const cssH = FP.ui.diagrammHoehe;
      const dpr = Math.min(3, (root.devicePixelRatio || 1));
      chart.width = Math.round(cssW * dpr);
      chart.height = Math.round(cssH * dpr);
      chart.style.width = cssW + "px";
      chart.style.height = cssH + "px";
      const g = chart.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cssW, cssH);
      const ink = css("--ink", "#111820"), line = css("--line", "#c3ccd5"), muted = css("--muted", "#4a5662");
      const cRain = css("--fh-rain", "#2b7cd3"), c1 = css("--fh-d1", "#b3261e"), c10 = css("--fh-d10", "#c77b16"), c100 = css("--fh-d100", "#1d6b3a");
      const cHi = css("--fh-last7", "rgba(179,38,30,0.10)");
      const padL = 46, padR = 14, padT = 12, padB = 18;
      const w = cssW - padL - padR, h = cssH - padT - padB;
      const gap = 24;
      const hRain = Math.round((h - gap) * 0.36), hM = h - gap - hRain;
      g.font = `11px ${css("--font", "system-ui, sans-serif")}`;
      g.textBaseline = "middle";

      if (!st || !st.active || !st.fwi || !st.fwi.days.length) {
        g.fillStyle = muted;
        g.textAlign = "center";
        g.fillText(st && !st.enabled ? "Vorgeschichte ausgeschaltet" : "keine Vorgeschichte geladen", cssW / 2, cssH / 2);
        chart.setAttribute("aria-label", st && !st.enabled ? "Diagramm leer: Vorgeschichte ausgeschaltet" : "Diagramm leer: keine Vorgeschichte geladen");
        return;
      }
      const days = st.fwi.days;
      const n = days.length;
      const x = (i) => padL + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
      // Tagesfeuchte: Mittagswert der stündlichen Reihe (nächster Stundenwert zum Mittag)
      const dead = dailyDead(st, days);
      const hi = Math.max(0, n - (FP.abruf.hervorhebenTage || 7));

      // Hervorhebung der letzten Tage (Vorgabe: 7)
      g.fillStyle = cHi;
      g.fillRect(x(hi), padT, cssW - padR - x(hi), h);
      g.strokeStyle = line; g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(x(hi)) + 0.5, padT); g.lineTo(Math.round(x(hi)) + 0.5, padT + h); g.stroke();
      g.setLineDash([]);

      // ---- Niederschlagsbalken (von oben nach unten)
      const maxMm = Math.max(1, FP.ui.maxBalkenMm);
      const bw = Math.max(1.5, Math.min(8, w / Math.max(1, n) - 1));
      g.fillStyle = cRain;
      let abgeschnitten = 0;
      for (let i = 0; i < n; i++) {
        const mm = days[i].r24 || 0;
        if (mm <= 0) continue;
        if (mm > maxMm) abgeschnitten++;
        const bh = Math.max(1.5, Math.min(1, mm / maxMm) * hRain);
        g.fillRect(x(i) - bw / 2, padT, bw, bh);
      }
      g.strokeStyle = line;
      g.beginPath(); g.moveTo(padL, padT + 0.5); g.lineTo(cssW - padR, padT + 0.5); g.stroke();
      // Grundlinie der Niederschlagsachse (gestrichelt), damit die Beschriftung eindeutig zugeordnet ist
      g.globalAlpha = 0.5; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(padL, padT + hRain + 0.5); g.lineTo(cssW - padR, padT + hRain + 0.5); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = muted; g.textAlign = "right";
      g.fillText("0", padL - 5, padT + 2);
      g.fillText(`${maxMm} mm`, padL - 5, padT + hRain);
      if (abgeschnitten) {
        g.textAlign = "left"; g.fillStyle = ink;
        g.fillText(`${abgeschnitten}× > ${maxMm} mm`, padL + 4, padT + hRain - 5);
      }

      // ---- Feuchtelinien (eigene Skala, auf 10er aufgerundet)
      const yM0 = padT + hRain + gap;
      let maxV = 0;
      for (const d of dead) if (d) maxV = Math.max(maxV, d.d1, d.d10, d.d100);
      const maxM = Math.min(FP.ui.feuchteSkalaMax, Math.max(20, Math.ceil((maxV + 2) / 10) * 10));
      const yM = (v) => yM0 + hM - (Math.min(maxM, Math.max(0, v)) / maxM) * hM;
      g.strokeStyle = line;
      g.beginPath(); g.moveTo(padL, yM0 + hM + 0.5); g.lineTo(cssW - padR, yM0 + hM + 0.5); g.stroke();
      g.fillStyle = muted; g.textAlign = "right";
      g.fillText("0", padL - 5, yM0 + hM);
      for (let v = 10; v <= maxM; v += 10) {
        g.strokeStyle = line; g.globalAlpha = 0.45;
        g.beginPath(); g.moveTo(padL, Math.round(yM(v)) + 0.5); g.lineTo(cssW - padR, Math.round(yM(v)) + 0.5); g.stroke();
        g.globalAlpha = 1; g.fillStyle = muted; g.textAlign = "right";
        g.fillText(String(v), padL - 5, yM(v));
      }
      for (const [k, col] of [["d100", c100], ["d10", c10], ["d1", c1]]) {
        if (FP.ui.zeigeKlassen.indexOf(k) < 0) continue;
        g.strokeStyle = col; g.lineWidth = k === "d1" ? 2 : 1.5;
        g.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = dead[i] ? dead[i][k] : null;
          if (!isNum(v)) continue;
          if (!started) { g.moveTo(x(i), yM(v)); started = true; } else g.lineTo(x(i), yM(v));
        }
        g.stroke();
      }

      // ---- Zeitachse: erster Tag, Beginn der hervorgehobenen Tage, heute
      g.fillStyle = muted; g.lineWidth = 1;
      const yT = cssH - padB / 2 + 1;
      g.textAlign = "left"; g.fillText(kurzDatum(days[0].ymd), padL - 6, yT);
      g.textAlign = "right"; g.fillText("heute", cssW - padR, yT);
      const xHi = x(hi);
      if (n > 10 && cssW - padR - xHi > 62 && xHi - padL > 46) {
        g.textAlign = "center"; g.fillText(kurzDatum(days[hi].ymd), xHi, yT);
      }
      chart.setAttribute("aria-label", chartSummary(st, days, dead));
    }
    const kurzDatum = (ymd) => (ymd ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.` : "");

    /** Tagesweise Feuchte (Mittagswert der Stundenreihe) für das Diagramm. */
    function dailyDead(st, days) {
      const out = [];
      const series = st.dead ? st.dead.series : [];
      let k = 0;
      for (const d of days) {
        while (k + 1 < series.length && series[k + 1].t <= d.tMid) k++;
        const s = series[k];
        out.push(s ? { d1: s.d1, d10: s.d10, d100: s.d100 } : null);
      }
      return out;
    }
    function chartSummary(st, days, dead) {
      const last = dead[dead.length - 1] || {};
      const s7 = st.stats && st.stats.summen[7] ? st.stats.summen[7].mm : null;
      return `Diagramm: ${days.length} Tage Niederschlag und tote Brennstofffeuchte. `
        + `Letzte 7 Tage ${nf(s7, 1)} mm Regen. Aktuell 1-h-Feuchte ${nf(last.d1, 1)} %, `
        + `10-h ${nf(last.d10, 1)} %, 100-h ${nf(last.d100, 1)} %.`;
    }

    // ---------------------------------------------------------------- Kennzahlen
    function renderKpi() {
      const st = state.st;
      const tb = $("fh-kpi").querySelector("tbody");
      if (!st || !st.active) {
        tb.innerHTML = `<tr><td colspan="2" class="fh-small">${st && !st.enabled ? "Vorgeschichte ausgeschaltet: Feuchte wie bisher (Gleichgewichtsfeuchte + Regenzuschlag)." : "Keine Vorgeschichte."}</td></tr>`;
        $("fh-kpi-note").textContent = "";
        return;
      }
      const f = st.fwi.last || {};
      const S = st.stats;
      const d = st.dead.current;
      const sch = FP.ampel.regenSchwellenMm;
      const rowsHtml = [];
      const row = (k, v, cls) => rowsHtml.push(`<tr class="${cls || ""}"><th scope="row">${k}</th><td>${v}</td></tr>`);
      for (const s of sch) {
        const r = S.tageSeitRegen[s];
        row(`Tage seit Regen ≥ ${s} mm`, r ? (r.mindestens ? `≥ ${r.tage} (im Fenster kein Regen)` : nf(r.tage)) : "–");
      }
      for (const w of FP.ampel.summenTage) {
        const su = S.summen[w];
        row(`Niederschlag ${w} Tage`, su ? `${nf(su.mm, 1)} mm${su.vollstaendig ? "" : ` <span class="fh-small">(nur ${su.tage} Tage)</span>`}` : "–");
      }
      row("längste Trockenstrecke", `${nf(S.maxTrockenstrecke)} Tage`, "fh-sep");
      row("Feuchte 1 h / 10 h / 100 h", `${nf(d.d1, 1)} / ${nf(d.d10, 1)} / ${nf(d.d100, 1)} %`, "fh-sep");
      row("Feuchte FFMC-Schicht (Gegenprobe)", `${nf(st.ffmcFeuchte, 1)} %`);
      row("Lebendfeuchte Kraut / Gehölz (Annahme)", `${nf(st.live.lh)} / ${nf(st.live.lw)} %`);
      row("FFMC", nf(f.ffmc, 1), "fh-sep");
      row("DMC", nf(f.dmc, 1));
      row("DC", nf(f.dc, 1));
      row("ISI", nf(f.isi, 1));
      row("BUI", nf(f.bui, 1));
      row("FWI", `<b>${nf(f.fwi, 1)}</b>`);
      const cf = st.coupling || {};
      row("Dürre-Anteil (Kopplung)", `${nf((cf.duerreAnteil || 0) * 100)} % aus ${esc((cf.quelle || "bui").toUpperCase())}`, "fh-sep");
      row("Faktor Reaktionsintensität / Beladung", `${nf(cf.irFaktor, 2)} / ${cf.last ? nf(cf.last.w10, 2) : "–"}`);
      row("vergilbter Krautanteil als Totbrennstoff", `${nf((cf.curingAnteil || 0) * 100)} %`);
      row("Ensemble-Spannweite Feuchte", `× ${nf(cf.ensembleFaktor, 2)}`);
      tb.innerHTML = rowsHtml.join("");
      $("fh-kpi-note").innerHTML = `FWI-System nach Van Wagner (1987), Mittagswerte 12 Uhr Lokalzeit, Tageslängenfaktoren für ${nf(FP.fwi.lat, 1)}° N, `
        + `Startwerte FFMC ${FP.fwi.startFFMC} / DMC ${FP.fwi.startDMC} / DC ${FP.fwi.startDC} vor ${nf(st.pastDaysGenutzt, 0)} Tagen Vorlauf. `
        + `Gegen <code>xclim</code> geprüft. Feuchtemodell und Kopplung sind Annahmen (siehe Grenzen &amp; Quellen).`;
    }

    // ---------------------------------------------------------------- Ampel, Quelle, Meldungen
    function renderAmpel() {
      const st = state.st;
      const lv = st && st.active ? st.level : null;
      const dot = $("fh-dot"), txt = $("fh-ampel-txt");
      const amp = lv ? lv.ampel : "unbekannt";
      dot.className = `fh-dot fh-${amp}`;
      txt.innerHTML = lv
        ? `Trockenheit: <b>${esc(AMPEL_TEXT[amp])}</b> – FWI ${nf(lv.fwi, 1)} (${esc(lv.label)})`
        : `Trockenheit: <b>unbekannt</b>${st && !st.enabled ? " (Vorgeschichte aus)" : ""}`;
      $("fh-ampel").setAttribute("data-ampel", amp);
      const extra = lv && lv.hinweise.length ? ` ${lv.hinweise.map(esc).join(" · ")}` : "";
      $("fh-ampel-src").innerHTML = (lv ? esc(lv.quelle) : "Keine Bewertung möglich.") + extra;
    }
    function renderSource() {
      const st = state.st;
      if (!st) { $("fh-src").textContent = "Noch keine Vorgeschichte geladen."; return; }
      const parts = [];
      parts.push(`Quelle: <b>${esc(st.source)}</b>`);
      if (st.fetchedAt) parts.push(`abgerufen ${new Date(st.fetchedAt).toLocaleString("de-DE")}`);
      if (st.active) parts.push(`${nf(st.hours)} Stundenwerte, ${nf(st.fwiTage)} Mittagswerte, ${nf(st.pastDaysGenutzt, 1)} Tage`);
      if (st.attribution) parts.push(esc(st.attribution));
      $("fh-src").innerHTML = parts.join(" · ");
      $("fh-chart-days").textContent = st.active ? nf(Math.round(st.pastDaysGenutzt)) : nf(state.pastDays);
    }
    function renderMsgs() {
      const st = state.st;
      const box = $("fh-msgs");
      if (!st) { box.innerHTML = ""; return; }
      const items = [];
      if (!st.enabled) items.push(["warn", "Schalter „Vorgeschichte einbeziehen“ ist AUS: Ergebnis wie ohne dieses Modul (Vergleichsrechnung)."]);
      else if (!st.active) items.push(["err", "Keine Wettervorgeschichte: Dürre-Indikatoren fehlen. Ergebnis wie bisher, Ensemble-Band verbreitert. Manuelle Ersatzeingabe nutzen."]);
      if (st.kind === "manuell") items.push(["warn", "Vorgeschichte aus manueller Ersatzeingabe (synthetisch)."]);
      if (st.kind === "demo") items.push(["warn", "Synthetisches Demo-Szenario – kein echtes Wetter."]);
      for (const w of st.warnings || []) items.push(["warn", w]);
      for (const nte of st.notes || []) items.push(["info", nte]);
      for (const b of (st.coupling && st.coupling.begrenzt) || []) items.push(["info", `Begrenzt: ${b}`]);
      box.innerHTML = items.map(([k, t]) => `<p class="fh-msg fh-${k}" role="${k === "err" ? "alert" : "note"}">${esc(t)}</p>`).join("");
    }

    // ---------------------------------------------------------------- API
    function setState(st) {
      state.st = st;
      if (st && typeof st.enabled === "boolean") { state.enabled = st.enabled; $("fh-on").checked = st.enabled; }
      renderSource(); renderAmpel(); renderKpi(); renderMsgs(); draw();
    }
    function setBusy(text) {
      $("fh-src").textContent = text || "Lade Vorgeschichte …";
    }
    /** Textbaustein für den Modellgrenzen-Dialog (js/app.js LIMITS_HTML). */
    function limitsHtml() {
      return `<li><b>Wettervorgeschichte/Trockenheit nur vereinfacht</b> (Schalter „Vorgeschichte einbeziehen“):
        ${FP.abruf.pastDaysDefault} Tage Punktwetter von Open-Meteo (ein Modellgitterpunkt, keine Messung am Brandort).
        Die tote Brennstofffeuchte (1 h / 10 h / 100 h) wird stündlich mit Gleichgewichtsfeuchte (Simard 1968) und
        exponentieller Annäherung fortgeschrieben; die <b>Regenbenetzung ist eine eigene Annahme</b>, die Lebendfeuchte
        eine <b>Jahreszeit-Annahme</b> (keine Messung). Das FWI-System (Van Wagner 1987) liefert FFMC/DMC/DC/BUI/FWI;
        die <b>Trockenheitsampel ist keine amtliche Waldbrandgefahrenstufe</b> (DWD-WBI nicht angebunden) und die
        FWI-Klassengrenzen sind nicht aus der Primärquelle geprüft. Der Dürre-Effekt auf Brennstoffmenge bzw.
        Reaktionsintensität und auf die Ensemble-Spannweite ist eine <b>begrenzte Annahme</b>
        (höchstens Faktor ${nf(FP.kopplung.duerre.maxIrFaktor, 2)} bzw. ${nf(FP.kopplung.duerre.maxLastFaktor, 2)}).
        Kein Bodenwassermodell, keine Schneedecke, keine Überwinterung des DC, keine Grundwasser-/Quellbedingungen.
        Die Feuchtekorrektur nach Hangexposition (Geländewind) wirkt <b>zusätzlich und danach</b>.</li>`;
    }
    function on(name, fn) { if (listeners[name]) listeners[name].push(fn); }

    // Neu zeichnen bei Größenänderung und Hell/Dunkel-Wechsel
    let raf = 0;
    const redraw = () => { if (raf) return; raf = root.requestAnimationFrame(() => { raf = 0; draw(); }); };
    if (root.addEventListener) root.addEventListener("resize", redraw);
    try {
      const mq = root.matchMedia("(prefers-color-scheme: dark)");
      if (mq && mq.addEventListener) mq.addEventListener("change", redraw);
    } catch { /* ohne matchMedia */ }
    draw();

    return { setState, setBusy, draw, redraw, limitsHtml, on, options, getOptions: options, panel };
  }

  const FuelHistoryUI = { create };
  root.FuelHistoryUI = FuelHistoryUI;
  if (typeof module !== "undefined" && module.exports) module.exports = FuelHistoryUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
