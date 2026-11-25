/*
 * Ortssuche: Kommunen, Ortsteile (Ortslagen), Straßen, Adressen mit Hausnummer, Rettungspunkte, Koordinaten.
 *
 * Offline zuerst: data/suche-index.json (Gebäudereferenzen NRW + Basis-DLM-Ortslagen + DVG1, Geobasis NRW,
 * dl-de/zero-2-0) und data/rettungspunkte-kwf.json (KWF-Rettungspunkte, CC BY-ND 4.0, unverändert).
 * Online nur auf ausdrücklichen Aufruf (Search.online): OpenStreetMap/Nominatim, max. 1 Anfrage/s, kein Autocomplete.
 *
 * Klassisches Skript ohne Abhängigkeiten. Globales Objekt `Search` (Browser) bzw. module.exports (Node-Tests).
 *
 * Schnittstelle
 *   Search.configure({indexUrl, rpUrl, online: {enabled, url, ...}, areaBbox, demBbox, fetch})
 *   Search.ensureLoaded()        -> Promise (lädt Index + Rettungspunkte einmalig; UI ruft das beim 1. Fokus)
 *   Search.load(url)             -> Promise (nur Suchindex)
 *   Search.loadData(index, rp)   -> synchron (Tests, eingebettete Daten)
 *   Search.query(text, {limit})  -> [{typ, label, sub, kommune, lat, lon, bbox?, quelle, score, ...}]
 *   Search.parseCoordinate(text) -> {lat, lon, format, utm, imGebiet, imDgm, warnungen[]} | {fehler} | null
 *   Search.online(text)          -> Promise<[treffer]> (Nominatim, gedrosselt, Cache)
 *   Search.rettungspunkte()      -> [{nr, lat, lon, ortsbeschr, schild, urheber, props}] (Kartenebene)
 *   Search.rpInfo()              -> {version, stand, veraltet, warnung, attributionText, attributionHtml, ...}
 *   Search.utmToWgs84(e, n, zone), Search.wgs84ToUtm(lat, lon, zone)
 * bbox immer [süd, west, nord, ost] in Grad.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ Konfiguration
  const CFG = {
    indexUrl: "data/suche-index.json",
    rpUrl: "data/rettungspunkte-kwf.json",
    // Suchgebiet (NKS + Nachbarkommunen, DVG1); wird beim Laden aus dem Index überschrieben
    areaBbox: [50.69446, 7.173181, 50.989864, 7.532115],
    // Ausdehnung data/dgm25.json (west/east/south/north); App kann S.dem.meta übergeben
    demBbox: [50.761575, 7.20082, 50.954175, 7.48127],
    online: {
      enabled: true, // per APP_CONFIG.searchOnline = false abschaltbar
      url: "https://nominatim.openstreetmap.org/search",
      minIntervalMs: 1100, // Nominatim-Nutzungsregel: höchstens 1 Anfrage pro Sekunde
      limit: 5,
      email: "", // optional laut Nominatim-Regeln (Kontakt des Betreibers, NICHT personenbezogen eintragen)
    },
    rpMaxAgeMonths: 7, // Warnung, wenn die KWF-Version älter ist (KWF exportiert ca. 2x jährlich)
    fetch: null, // für Tests injizierbar
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  const ATTR = {
    gebref: "Gebäudereferenzen NRW, Geobasis NRW (dl-de/zero-2-0)",
    dlm: "Basis-DLM (Ortslage), Geobasis NRW (dl-de/zero-2-0)",
    dvg: "DVG1, Geobasis NRW (dl-de/zero-2-0)",
    kwf: "© KWF-Rettungspunkte, Datenurheber, www.rettungspunkte-forst.de (CC BY-ND 4.0; Inhalt unverändert, Gebietsausschnitt)", // beim Laden mit Version überschrieben
    osm: "© OpenStreetMap-Mitwirkende (ODbL), Nominatim",
  };

  const S = { idx: null, rp: null, kommunen: [], ortslagen: [], streets: [], rps: [], loading: null, error: null, meta: null, rpMeta: null };

  // ------------------------------------------------------------------ Normalisierung
  /** Klein, ß->ss, Umlaute->ae/oe/ue, Akzente weg, Straße/Str./str -> "str", Satzzeichen -> Leerzeichen. */
  function fold(s, plain) {
    let t = String(s == null ? "" : s).toLowerCase();
    t = t.replace(/ß/g, "ss");
    // plain: Umlaut -> Grundvokal (zweite Lesart, damit "Rosrath"/"Kolner" ebenso exakt passt wie "Roesrath")
    if (!plain) t = t.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
    t = t.normalize ? t.normalize("NFD").replace(/[̀-ͯ]/g, "") : t;
    t = t.replace(/[^a-z0-9]+/g, " ").trim();
    // "Straße", "Strasse", "Str.", "str" und unvollständige Eingaben ("Hauptstra", "Hauptstraß") -> "str"
    t = t.replace(/str(?:a|as|ass|asse)\b/g, "str");
    return t;
  }
  const compact = (s) => fold(s).replace(/ /g, "");

  /** Optimal-String-Alignment-Distanz (Damerau, eine Vertauschung) mit Abbruch über max. */
  function osa(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let p2 = null, p1 = new Array(lb + 1), cur;
    for (let j = 0; j <= lb; j++) p1[j] = j;
    for (let i = 1; i <= la; i++) {
      cur = new Array(lb + 1); cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= lb; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      p2 = p1; p1 = cur;
    }
    return p1[lb];
  }

  function prepName(name) {
    const n = fold(name), n2 = fold(name, true);
    return { n, c: n.replace(/ /g, ""), w: n.split(" ").filter(Boolean), c2: n2.replace(/ /g, ""), w2: n2.split(" ").filter(Boolean) };
  }

  /**
   * Bewertung Name gegen Anfrage: exakt 1000 > Präfix 800-850 > alle Wörter als Präfix 700 > Wortanfang 650 > ganzer Name mit 1 (2) Tippfehler 520 (470) > enthält 500 > Präfix mit Tippfehler 200-250.
   * q = prepName(anfrage)
   */
  function nameScore(e, q) {
    if (!q.c) return 0;
    const a = score1(e.c, e.w, q.c, q.w);
    if (a >= 1000 || (e.c2 === e.c && q.c2 === q.c)) return a;
    return Math.max(a, score1(e.c2, e.w2, q.c2, q.w2));
  }
  function score1(ec, ewords, qc, qw) {
    if (ec === qc) return 1000;
    if (ec.startsWith(qc)) return 800 + Math.round(50 * qc.length / ec.length);
    if (qw.length > 1 && qw.every((x) => ewords.some((ew) => ew.startsWith(x)))) return 700;
    if (ewords.some((ew) => ew.startsWith(qc))) return 650;
    if (qc.length >= 3 && ec.includes(qc)) return 500;
    if (qc.length >= 4) {
      const max = qc.length >= 8 ? 2 : 1;
      let whole = osa(qc, ec, max); // ganzer Name mit Tippfehler
      for (const ew of ewords) if (ew.length >= 4) whole = Math.min(whole, osa(qc, ew, max));
      if (whole <= max) return 570 - whole * 50; // 1 Fehler im ganzen Namen: knapp vor "enthält"
      let best = whole;
      for (let L = qc.length - max; L <= qc.length + max; L++) if (L > 2 && L < ec.length) best = Math.min(best, osa(qc, ec.slice(0, L), max));
      for (const ew of ewords) if (ew.length >= 4) best = Math.min(best, osa(qc, ew.slice(0, qc.length), max));
      if (best <= max) return 300 - best * 50;
    }
    return 0;
  }

  // ------------------------------------------------------------------ Laden
  function configure(o) {
    o = o || {};
    for (const k of Object.keys(o)) {
      if (k === "online" && o.online) Object.assign(CFG.online, o.online);
      else if (o[k] !== undefined) CFG[k] = o[k];
    }
    return CFG;
  }

  const getFetch = () => CFG.fetch || (typeof fetch === "function" ? fetch.bind(root) : null);
  const asset = (p) => (root && typeof root.WB_ASSET === "function" ? root.WB_ASSET(p) : p);

  async function fetchJson(url) {
    const f = getFetch();
    if (!f) throw new Error("fetch nicht verfügbar");
    const r = await f(asset(url));
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function load(url) {
    const idx = await fetchJson(url || CFG.indexUrl);
    loadData(idx, S.rp ? null : undefined);
    return S;
  }

  /** Lädt Index und Rettungspunkte genau einmal (Lazy Loading beim ersten Fokus). Fehler der RP-Datei sind nicht fatal. */
  function ensureLoaded() {
    if (S.idx) return Promise.resolve(S);
    if (S.loading) return S.loading;
    S.loading = Promise.all([
      fetchJson(CFG.indexUrl),
      fetchJson(CFG.rpUrl).catch((e) => ({ __error: String(e.message || e) })),
    ]).then(([idx, rp]) => {
      loadData(idx, rp && !rp.__error ? rp : null);
      if (rp && rp.__error) S.rpError = rp.__error;
      return S;
    }).catch((e) => { S.loading = null; S.error = String(e.message || e); throw e; });
    return S.loading;
  }

  function loadData(idx, rp) {
    if (idx) {
      if (idx.v !== 1) throw new Error("Suchindex: unbekannte Version " + idx.v);
      S.idx = idx; S.meta = idx.meta || null;
      S.kommunen = idx.k.map((k, i) => ({ i, kn: k[0], name: k[1], bbox: k[2].map((v) => v / 1e6), p: prepName(k[1]) }));
      // Kurzformen: "Hennef (Sieg)" auch als "Hennef"
      for (const k of S.kommunen) k.alt = prepName(k.name.replace(/\s*\(.*\)\s*/g, " "));
      S.ortslagen = idx.o.map((o, i) => ({ i, name: o[0], k: o[1], lat: o[2] / 1e6, lon: o[3] / 1e6, bbox: [o[4], o[5], o[6], o[7]].map((v) => v / 1e6), p: prepName(o[0]) }));
      S.streets = idx.s.map((s, i) => decodeStreet(s, i));
      if (S.meta && S.meta.gebiet && S.meta.gebiet.bbox) CFG.areaBbox = S.meta.gebiet.bbox.map((v) => v / 1e6);
    }
    if (rp) {
      S.rp = rp; S.rpMeta = rp.meta;
      const cols = rp.meta.spalten;
      const iLon = cols.indexOf("geom_lon"), iLat = cols.indexOf("geom_lat");
      const attrCols = cols.map((c, i) => [c, i]).filter(([c]) => c !== "geom_lon" && c !== "geom_lat" && c !== "fid");
      // Feldnamen unabhängig von Groß/Klein (Shapefile: RP_Nr, WFS: rp_nr); Werte bleiben unverändert in props
      const get = (props, name) => { for (const k in props) if (k.toLowerCase() === name) return props[k]; return undefined; };
      const blank = (v) => (v == null || v === "" ? null : v);
      S.rps = rp.rows.map((r) => {
        const props = {}; for (const [c, i] of attrCols) props[c] = r[i];
        const nr = String(get(props, "rp_nr") == null ? "" : get(props, "rp_nr"));
        const ob = blank(get(props, "ortsbeschr"));
        return { nr, lat: r[iLat], lon: r[iLon], ortsbeschr: ob, schild: blank(get(props, "schild")), urheber: blank(get(props, "urheber")), bundesland: blank(get(props, "bundesland")), props,
          c: compact(nr), c2: fold(nr, true).replace(/ /g, ""), d: ob ? prepName(ob) : null };
      });
      if (rp.meta.quellenvermerk) ATTR.kwf = `${rp.meta.quellenvermerk} (CC BY-ND 4.0; Inhalt unverändert, Gebietsausschnitt)`;
    }
    return S;
  }

  function decodeStreet(s, i) {
    const [name, k, o, hs, cs, q] = s;
    const hnr = hs ? hs.split(",") : [];
    const lat = new Array(hnr.length), lon = new Array(hnr.length);
    let a = 0, b = 0;
    for (let j = 0; j < hnr.length; j++) { a += cs[2 * j]; b += cs[2 * j + 1]; lat[j] = a / 1e6; lon[j] = b / 1e6; }
    let s0 = 90, w0 = 180, n0 = -90, e0 = -180, ml = 0, mo = 0;
    for (let j = 0; j < hnr.length; j++) {
      s0 = Math.min(s0, lat[j]); n0 = Math.max(n0, lat[j]); w0 = Math.min(w0, lon[j]); e0 = Math.max(e0, lon[j]); ml += lat[j]; mo += lon[j];
    }
    ml /= hnr.length || 1; mo /= hnr.length || 1;
    // Mittelpunkt: die Hausadresse, die dem Schwerpunkt aller Adressen am nächsten liegt (liegt sicher an der Straße)
    let best = 0, bd = Infinity;
    for (let j = 0; j < hnr.length; j++) { const d = (lat[j] - ml) ** 2 + ((lon[j] - mo) * 0.63) ** 2; if (d < bd) { bd = d; best = j; } }
    return { i, name, k, o, hnr, hnrC: hnr.map((h) => h.toLowerCase()), lat, lon, q: q || null, bbox: [s0, w0, n0, e0], cLat: lat[best], cLon: lon[best], p: prepName(name) };
  }

  // ------------------------------------------------------------------ Anfrage zerlegen
  function kommuneMatch(tokens) {
    // ganzes Wort/ganze Wortfolge = Kommunenname (oder Kurzform), mind. 3 Zeichen
    const c = tokens.join("");
    if (c.length < 3) return null;
    for (const k of S.kommunen) if (k.p.c === c || k.alt.c === c || (c === "nks" && k.i === 0)) return k;
    return null;
  }
  function ortslageMatch(tokens) {
    const c = tokens.join("");
    if (c.length < 3) return [];
    return S.ortslagen.filter((o) => o.p.c === c);
  }

  /**
   * Zerlegt "Zum Wirbel 4a, Neunkirchen-Seelscheid" in Name, Hausnummer, Kontext (Kommune/Ortslage).
   * Liefert mehrere Lesarten; die Bewertung nimmt je Eintrag die beste.
   */
  function parseQuery(text) {
    const parts = String(text).split(",");
    let main = fold(parts[0]);
    let ctxTokens = parts.length > 1 ? fold(parts.slice(1).join(" ")).split(" ").filter(Boolean) : [];
    let toks = main.split(" ").filter(Boolean);
    // führendes "rp"/"rettungspunkt" entfernen (nur für RP-Suche relevant)
    let hnr = null, zusatz = "";
    let hi = -1;
    for (let j = 1; j < toks.length; j++) if (/^\d/.test(toks[j])) { hi = j; break; }
    if (hi > 0) {
      const m = /^(\d{1,4})([a-z]{0,2})$/.exec(toks[hi]);
      if (m) {
        hnr = m[1]; zusatz = m[2];
        let rest = toks.slice(hi + 1);
        if (!zusatz && rest.length && /^[a-z]{1,2}$/.test(rest[0]) && !kommuneMatch([rest[0]])) { zusatz = rest[0]; rest = rest.slice(1); }
        while (rest.length && /^\d+$/.test(rest[0])) rest = rest.slice(1); // "12-14" -> 12
        ctxTokens = rest.concat(ctxTokens);
        toks = toks.slice(0, hi);
      }
    }
    const readings = [{ name: toks, ctx: ctxTokens }];
    // Kontext am Ende ohne Komma: "Hauptstraße Much", "Hauptstraße Neunkirchen"
    if (!ctxTokens.length && toks.length > 1) {
      for (let cut = 1; cut <= Math.min(3, toks.length - 1); cut++) {
        const tail = toks.slice(toks.length - cut);
        if (kommuneMatch(tail) || ortslageMatch(tail).length) readings.push({ name: toks.slice(0, toks.length - cut), ctx: tail });
      }
    }
    for (const r of readings) {
      r.q = prepName(r.name.join(" "));
      r.kommune = r.ctx.length ? kommuneMatch(r.ctx) : null;
      r.ortslagen = r.ctx.length ? ortslageMatch(r.ctx) : [];
    }
    return { readings, hnr, zusatz, raw: String(text) };
  }

  function ctxBonus(r, k, o) {
    let b = 0;
    if (r.kommune) b += r.kommune.i === k ? 150 : -400;
    if (r.ortslagen.length) b += r.ortslagen.some((x) => x.i === o || (o === undefined && x.k === k)) ? 150 : (r.kommune ? 0 : -150);
    return b;
  }

  // ------------------------------------------------------------------ Suche
  const TYPE_BONUS = { rettungspunkt: 8, kommune: 6, ortsteil: 4, strasse: 2, adresse: 0 };
  const kName = (i) => (S.kommunen[i] ? S.kommunen[i].name : "");
  const nksBonus = (k) => (k === 0 ? 20 : 0);

  function fmtCount(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  function streetHit(st, score, extra) {
    const ol = st.o >= 0 && S.ortslagen[st.o] ? S.ortslagen[st.o].name : null;
    return Object.assign({
      typ: "strasse", id: "s" + st.i, label: st.name, kommune: kName(st.k), ortslage: ol,
      sub: [kName(st.k), ol ? "Ortslage " + ol : null, fmtCount(st.hnr.length, "Hausnummer", "Hausnummern")].filter(Boolean).join(" · "),
      lat: st.cLat, lon: st.cLon, bbox: st.bbox.slice(), quelle: ATTR.gebref, score,
    }, extra || {});
  }

  function addrHit(st, j, score, hinweis) {
    const ol = st.o >= 0 && S.ortslagen[st.o] ? S.ortslagen[st.o].name : null;
    const q = st.q ? st.q[j] : "A";
    return {
      typ: "adresse", id: "a" + st.i + ":" + st.hnr[j], label: `${st.name} ${st.hnr[j]}`, strasse: st.name, hausnummer: st.hnr[j],
      kommune: kName(st.k), ortslage: ol, sub: [kName(st.k), ol ? "Ortslage " + ol : null, q !== "A" ? `Lagequalität ${q} (zu prüfen)` : null].filter(Boolean).join(" · "),
      lat: st.lat[j], lon: st.lon[j], qualitaet: q, hinweis: hinweis || null, quelle: ATTR.gebref, score,
    };
  }

  function rpHit(r, score) {
    return {
      typ: "rettungspunkt", id: "r" + r.nr, label: r.nr, nr: r.nr, kommune: "",
      sub: [r.ortsbeschr || null, r.urheber || null].filter(Boolean).join(" · "),
      lat: r.lat, lon: r.lon, ortsbeschr: r.ortsbeschr, schild: r.schild, urheber: r.urheber, bundesland: r.bundesland, props: r.props, quelle: ATTR.kwf, score,
    };
  }

  function coordHit(c) {
    const lab = `${fmtDeg(c.lat, "N", "S")}, ${fmtDeg(c.lon, "O", "W")}`;
    return {
      typ: "koordinate", id: "c" + c.lat + "," + c.lon, label: lab, kommune: "",
      sub: [`UTM ${c.utm.zone}N ${Math.round(c.utm.e)} ${Math.round(c.utm.n)}`, c.format].concat(c.warnungen).join(" · "),
      lat: c.lat, lon: c.lon, warnungen: c.warnungen, imGebiet: c.imGebiet, imDgm: c.imDgm, quelle: "Eingabe", score: 5000,
    };
  }

  function fmtDeg(v, pos, neg) { return `${Math.abs(v).toFixed(6).replace(".", ",")}° ${v >= 0 ? pos : neg}`; }

  /** Hauptsuche (synchron, Index muss geladen sein; ohne Index nur Koordinaten). */
  function query(text, opt) {
    const limit = (opt && opt.limit) || 10;
    const t = String(text == null ? "" : text).trim();
    if (!t) return [];
    const out = [];
    const coord = parseCoordinate(t);
    if (coord && !coord.fehler) out.push(coordHit(coord));
    else if (coord && coord.fehler) out.push({ typ: "hinweis", id: "err", label: coord.fehler, sub: "Koordinateneingabe", kommune: "", lat: null, lon: null, score: 4000, quelle: "" });
    if (coord) return out; // eindeutig Koordinate: keine Namenssuche

    // Rettungspunkte (Nummer, tolerant: mit/ohne Bindestrich/Leerzeichen, Groß/Klein)
    const rqRaw = t.replace(/^\s*(rettungspunkt|rp)\b[\s:.-]*/i, "");
    const rq = compact(rqRaw), rq2 = fold(rqRaw, true).replace(/ /g, "");
    if (rq.length >= 2 && S.rps.length) {
      const hasDigit = /\d/.test(rq);
      for (const r of S.rps) {
        let sc = 0;
        if (r.c === rq || r.c2 === rq2) sc = 3000; // exakte Nummer: höchste Priorität
        else if (hasDigit && r.c.startsWith(rq)) sc = 800 + Math.round(50 * rq.length / r.c.length);
        else if (hasDigit && rq.length >= 3 && r.c.includes(rq)) sc = 500;
        else if (hasDigit && rq.length >= 5 && osa(rq, r.c, 1) <= 1) sc = 280;
        else if (r.d && rq.length >= 4 && !hasDigit) { const ns = nameScore(r.d, prepName(t)); if (ns >= 500) sc = Math.min(ns, 650) - 200; }
        if (sc) out.push(rpHit(r, sc + TYPE_BONUS.rettungspunkt));
      }
    }

    if (S.idx) {
      const pq = parseQuery(t);
      const best = new Map(); // id -> hit
      const put = (h) => { const o = best.get(h.id); if (!o || o.score < h.score) best.set(h.id, h); };
      for (const r of pq.readings) {
        if (!r.q.c) continue;
        if (pq.hnr === null) {
          for (const k of S.kommunen) {
            const sc = Math.max(nameScore(k.p, r.q), nameScore(k.alt, r.q) - 1);
            if (sc) put({ typ: "kommune", id: "k" + k.i, label: k.name, kommune: k.name, sub: `Gemeindeschlüssel ${k.kn}`,
              lat: (k.bbox[0] + k.bbox[2]) / 2, lon: (k.bbox[1] + k.bbox[3]) / 2, bbox: k.bbox.slice(), quelle: ATTR.dvg, score: sc + nksBonus(k.i) + TYPE_BONUS.kommune + ctxBonus(r, k.i) });
          }
          for (const o of S.ortslagen) {
            const sc = nameScore(o.p, r.q);
            if (sc) put({ typ: "ortsteil", id: "o" + o.i, label: o.name, kommune: kName(o.k), sub: `${kName(o.k)} · Ortslage (Basis-DLM)`,
              lat: o.lat, lon: o.lon, bbox: o.bbox.slice(), quelle: ATTR.dlm, score: sc + nksBonus(o.k) + TYPE_BONUS.ortsteil + ctxBonus(r, o.k, o.i) });
          }
        }
        for (const st of S.streets) {
          const sc = nameScore(st.p, r.q);
          if (!sc) continue;
          const base = sc + nksBonus(st.k) + ctxBonus(r, st.k, st.o);
          if (pq.hnr === null) { put(streetHit(st, base + TYPE_BONUS.strasse)); continue; }
          const want = pq.hnr + pq.zusatz;
          let found = false;
          for (let j = 0; j < st.hnr.length; j++) {
            const h = st.hnrC[j];
            const num = h.replace(/[^0-9]/g, "");
            let add = 0, hint = null;
            if (h === want) add = 1500;
            else if (pq.zusatz && num === pq.hnr && h === pq.hnr) { add = 1200; hint = `Zusatz „${pq.zusatz}“ nicht gefunden, Hausnummer ${pq.hnr} gezeigt`; }
            else if (!pq.zusatz && num === pq.hnr) add = 1300; // 12 -> 12a, 12b
            else if (!pq.zusatz && h.startsWith(pq.hnr)) add = 1100; // Eingabe läuft noch: 1 -> 10, 11
            if (add) { found = true; put(addrHit(st, j, base + add, hint)); }
          }
          if (!found) put(streetHit(st, base + TYPE_BONUS.strasse, { hinweis: `Hausnummer ${want} nicht gefunden` }));
        }
      }
      for (const h of best.values()) out.push(h);
    }

    out.sort((a, b) => b.score - a.score
      || kIdx(a) - kIdx(b)
      || a.label.length - b.label.length
      || a.label.localeCompare(b.label, "de"));
    return out.slice(0, limit);
  }
  function kIdx(h) { const k = S.kommunen.find((x) => x.name === h.kommune); return k ? k.i : 99; }

  // ------------------------------------------------------------------ UTM <-> WGS84 (Krüger-Reihen nach Karney 2011, 6. Ordnung)
  const A_ = 6378137, F_ = 1 / 298.257222101; // GRS80 (ETRS89, EPSG:25832); WGS84 weicht < 0,1 mm ab
  const K0 = 0.9996, FE = 500000;
  const N_ = F_ / (2 - F_), E2 = F_ * (2 - F_), EC = Math.sqrt(E2);
  const n1 = N_, n2 = n1 * n1, n3 = n2 * n1, n4 = n3 * n1, n5 = n4 * n1, n6 = n5 * n1;
  const AA = (A_ / (1 + N_)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const ALPHA = [
    n1 / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
    49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
    34729 * n5 / 80640 - 3418889 * n6 / 1995840,
    212378941 * n6 / 319334400,
  ];
  const BETA = [
    n1 / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
    n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
    17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
    4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
    4583 * n5 / 161280 - 108847 * n6 / 3991680,
    20648693 * n6 / 638668800,
  ];
  const D2R = Math.PI / 180;
  const lon0 = (zone) => (zone * 6 - 183) * D2R;
  const tauPrime = (tau) => { const s = Math.sinh(EC * Math.atanh(EC * tau / Math.hypot(1, tau))); return tau * Math.hypot(1, s) - s * Math.hypot(1, tau); };

  /** UTM (Nordhalbkugel) -> {lat, lon} in Grad. */
  function utmToWgs84(e, n, zone) {
    zone = zone || 32;
    const xi = n / (K0 * AA), eta = (e - FE) / (K0 * AA);
    let xp = xi, ep = eta;
    for (let j = 1; j <= 6; j++) {
      xp -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      ep -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const tp = Math.sin(xp) / Math.hypot(Math.sinh(ep), Math.cos(xp)); // tan(chi)
    let tau = tp;
    for (let it = 0; it < 10; it++) {
      const tpi = tauPrime(tau);
      const d = (tp - tpi) / Math.hypot(1, tpi) * (1 + (1 - E2) * tau * tau) / ((1 - E2) * Math.hypot(1, tau));
      tau += d;
      if (Math.abs(d) < 1e-14) break;
    }
    return { lat: Math.atan(tau) / D2R, lon: (lon0(zone) + Math.atan2(Math.sinh(ep), Math.cos(xp))) / D2R };
  }

  /** WGS84 -> UTM {zone, e, n}; Zone Standard aus Länge (Deutschland: 32/33). */
  function wgs84ToUtm(lat, lon, zone) {
    zone = zone || Math.floor((lon + 180) / 6) + 1;
    const lam = lon * D2R - lon0(zone);
    const tp = tauPrime(Math.tan(lat * D2R));
    const xp = Math.atan2(tp, Math.cos(lam)), ep = Math.asinh(Math.sin(lam) / Math.hypot(tp, Math.cos(lam)));
    let xi = xp, eta = ep;
    for (let j = 1; j <= 6; j++) {
      xi += ALPHA[j - 1] * Math.sin(2 * j * xp) * Math.cosh(2 * j * ep);
      eta += ALPHA[j - 1] * Math.cos(2 * j * xp) * Math.sinh(2 * j * ep);
    }
    return { zone, e: FE + K0 * AA * eta, n: K0 * AA * xi };
  }

  // ------------------------------------------------------------------ Koordinatenparser
  const num = (s) => parseFloat(String(s).replace(",", "."));
  const inBox = (b, lat, lon) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];

  function finish(lat, lon, format, utm, warn) {
    const w = warn || [];
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { fehler: "Koordinate außerhalb des gültigen Bereichs" };
    const u = utm || wgs84ToUtm(lat, lon, 32);
    const imGebiet = inBox(CFG.areaBbox, lat, lon);
    const imDgm = inBox(CFG.demBbox, lat, lon);
    if (!imGebiet) w.push("außerhalb des Suchgebiets (NKS + Nachbarkommunen)");
    if (!imDgm) w.push("außerhalb des Geländemodells (DGM): Prognose ohne Hang");
    return { lat: +lat.toFixed(6), lon: +lon.toFixed(6), format, utm: { zone: u.zone, e: +u.e.toFixed(1), n: +u.n.toFixed(1) }, imGebiet, imDgm, warnungen: w };
  }

  /**
   * Erkennt: Dezimalgrad ("50.8045, 7.3405", "50,8045 7,3405", "N 50.8045 E 7.3405"), Grad/Minuten
   * ("N 50° 48.27' E 7° 20.43'"), Grad/Minuten/Sekunden ("50°48'16.2\"N 7°20'25.8\"E", "50 48 16 N 7 20 25 O"),
   * UTM ("32U 381234 5634567", "381234 5634567", "E 381234 N 5634567", "32381234 5634567").
   * Liefert null, wenn der Text keine Koordinate ist; {fehler} bei erkennbarer, aber ungültiger/unsupported Eingabe.
   */
  function parseCoordinate(text) {
    let t = String(text == null ? "" : text).trim().toUpperCase();
    if (!t || !/\d/.test(t)) return null;
    t = t.replace(/[′’´`]/g, "'").replace(/[″”“]/g, '"').replace(/''/g, '"').replace(/º|˚/g, "°").replace(/\s+/g, " ");

    // --- UTM / Gauß-Krüger
    let m = /^(?:(\d{1,2}) ?([C-HJ-NP-X])?[ ,;]+)?(?:(?:E|O|R|RW|OST|EAST|X)[ :=]*)?(\d{6,8}(?:[.,]\d+)?)[ ,;]+(?:(?:N|H|HW|NORD|NORTH|Y)[ :=]*)?(\d{7}(?:[.,]\d+)?)$/.exec(t);
    if (m) {
      let zone = m[1] ? parseInt(m[1], 10) : null;
      let eStr = m[3].split(/[.,]/)[0];
      let e = num(m[3]); const n = num(m[4]);
      if (eStr.length === 8) { // Zone vorangestellt: 32381234
        const z = parseInt(eStr.slice(0, 2), 10);
        if (zone && zone !== z) return { fehler: "UTM: Zonenangabe widersprüchlich" };
        zone = z; e -= z * 1e6;
      } else if (eStr.length === 7) {
        return { fehler: "Gauß-Krüger-Koordinaten (DHDN, 7-stelliger Rechtswert) werden nicht unterstützt. Bitte UTM (ETRS89) oder Grad eingeben." };
      }
      zone = zone || 32;
      if (zone < 1 || zone > 60) return { fehler: "UTM: ungültige Zone" };
      if (e < 100000 || e > 900000 || n < 0 || n > 9400000) return { fehler: "UTM: Rechts-/Hochwert außerhalb des gültigen Bereichs" };
      if (m[2] && m[2] < "N") return { fehler: "UTM: Südhalbkugel wird nicht unterstützt" };
      const ll = utmToWgs84(e, n, zone);
      const warn = zone !== 32 ? [`Zone ${zone} (Gebiet liegt in Zone 32)`] : [];
      return finish(ll.lat, ll.lon, `UTM Zone ${zone} (ETRS89)`, { zone, e, n }, warn);
    }

    // --- Dezimalgrad ohne Grad-/Minutenzeichen
    m = /^([NS])? ?(-?\d{1,2}(?:[.,]\d+)?) ?°? ?([NS])?[ ,;]+([EOW])? ?(-?\d{1,3}(?:[.,]\d+)?) ?°? ?([EOW])?$/.exec(t);
    if (m && !(/^\d{1,2}$/.test(m[2]) && /^\d{1,3}$/.test(m[5]) && !m[1] && !m[3] && !m[4] && !m[6])) {
      let lat = num(m[2]), lon = num(m[5]);
      if (m[1] === "S" || m[3] === "S") lat = -Math.abs(lat);
      if (m[4] === "W" || m[6] === "W") lon = -Math.abs(lon);
      const warn = [];
      const hasHemi = m[1] || m[3] || m[4] || m[6];
      if (!hasHemi && lat >= 5 && lat <= 16 && lon >= 47 && lon <= 56) { const x = lat; lat = lon; lon = x; warn.push("Reihenfolge Länge/Breite vertauscht erkannt"); }
      return finish(lat, lon, "Dezimalgrad", null, warn);
    }
    // vertauschte Hemisphären-Reihenfolge "E 7.34 N 50.80"
    m = /^([EOW]) ?(\d{1,3}(?:[.,]\d+)?) ?°?[ ,;]+([NS]) ?(\d{1,2}(?:[.,]\d+)?) ?°?$/.exec(t);
    if (m) {
      let lon = num(m[2]) * (m[1] === "W" ? -1 : 1), lat = num(m[4]) * (m[3] === "S" ? -1 : 1);
      return finish(lat, lon, "Dezimalgrad", null, []);
    }

    // --- Grad/Minuten(/Sekunden), mit Zeichen oder Hemisphären
    if (/[°'"]/.test(t) || /(^|[\d\s])[NSEOW]($|[\d\s])/.test(t) || /^\d+(?:[.,]\d+)?( \d+(?:[.,]\d+)?){3,5}$/.test(t)) {
      const r = parseDms(t);
      if (r) return r;
      if (/[°'"]/.test(t)) return { fehler: "Koordinate nicht erkannt (Format prüfen, z. B. N 50° 48.27' E 7° 20.43')" };
    }
    return null;
  }

  function parseDms(t) {
    // Tokens: Zahlen (Dezimalkomma nur innerhalb einer Zahl ohne folgendes Leerzeichen) und Hemisphären
    const toks = [];
    const re = /(\d+(?:[.,]\d+)?)\s*([°'"])?|([NSEOW])/g;
    let m;
    while ((m = re.exec(t))) {
      if (m[3]) toks.push({ h: m[3] });
      else toks.push({ v: num(m[1]), u: m[2] || "" });
    }
    if (!toks.length) return null;
    // Gruppen bilden: Hemisphäre vor oder nach den Zahlen
    const groups = [];
    const hemiFirst = toks[0].h !== undefined;
    let cur = { h: null, v: [] };
    for (const tk of toks) {
      if (tk.h !== undefined) {
        if (hemiFirst) { if (cur.v.length || cur.h) groups.push(cur); cur = { h: tk.h, v: [] }; }
        else { cur.h = tk.h; groups.push(cur); cur = { h: null, v: [] }; }
      } else {
        // neue Gruppe, wenn wieder Grad beginnt (Zeichen ° nach bereits begonnener Gruppe mit Minuten)
        if (!hemiFirst && cur.v.length && tk.u === "°") { groups.push(cur); cur = { h: null, v: [] }; }
        cur.v.push(tk);
      }
    }
    if (cur.v.length || cur.h) groups.push(cur);
    let gs = groups.filter((g) => g.v.length);
    if (gs.length === 1 && !gs[0].h) {
      // ohne Hemisphären: Zahlen halbieren (z. B. 50 48 16 7 20 25)
      const v = gs[0].v;
      if (v.length % 2 || v.length < 4) return null;
      gs = [{ h: null, v: v.slice(0, v.length / 2) }, { h: null, v: v.slice(v.length / 2) }];
    }
    if (gs.length !== 2) return null;
    const val = (g) => {
      if (g.v.length > 3) return NaN;
      const d = g.v[0].v, mi = g.v[1] ? g.v[1].v : 0, se = g.v[2] ? g.v[2].v : 0;
      if (mi >= 60 || se >= 60) return NaN;
      if (g.v.length >= 2 && d % 1 !== 0) return NaN;
      if (g.v.length === 3 && mi % 1 !== 0) return NaN;
      return d + mi / 60 + se / 3600;
    };
    let lat, lon;
    const isLat = (h) => h === "N" || h === "S";
    const [g1, g2] = gs;
    if (g1.h && g2.h && isLat(g1.h) === isLat(g2.h)) return { fehler: "Koordinate: zweimal Breite oder zweimal Länge angegeben" };
    if (g1.h && !isLat(g1.h)) { lon = val(g1); lat = val(g2); if (g1.h === "W") lon = -lon; if (g2.h === "S") lat = -lat; }
    else { lat = val(g1); lon = val(g2); if (g1.h === "S") lat = -lat; if (g2.h === "W") lon = -lon; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { fehler: "Koordinate: Minuten/Sekunden ungültig (müssen < 60 sein)" };
    const fmt = Math.max(g1.v.length, g2.v.length) === 3 ? "Grad/Minuten/Sekunden" : Math.max(g1.v.length, g2.v.length) === 2 ? "Grad/Dezimalminuten" : "Dezimalgrad";
    return finish(lat, lon, fmt, null, []);
  }

  // ------------------------------------------------------------------ Online (Nominatim), nur auf Knopfdruck
  const ON = { last: -Infinity, chain: Promise.resolve(), cache: new Map(), count: 0 };

  /**
   * Nominatim-Suche, beschränkt auf das Gebiet (viewbox + bounded=1). Nur auf ausdrückliche Nutzeraktion aufrufen
   * (kein Autocomplete). Drosselung: höchstens eine Anfrage je CFG.online.minIntervalMs, Anfragen werden gereiht.
   * Gleiche Anfrage -> Ergebnis aus dem Cache (keine erneute Anfrage).
   */
  function online(text, opt) {
    const q = String(text == null ? "" : text).trim();
    if (!CFG.online.enabled) return Promise.reject(new Error("Online-Suche ist per Konfiguration abgeschaltet"));
    if (q.length < 3) return Promise.reject(new Error("Suchbegriff zu kurz"));
    const key = q.toLowerCase();
    if (ON.cache.has(key)) return Promise.resolve(ON.cache.get(key));
    const run = async () => {
      if (ON.cache.has(key)) return ON.cache.get(key);
      const wait = ON.last + CFG.online.minIntervalMs - CFG.now();
      if (wait > 0) await CFG.sleep(wait);
      ON.last = CFG.now();
      ON.count++;
      const b = CFG.areaBbox;
      const p = new URLSearchParams({ q, format: "jsonv2", limit: String(CFG.online.limit), countrycodes: "de", "accept-language": "de",
        viewbox: `${b[1]},${b[2]},${b[3]},${b[0]}`, bounded: "1", addressdetails: "1" });
      if (CFG.online.email) p.set("email", CFG.online.email);
      const f = getFetch();
      if (!f) throw new Error("fetch nicht verfügbar");
      const r = await f(`${CFG.online.url}?${p.toString()}`, { headers: { Accept: "application/json" }, signal: opt && opt.signal });
      if (!r.ok) throw new Error(`Nominatim: HTTP ${r.status}`);
      const js = await r.json();
      const hits = (Array.isArray(js) ? js : []).map((x, i) => {
        const bb = x.boundingbox ? [num(x.boundingbox[0]), num(x.boundingbox[2]), num(x.boundingbox[1]), num(x.boundingbox[3])] : null;
        const lat = num(x.lat), lon = num(x.lon);
        return { typ: "online", id: "n" + (x.osm_type || "") + (x.osm_id || i), label: x.name || String(x.display_name || "").split(",")[0],
          sub: String(x.display_name || ""), kommune: (x.address && (x.address.town || x.address.village || x.address.city || x.address.municipality)) || "",
          lat: +lat.toFixed(6), lon: +lon.toFixed(6), bbox: bb, imGebiet: inBox(CFG.areaBbox, lat, lon), quelle: ATTR.osm, score: 100 - i };
      }).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
      ON.cache.set(key, hits);
      return hits;
    };
    const pr = ON.chain.then(run, run);
    ON.chain = pr.catch(() => {});
    return pr;
  }

  // ------------------------------------------------------------------ Kartenebene Rettungspunkte
  const escH = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Version, Stand und Quellenvermerk der Rettungspunkte; veraltet = Veröffentlichung liegt mehr als
   * CFG.rpMaxAgeMonths (Standard 7) Monate zurück (KWF: veraltete Versionen sind zu ersetzen).
   */
  function rpInfo(nowMs) {
    const m = S.rpMeta;
    if (!m) return null;
    const pub = m.veroeffentlicht || (m.stand ? m.stand + "-01" : null);
    let alterMonate = null, veraltet = false, faelligAb = null;
    if (pub) {
      const d = new Date(pub + "T00:00:00Z"), n = new Date(nowMs != null ? nowMs : CFG.now());
      alterMonate = (n.getUTCFullYear() - d.getUTCFullYear()) * 12 + (n.getUTCMonth() - d.getUTCMonth()) - (n.getUTCDate() < d.getUTCDate() ? 1 : 0);
      const lim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + CFG.rpMaxAgeMonths, d.getUTCDate()));
      faelligAb = lim.toISOString().slice(0, 10);
      veraltet = n.getTime() > lim.getTime();
    }
    const standText = m.stand ? `${m.stand.slice(5, 7)}/${m.stand.slice(0, 4)}` : "unbekannt";
    const text = m.quellenvermerk || "© KWF-Rettungspunkte, Datenurheber, www.rettungspunkte-forst.de";
    let html = escH(text);
    const links = m.quellenvermerk_links || {};
    for (const k of Object.keys(links)) html = html.replace(escH(k), `<a href="${escH(links[k])}" target="_blank" rel="noopener">${escH(k)}</a>`);
    html += ' (<a href="https://creativecommons.org/licenses/by-nd/4.0/deed.de" target="_blank" rel="noopener">CC BY-ND 4.0</a>; Inhalt unverändert, Gebietsausschnitt)';
    return {
      version: m.version || null, stand: m.stand || null, standText, veroeffentlicht: m.veroeffentlicht || null, alterMonate, veraltet, faelligAb,
      anzahl: S.rps.length, attributionText: text, attributionHtml: html, haftungsausschluss: m.haftungsausschluss || null,
      warnung: veraltet ? `KWF-Rettungspunkte v${m.version || "?"} (Stand ${standText}) sind älter als ${CFG.rpMaxAgeMonths} Monate. Aktuelle Version auf www.rettungspunkte-forst.de prüfen und Datei ersetzen (Pflicht laut KWF-Nutzungsbedingungen).` : null,
    };
  }

  function rettungspunkte() { return S.rps.map((r) => ({ nr: r.nr, lat: r.lat, lon: r.lon, ortsbeschr: r.ortsbeschr, schild: r.schild, urheber: r.urheber, bundesland: r.bundesland, props: r.props })); }

  function status() {
    return { geladen: !!S.idx, laedt: !!S.loading && !S.idx, fehler: S.error, rpFehler: S.rpError || null,
      anzahl: S.idx ? { kommunen: S.kommunen.length, ortslagen: S.ortslagen.length, strassen: S.streets.length, adressen: S.streets.reduce((a, s) => a + s.hnr.length, 0), rettungspunkte: S.rps.length } : null,
      meta: S.meta, rpMeta: S.rpMeta, rp: rpInfo(), onlineAnfragen: ON.count };
  }

  function _reset() { S.idx = S.rp = S.meta = S.rpMeta = null; S.kommunen = []; S.ortslagen = []; S.streets = []; S.rps = []; S.loading = null; S.error = null; ON.last = -Infinity; ON.cache.clear(); ON.count = 0; ON.chain = Promise.resolve(); }

  const Search = {
    configure, load, loadData, ensureLoaded, query, parseCoordinate, online, rettungspunkte, rpInfo, status,
    utmToWgs84, wgs84ToUtm, ATTR, config: CFG,
    _internal: { fold, compact, osa, nameScore, prepName, parseQuery, _reset },
  };
  root.Search = Search;
  if (typeof module !== "undefined" && module.exports) module.exports = Search;
})(typeof globalThis !== "undefined" ? globalThis : this);
