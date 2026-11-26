/*
 * Bedienteil der Karten-Interaktion: Windpfeil auf der Karte, Zeitplan, Fortschritt/Abbruch,
 * Szenario-Vergleich A/B. Klassisches Skript, globales Objekt `InteraktionUI`, kein ES-Import,
 * keine CDN-Abhängigkeit. Rechnen tut dieses Modul nicht – es ruft `Windrose` (js/windrose.js),
 * `VehicleDrag` (js/vehicle-drag.js) und den vorhandenen Kern (FireModel, Suggest, …) auf.
 *
 * BEDIENVARIANTE (Entscheidung, siehe ASSUMPTIONS.md):
 *   Drehen = Ziehen am Pfeilkopf (Maus, Touch, Stift – ein Codeweg über Pointer Events).
 *   Stärke = EIGENER großer Regler unter dem Pfeil (Vorgabe), weil das gleichzeitige Ändern von
 *   Richtung und Stärke über den Ziehradius auf dem Tablet mit Handschuhen zwei Werte auf einmal
 *   verstellt. Der Radiusmodus ist als Schalter „Stärke beim Ziehen mitändern“ weiterhin vorhanden
 *   (Vorgabe: aus) und rechnet mit Windrose.kmhFromRadius().
 */
(function (root) {
  "use strict";

  const W = () => root.Windrose;
  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const numDe = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "–" : Number(v).toLocaleString("de-DE", { maximumFractionDigits: d }));

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svgEl = (name, attrs) => {
    const e = root.document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  };

  /**
   * Windpfeil als Bedienelement über der Karte.
   * opt: {parent, P, getBase() -> {windKmh, windDirDeg, gustKmh}, onChange(ov, meta), onReset(), onSchedule(ov)}
   * Rückgabe: {el, set(ov), setBase(b), value(), destroy()}
   */
  function windControl(opt = {}) {
    const doc = root.document;
    const P = opt.P || root.PARAMS;
    const p = W().params(P);
    const parent = opt.parent || doc.body;

    const box = doc.createElement("div");
    box.className = "wb-wind";
    box.innerHTML = `
      <div class="wb-wind-head">
        <b>Wind (Bedienung)</b>
        <span class="wb-wind-flag" id="wb-wind-flag" data-on="0">manuell überschrieben</span>
      </div>
      <div class="wb-wind-dial">
        <svg class="wb-wind-svg" id="wb-wind-svg" width="176" height="176" viewBox="-88 -88 176 176"
             role="slider" tabindex="0" aria-label="Windrichtung, Richtung aus der der Wind weht"
             aria-valuemin="0" aria-valuemax="359" aria-valuenow="0" aria-valuetext="–"></svg>
      </div>
      <label class="wb-wind-speed">Windstärke
        <input id="wb-wind-kmh" type="range" min="0" max="${p.maxKmh}" step="${p.snapKmh}" value="0"
               aria-label="Windstärke in Kilometer pro Stunde">
        <output id="wb-wind-kmh-out">–</output>
      </label>
      <label class="wb-wind-check"><input type="checkbox" id="wb-wind-radius"> Stärke beim Ziehen mitändern (Radius)</label>
      <label class="wb-wind-check"><input type="checkbox" id="wb-wind-fine"> Feinmodus (1°, 0,5 km/h)</label>
      <p class="wb-wind-label" id="wb-wind-label">–</p>
      <div class="wb-wind-btns">
        <button type="button" class="btn small" id="wb-wind-schedule">Zeitplan …</button>
        <button type="button" class="btn small danger" id="wb-wind-reset" disabled>Zurück auf echtes Wetter</button>
      </div>
      <div class="wb-wind-progress" id="wb-wind-progress" hidden>
        <div class="bar"></div><span class="ptext"></span>
        <button type="button" class="btn small" id="wb-wind-abort">Abbrechen</button>
      </div>
      <p class="wb-wind-note muted small" title="Tastatur: Pfeiltasten Richtung/Stärke, Umschalt = fein, Bild auf/ab = 45°, Pos1/Ende = 0/Maximum, 0 = echtes Wetter">Richtung = Richtung, AUS der der Wind weht; der Pfeil zeigt in Strömungsrichtung. Tastatur: Pfeiltasten, Umschalt = fein, 0 = echtes Wetter.</p>`;
    parent.appendChild(box);

    const $ = (id) => box.querySelector(`#${id}`);
    const svg = $("wb-wind-svg");
    const slider = $("wb-wind-kmh");
    const out = $("wb-wind-kmh-out");
    const flag = $("wb-wind-flag");
    const labelEl = $("wb-wind-label");
    const resetBtn = $("wb-wind-reset");
    const fineChk = $("wb-wind-fine");
    const radiusChk = $("wb-wind-radius");
    const prog = $("wb-wind-progress");

    let base = (opt.getBase && opt.getBase()) || { windDirDeg: 0, windKmh: 0, gustKmh: null };
    let ov = W().emptyOverride();

    const effective = () => ({
      dirDeg: ov.dirDeg !== null && ov.dirDeg !== undefined ? ov.dirDeg : (base.windDirDeg ?? 0),
      kmh: ov.kmh !== null && ov.kmh !== undefined ? ov.kmh : (base.windKmh ?? 0),
      gustKmh: ov.gustKmh !== null && ov.gustKmh !== undefined ? ov.gustKmh : (base.gustKmh ?? null),
    });

    function draw() {
      const e = effective();
      const geo = W().arrowGeometry({ dirDeg: e.dirDeg, kmh: e.kmh, radiusPx: p.radiusPx, maxKmh: p.maxKmh, minLenPx: p.minLenPx });
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.appendChild(svgEl("circle", { r: p.radiusPx, cx: 0, cy: 0, class: "wb-wind-ring" }));
      for (let a = 0; a < 360; a += 45) {
        const rad = (a * Math.PI) / 180;
        const x1 = Math.sin(rad) * (p.radiusPx - 10), y1 = -Math.cos(rad) * (p.radiusPx - 10);
        const x2 = Math.sin(rad) * p.radiusPx, y2 = -Math.cos(rad) * p.radiusPx;
        svg.appendChild(svgEl("line", { x1, y1, x2, y2, class: "wb-wind-tick" }));
      }
      const t = svgEl("text", { x: 0, y: -p.radiusPx + 16, class: "wb-wind-n", "text-anchor": "middle" });
      t.textContent = "N";
      svg.appendChild(t);
      svg.appendChild(svgEl("line", { x1: geo.tail.x, y1: geo.tail.y, x2: geo.head.x, y2: geo.head.y, class: "wb-wind-shaft" }));
      svg.appendChild(svgEl("polygon", { points: `${geo.head.x},${geo.head.y} ${geo.wings[0].x},${geo.wings[0].y} ${geo.wings[1].x},${geo.wings[1].y}`, class: "wb-wind-headtri" }));
      // Ziehpunkt am Pfeilkopf: mindestens 52 px Trefferfläche (Tablet, Handschuhe)
      svg.appendChild(svgEl("circle", { cx: geo.head.x, cy: geo.head.y, r: 26, class: "wb-wind-knob" }));
      const lbl = W().label({ dirDeg: e.dirDeg, kmh: e.kmh, gustKmh: e.gustKmh });
      const aria = W().ariaLabel({ dirDeg: e.dirDeg, kmh: e.kmh, gustKmh: e.gustKmh });
      svg.setAttribute("aria-valuenow", String(Math.round(W().norm(e.dirDeg))));
      svg.setAttribute("aria-valuetext", `${aria}${W().isManual(ov) ? ", manuell überschrieben" : ", echtes Wetter"}`);
      labelEl.textContent = `${lbl}${W().isManual(ov) ? " (manuell)" : ""}`;
      slider.value = String(Math.round(e.kmh * 2) / 2);
      out.textContent = `${numDe(e.kmh, 1)} km/h`;
      const manual = W().isManual(ov);
      // Platz bleibt immer reserviert: sonst verschiebt sich der Drehpunkt mitten im Ziehen.
      flag.setAttribute("data-on", manual ? "1" : "0");
      flag.setAttribute("aria-hidden", manual ? "false" : "true");
      box.classList.toggle("manual", manual);
      resetBtn.disabled = !manual;
    }

    function fire(meta) {
      draw();
      if (opt.onChange) opt.onChange({ ...ov }, meta || {});
    }

    // ---- Ziehen (Maus/Touch/Stift über Pointer Events)
    let dragging = false;
    function pointerAngle(ev) {
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const scale = r.width / 176; // SVG-Einheiten pro Pixel
      const d = W().dirFromPointer({ cx, cy, x: ev.clientX, y: ev.clientY });
      return d ? { ...d, radiusSvg: d.radiusPx / (scale || 1) } : null;
    }
    function onDown(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      const a = pointerAngle(ev);
      if (!a || a.radiusPx < 6) return;
      ev.preventDefault();
      dragging = true;
      try { svg.setPointerCapture(ev.pointerId); } catch { /* ohne Capture weiter */ }
      svg.classList.add("dragging");
      onMove(ev);
    }
    function onMove(ev) {
      if (!dragging) return;
      ev.preventDefault();
      const a = pointerAngle(ev);
      if (!a) return;
      const fine = fineChk.checked || ev.shiftKey;
      // Der Pfeil zeigt in Strömungsrichtung; angegeben wird die Richtung, AUS der der Wind kommt.
      ov = W().setDirection(ov, a.fromDeg, { fine, ...p });
      if (radiusChk.checked) ov = W().setSpeed(ov, W().kmhFromRadius(a.radiusSvg, p), { fine, ...p });
      draw();
      if (opt.onInput) opt.onInput({ ...ov });
    }
    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      try { svg.releasePointerCapture(ev.pointerId); } catch { /* egal */ }
      svg.classList.remove("dragging");
      fire({ grund: "ziehen", quelle: radiusChk.checked ? "pfeil+radius" : "pfeil" });
    }
    svg.style.touchAction = "none";
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);

    svg.addEventListener("keydown", (ev) => {
      const e = effective();
      const r = W().keyAdjust({ dirDeg: e.dirDeg, kmh: e.kmh }, ev.key, { ...p, shift: ev.shiftKey });
      if (!r.handled) return;
      ev.preventDefault();
      if (r.reset) { ov = W().clearOverride(); fire({ grund: "tastatur", quelle: "zurueck" }); return; }
      if (r.action === "richtung") ov = W().setDirection(ov, r.dirDeg, { fine: ev.shiftKey, ...p });
      else ov = W().setSpeed(ov, r.kmh, { fine: ev.shiftKey, ...p });
      fire({ grund: "tastatur", quelle: "pfeil" });
    });

    slider.addEventListener("input", () => { ov = W().setSpeed(ov, Number(slider.value), { fine: fineChk.checked, ...p }); draw(); if (opt.onInput) opt.onInput({ ...ov }); });
    slider.addEventListener("change", () => fire({ grund: "regler", quelle: "regler" }));
    resetBtn.addEventListener("click", () => { ov = W().clearOverride(); fire({ grund: "knopf", quelle: "zurueck" }); if (opt.onReset) opt.onReset(); });
    if (opt.onSchedule) $("wb-wind-schedule").addEventListener("click", () => opt.onSchedule({ ...ov }, (entries) => { ov = W().setSchedule(ov, entries); fire({ grund: "zeitplan", quelle: "zeitplan" }); }));
    else $("wb-wind-schedule").hidden = true;

    draw();

    return {
      el: box,
      value: () => ({ ...ov }),
      set(next) { ov = next ? { ...next } : W().emptyOverride(); draw(); },
      setBase(b) { base = b || base; draw(); },
      /** Fortschrittsanzeige der Neuberechnung mit Abbruch. */
      progress: {
        show(done, total, text) {
          prog.hidden = false;
          prog.querySelector(".bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
          prog.querySelector(".ptext").textContent = text || `Ensemble-Lauf ${done} von ${total}`;
        },
        hide() { prog.hidden = true; },
        onAbort(fn) { $("wb-wind-abort").onclick = fn; },
      },
      destroy() { box.remove(); },
    };
  }

  /**
   * Automatische Neuberechnung: entprellt (Annahme 300 ms nach dem Loslassen), mit
   * Fortschrittsanzeige, laufende Rechnung abbrechbar (Windrose.createRunGuard).
   * opt: {delayMs, run(arg, {onProgress, guard, generation}) -> Promise, onStart, onDone, onAbort, onError}
   */
  function createRecalc(opt = {}) {
    const guard = W().createRunGuard();
    let running = false;
    const deb = W().createDebouncer({
      delayMs: opt.delayMs ?? (W().params(opt.P || root.PARAMS).debounceMs),
      run: (arg) => { start(arg); },
    });
    async function start(arg) {
      const gen = guard.start();
      running = true;
      if (opt.onStart) opt.onStart(gen);
      try {
        const res = await opt.run(arg, {
          generation: gen,
          guard,
          onProgress: async (done, total) => {
            guard.throwIfStale(gen);
            if (opt.onProgress) opt.onProgress(done, total);
            await new Promise((r) => setTimeout(r, 0));
          },
        });
        guard.throwIfStale(gen);
        running = false;
        if (opt.onDone) opt.onDone(res, gen);
        return res;
      } catch (e) {
        running = false;
        if (W().isAbort(e)) { if (opt.onAbort) opt.onAbort(e, gen); return null; }
        if (opt.onError) opt.onError(e, gen); else throw e;
        return null;
      }
    }
    return {
      trigger: (arg) => deb.trigger(arg),
      flush: () => deb.flush(),
      cancel() { deb.cancel(); guard.cancel(); },
      get pending() { return deb.pending; },
      get running() { return running; },
      guard,
    };
  }

  /**
   * Szenario-Vergleich A/B für zwei WINDszenarien. Baut auf dem vorhandenen Vergleich in
   * js/app.js (`renderScenario`, `S.run`/`S.runB`, Umschalter „Karte: A/B zeigen“) auf:
   * dieselben Läufe, dieselben Kennzahlen – ergänzt um gleichzeitige Anzeige beider Konturen
   * mit unterscheidbaren Strichstilen, Legende und Kennzahlentabelle (Windrose.compare).
   */
  function renderCompare(container, A, B, o = {}) {
    if (!container) return null;
    const cmp = W().compare(A, B);
    const rows = W().compareRows(cmp);
    const sa = W().contourStyle("A"), sb = W().contourStyle("B");
    const group = (name) => rows.filter((r) => r.gruppe === name);
    const table = (name) => group(name).length ? `
      <table class="data"><thead><tr><th>${esc(name)}</th><th class="num">A</th><th class="num">B</th><th class="num">B − A</th></tr></thead>
      <tbody>${group(name).map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.a)}</td><td class="num">${esc(r.b)}</td><td class="num">${esc(r.delta)}</td></tr>`).join("")}</tbody></table>` : "";
    container.innerHTML = `
      <div class="msg warn"><b>Zwei Modellprognosen, unvalidiert.</b> ${esc(cmp.note)}</div>
      <div class="wb-ab-legend">
        <span class="wb-ab a"><i style="border-top-style:solid"></i> A: ${esc(cmp.wind.a || "echtes Wetter")} (${esc(sa.legend)})</span>
        <span class="wb-ab b"><i style="border-top-style:dashed"></i> B: ${esc(cmp.wind.b || "–")} (${esc(sb.legend)})</span>
      </div>
      <div class="tablewrap">${table("Fläche")}${table("Richtung")}${table("Objekte")}</div>
      <div class="btnrow">
        <button class="btn small" type="button" data-ab="A">Karte: nur A</button>
        <button class="btn small" type="button" data-ab="B">Karte: nur B</button>
        <button class="btn small primary" type="button" data-ab="AB">Karte: A und B</button>
      </div>`;
    if (o.onShow) container.querySelectorAll("[data-ab]").forEach((b) => { b.onclick = () => o.onShow(b.getAttribute("data-ab")); });
    return cmp;
  }

  const InteraktionUI = { windControl, createRecalc, renderCompare };
  root.InteraktionUI = InteraktionUI;
  if (typeof module !== "undefined" && module.exports) module.exports = InteraktionUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
