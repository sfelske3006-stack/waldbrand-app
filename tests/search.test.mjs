// Tests für die Ortssuche (js/search.js). Start: node --test tests/search.test.mjs
// Nutzt den mitgelieferten Index data/suche-index.json, data/rettungspunkte-kwf.json und Fixtures
// (tests/fixtures/*.json, erzeugt von tools/build-suche.py mit pyproj aus den Rohdaten).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const Search = require("../js/search.js");
const { fold, osa, _reset } = Search._internal;

const here = path.dirname(new URL(import.meta.url).pathname);
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(here, p), "utf8"));
const INDEX = readJson("../data/suche-index.json");
const RP = readJson("../data/rettungspunkte-kwf.json");
const UTM_FX = readJson("fixtures/utm-pyproj.json");
const GEBREF_FX = readJson("fixtures/gebref-stichprobe.json");
const KWF_FX = readJson("fixtures/kwf-stichprobe.json");

function loadReal() { _reset(); Search.loadData(INDEX, RP); }
const q = (t, limit = 10) => Search.query(t, { limit });
const first = (t) => q(t, 5)[0];
const distM = (a, b, c, d) => Math.hypot((a - c) * 111320, (b - d) * 111320 * Math.cos((a * Math.PI) / 180));

// Synthetische Testdaten (KEINE echten Orte/Punkte): zwei Kommunen, drei Straßen, eine Ortslage, drei Rettungspunkte
function loadSynth() {
  _reset();
  const enc = (pts) => { const o = []; let pa = 0, po = 0; for (const [a, b] of pts) { const la = Math.round(a * 1e6), lo = Math.round(b * 1e6); o.push(la - pa, lo - po); pa = la; po = lo; } return o; };
  Search.loadData({
    v: 1, meta: {},
    k: [["00000001", "Testdorf", [50e6, 7e6, 50.1e6, 7.1e6]], ["00000002", "Nachbarstadt", [50.1e6, 7e6, 50.2e6, 7.1e6]]],
    o: [["Unterbach", 0, 50050000, 7050000, 50040000, 7040000, 50060000, 7060000]],
    s: [
      ["Lindenstraße", 0, 0, "1,2,2a,10", enc([[50.05, 7.05], [50.0501, 7.0501], [50.0502, 7.0502], [50.0503, 7.0503]])],
      ["Lindenstraße", 1, -1, "1,3", enc([[50.15, 7.05], [50.1501, 7.0501]])],
      ["Am Lindenhof", 0, -1, "5", enc([[50.06, 7.06]])],
    ],
  }, {
    v: 1,
    meta: { spalten: ["fid", "geom_lon", "geom_lat", "id", "rp_nr", "ortsbeschr", "schild", "urheber"], anzahl: 3 },
    rows: [
      ["T.1", 7.01, 50.01, 1, "99-123-XY", "Testweg Ecke", "ja", "Testurheber"],
      ["T.2", 7.02, 50.02, 2, "XY-4567", null, "nein", "Testurheber"],
      ["T.3", 7.03, 50.03, 3, "TÖS 1001", "Lindenhof Waldrand", "ja", "Testurheber"],
    ],
  });
}

// ------------------------------------------------------------------ Normalisierung
test("Normalisierung: Groß/Klein, ß/ss, Umlaute, Str./Straße/str, Bindestriche, Leerzeichen", () => {
  assert.equal(fold("Hauptstraße"), "hauptstr");
  assert.equal(fold("Hauptstrasse"), "hauptstr");
  assert.equal(fold("Hauptstr."), "hauptstr");
  assert.equal(fold("HAUPTSTR"), "hauptstr");
  assert.equal(fold("Hauptstra"), "hauptstr");
  assert.equal(fold("Hauptstraß"), "hauptstr");
  assert.equal(fold("Kölner   Straße"), "koelner str");
  assert.equal(fold("Kölner Str."), "koelner str");
  assert.equal(fold("Adolf-Kolping-Weg"), "adolf kolping weg");
  assert.equal(fold("Müllenholz"), "muellenholz");
  assert.equal(fold("Müllenholz", true), "mullenholz");
  assert.equal(fold("Straßen"), "strassen", "Ortsname Straßen bleibt erhalten");
  assert.equal(fold("Strauch"), "strauch");
  assert.equal(fold("  Zum  Wirbel "), "zum wirbel");
});

test("Tippfehler-Distanz (OSA): Vertauschung = 1, Abbruch über Maximum", () => {
  assert.equal(osa("hermerath", "hermreath", 2), 1);
  assert.equal(osa("wolperath", "wolperth", 2), 1);
  assert.equal(osa("abc", "abc", 1), 0);
  assert.ok(osa("seelscheid", "lohmar", 2) > 2);
});

// ------------------------------------------------------------------ Index-Inhalt
test("Index: Gebiet, Quellen, Lizenz, Anzahlen plausibel", () => {
  loadReal();
  const st = Search.status();
  assert.equal(st.anzahl.kommunen, 7);
  assert.equal(INDEX.k[0][1], "Neunkirchen-Seelscheid");
  assert.deepEqual(INDEX.k.map((k) => k[0]).sort(), ["05378024", "05382020", "05382028", "05382036", "05382040", "05382052", "05382060"]);
  assert.ok(st.anzahl.adressen > 60000 && st.anzahl.strassen > 3000 && st.anzahl.ortslagen > 250, JSON.stringify(st.anzahl));
  assert.equal(st.anzahl.adressen, INDEX.meta.anzahl.adressen);
  assert.ok(INDEX.meta.quellen.every((s) => /dl-de\/zero-2-0/.test(s.lizenz)));
  assert.equal(RP.meta.lizenz, "CC BY-ND 4.0");
  assert.equal(st.anzahl.rettungspunkte, RP.meta.anzahl);
});

// ------------------------------------------------------------------ Ortsteile, Präfix, Tippfehler
test("Ortsteile: exakte Namen aus Basis-DLM-Ortslagen (NKS)", () => {
  loadReal();
  for (const name of ["Seelscheid", "Neunkirchen", "Wolperath", "Hermerath", "Pohlhausen"]) {
    const h = first(name);
    assert.equal(h.typ, "ortsteil", name);
    assert.equal(h.label, name);
    assert.equal(h.kommune, "Neunkirchen-Seelscheid", `${name}: NKS vor Nachbarkommune`);
    assert.ok(h.bbox && h.bbox[0] <= h.lat && h.lat <= h.bbox[2]);
  }
});

test("Präfix: Teileingabe findet Ortsteil/Straße", () => {
  loadReal();
  assert.equal(first("Seelsch").label, "Seelscheid");
  assert.equal(first("hermerather").label, "Hermerather Straße");
  assert.equal(first("Hauptstra").label, "Hauptstraße");
  assert.equal(first("Hauptstra").kommune, "Neunkirchen-Seelscheid");
});

test("Tippfehler: eine Vertauschung/Auslassung wird toleriert", () => {
  loadReal();
  const top = (t) => q(t, 3).map((h) => h.label);
  const sel = q("Selscheid", 10).map((h) => h.label);
  assert.ok(sel.indexOf("Seelscheid") >= 0 && sel.indexOf("Seelscheid") < sel.indexOf("Kesselscheid"), "1 Fehler im ganzen Namen vor bloßem Enthaltensein: " + sel.join("|"));
  assert.ok(top("Hermreath").includes("Hermerath"), top("Hermreath").join("|"));
  assert.ok(top("Wolperth").includes("Wolperath"), top("Wolperth").join("|"));
  assert.ok(top("Selscheid").includes("Seelscheid"), top("Selscheid").join("|"));
  assert.ok(top("Rosrather Str").includes("Rösrather Straße"));
});

// ------------------------------------------------------------------ Straßen und Adressen
test("Straße: Mittelpunkt ist eine Hausadresse, BBox umschließt alle Adressen", () => {
  loadReal();
  const h = first("Zum Wirbel");
  assert.equal(h.typ, "strasse");
  assert.equal(h.kommune, "Neunkirchen-Seelscheid");
  const [s, w, n, e] = h.bbox;
  assert.ok(s <= h.lat && h.lat <= n && w <= h.lon && h.lon <= e);
  const addrs = q("Zum Wirbel 1", 50).filter((x) => x.typ === "adresse" && x.strasse === "Zum Wirbel");
  assert.ok(addrs.length > 3);
  for (const a of addrs) assert.ok(s <= a.lat && a.lat <= n && w <= a.lon && a.lon <= e);
});

test("Hausnummer mit Zusatz: 12a exakt, '12 a' gleich, 12c -> 12 mit Hinweis, unbekannte Nummer -> Straße mit Hinweis", () => {
  loadReal();
  const a = first("Zum Wirbel 12a");
  assert.equal(a.typ, "adresse"); assert.equal(a.label, "Zum Wirbel 12a"); assert.equal(a.hinweis, null);
  const b = first("zum wirbel 12 a");
  assert.equal(b.label, "Zum Wirbel 12a"); assert.equal(b.lat, a.lat); assert.equal(b.lon, a.lon);
  const c = first("Zum Wirbel 12c");
  assert.equal(c.label, "Zum Wirbel 12"); assert.match(c.hinweis, /Zusatz/);
  const d = first("Zum Wirbel 999");
  assert.equal(d.typ, "strasse"); assert.match(d.hinweis, /nicht gefunden/);
  const e = q("Zum Wirbel 12", 5);
  assert.equal(e[0].label, "Zum Wirbel 12", "exakte Nummer vor 12a/12b");
  assert.ok(e.slice(1, 3).some((x) => x.label === "Zum Wirbel 12a"));
  assert.equal(first("Zum Wirbel 4, Neunkirchen-Seelscheid").label, "Zum Wirbel 4");
});

test("Ranking: exakt > Präfix > enthält; NKS vor Nachbarkommunen; Kontext Kommune/Ortslage", () => {
  loadReal();
  const r = q("Seelscheid", 5);
  assert.equal(r[0].typ, "ortsteil");
  const iExact = r.findIndex((x) => x.label === "Seelscheid");
  const iPrefix = r.findIndex((x) => x.label === "Seelscheider Straße");
  const iContains = r.findIndex((x) => x.label === "Neunkirchen-Seelscheid");
  assert.ok(iExact < iPrefix && iPrefix < iContains, r.map((x) => x.label).join("|"));
  assert.equal(first("Hauptstraße 5").kommune, "Neunkirchen-Seelscheid");
  const much = first("Hauptstrasse 5 Much");
  assert.equal(much.kommune, "Much"); assert.equal(much.label, "Hauptstraße 5");
  assert.equal(first("Hauptstraße, Neunkirchen").ortslage, "Neunkirchen");
  assert.equal(first("Much").typ, "kommune");
  assert.equal(first("Hennef").label, "Hennef (Sieg)");
});

test("Stichprobe: 10 zufällige Adressen aus den Rohdaten (gebref) werden exakt gefunden", () => {
  loadReal();
  assert.equal(GEBREF_FX.length, 10);
  for (const f of GEBREF_FX) {
    const p = f.raw.split(";");
    assert.equal(p[14], f.strasse); assert.equal(p[15] + p[16], f.hnr);
    const hits = q(`${f.strasse} ${f.hnr}, ${f.kommune}`, 10).filter((h) => h.typ === "adresse" && h.label === `${f.strasse} ${f.hnr}` && h.kommune === f.kommune);
    assert.ok(hits.length >= 1, `${f.strasse} ${f.hnr}, ${f.kommune} nicht gefunden`);
    const h = hits.find((x) => x.lat === f.lat && x.lon === f.lon);
    assert.ok(h, `${f.strasse} ${f.hnr}: Koordinate ${hits[0].lat},${hits[0].lon} statt ${f.lat},${f.lon} (pyproj)`);
    // eigene Umrechnung aus dem Rohwert (UTM) gegen den Indexwert: < 0,5 m (Rundung 6 Nachkommastellen ~ 0,1 m)
    const own = Search.utmToWgs84(Number(p[18]), Number(p[19]), 32);
    assert.ok(distM(own.lat, own.lon, h.lat, h.lon) < 0.5);
  }
});

// ------------------------------------------------------------------ Koordinaten
test("Koordinatenparser: Dezimalgrad, Dezimalkomma, Grad/Minuten, Grad/Minuten/Sekunden", () => {
  loadReal();
  const want = [50.8045, 7.3405];
  const forms = [
    "50.8045, 7.3405", "50,8045 7,3405", "50,8045; 7,3405", "50.8045 7.3405", "N 50.8045 E 7.3405", "50.8045N 7.3405E",
    "N 50° 48.27' E 7° 20.43'", "N50°48,27' E7°20,43'", "50° 48.27′ N, 7° 20.43′ O",
    "50°48'16.2\"N 7°20'25.8\"E", "50° 48' 16.2'' N 7° 20' 25.8'' E", "50 48 16.2 N 7 20 25.8 O", "N 50 48 16.2 E 7 20 25.8",
    "E 7.3405 N 50.8045", "7.3405, 50.8045",
  ];
  for (const f of forms) {
    const c = Search.parseCoordinate(f);
    assert.ok(c && !c.fehler, `${f}: ${JSON.stringify(c)}`);
    assert.ok(Math.abs(c.lat - want[0]) < 2e-6 && Math.abs(c.lon - want[1]) < 2e-6, `${f} -> ${c.lat}, ${c.lon}`);
    assert.ok(c.imGebiet && c.imDgm && c.warnungen.filter((w) => !/vertauscht/.test(w)).length === 0, f);
  }
  assert.ok(Search.parseCoordinate("7.3405, 50.8045").warnungen.some((w) => /vertauscht/.test(w)));
  const s = Search.parseCoordinate("S 33.9 W 18.4");
  assert.ok(s.lat < 0 && s.lon < 0);
  assert.equal(Search.parseCoordinate("Hauptstraße 5"), null);
  assert.equal(Search.parseCoordinate("Seelscheid"), null);
  assert.equal(Search.parseCoordinate("01-501-SU"), null);
  assert.match(Search.parseCoordinate("N 50° 61' E 7° 20'").fehler, /Minuten/);
});

test("Koordinatenparser: UTM 32 (EPSG:25832) in allen Schreibweisen, Gauß-Krüger abgelehnt", () => {
  loadReal();
  const ref = Search.utmToWgs84(381234, 5634567, 32);
  for (const f of ["32U 381234 5634567", "32 381234 5634567", "381234 5634567", "381234, 5634567", "E 381234 N 5634567", "32U 381234,0 5634567,0",
    "32381234 5634567", "R 381234 H 5634567", "381234.0 5634567.0"]) {
    const c = Search.parseCoordinate(f);
    assert.ok(c && !c.fehler, `${f}: ${JSON.stringify(c)}`);
    assert.ok(Math.abs(c.lat - ref.lat) < 1e-6 && Math.abs(c.lon - ref.lon) < 1e-6, f);
    assert.equal(c.utm.zone, 32);
  }
  assert.match(Search.parseCoordinate("2581234 5634567").fehler, /Gauß-Krüger/);
  assert.match(Search.parseCoordinate("32U 1234 5634567")?.fehler || "keine", /keine|ungültig|Bereich/);
  const hit = first("32U 381234 5634567");
  assert.equal(hit.typ, "koordinate"); assert.match(hit.sub, /UTM 32N 381234 5634567/);
});

test("UTM <-> WGS84 ohne proj4: Abweichung zu pyproj < 0,5 m an allen Prüfpunkten (>= 10)", () => {
  assert.ok(UTM_FX.punkte.length >= 10);
  let maxInv = 0, maxFwd = 0;
  for (const p of UTM_FX.punkte) {
    const r = Search.utmToWgs84(p.e, p.n, 32);
    maxInv = Math.max(maxInv, distM(r.lat, r.lon, p.lat, p.lon));
    const u = Search.wgs84ToUtm(p.lat, p.lon, 32);
    maxFwd = Math.max(maxFwd, Math.hypot(u.e - p.e, u.n - p.n));
  }
  assert.ok(maxInv < 0.5, `inverse ${maxInv} m`);
  assert.ok(maxFwd < 0.5, `vorwärts ${maxFwd} m`);
  assert.ok(maxInv < 0.001 && maxFwd < 0.001, `erwartet Millimeter-Genauigkeit: ${maxInv}, ${maxFwd}`);
});

test("Plausibilität: außerhalb Gebiet/DGM wird gekennzeichnet", () => {
  loadReal();
  const koeln = Search.parseCoordinate("50.9375, 6.9603");
  assert.ok(!koeln.imGebiet && !koeln.imDgm);
  assert.ok(koeln.warnungen.some((w) => /Suchgebiets/.test(w)) && koeln.warnungen.some((w) => /DGM/.test(w)));
  const hennefSued = Search.parseCoordinate("50.71, 7.30"); // im Suchgebiet (Hennef), südlich des DGM-Ausschnitts
  assert.ok(hennefSued.imGebiet && !hennefSued.imDgm);
  assert.equal(Search.parseCoordinate("95.0, 7.0").fehler, "Koordinate außerhalb des gültigen Bereichs");
});

// ------------------------------------------------------------------ Rettungspunkte (echte KWF-Daten)
test("Rettungspunkte: Nummer tolerant (Bindestrich/Leerzeichen/Groß-Klein/Umlaut), höchste Priorität bei exakter Nummer", () => {
  loadReal();
  for (const t of ["01-501-SU", "01 501 SU", "01501su", "rp 01-501-SU", "Rettungspunkt 01-501-su"]) {
    const h = first(t);
    assert.equal(h.typ, "rettungspunkt", t); assert.equal(h.label, "01-501-SU", t);
  }
  for (const t of ["RÖS 5101", "roes5101", "Rös-5101", "ros 5101"]) assert.equal(first(t).label, "RÖS 5101", t);
  assert.equal(first("02-8950-1 GM").label, "02-8950-1 GM");
  // exakte RP-Nummer schlägt Straßen-/Adress-Lesart ("RÖS 5101" könnte Straße "Rös..." + Nr. sein)
  const r = q("RÖS 5101", 5);
  assert.equal(r[0].typ, "rettungspunkt");
  assert.ok(r[0].score > r[1].score);
  // Präfix listet passende Nummern
  assert.ok(q("01-50", 10).some((h) => h.label === "01-501-SU"));
  assert.match(first("01-501-SU").quelle, /KWF-Rettungspunkte/);
});

test("Rettungspunkte: KWF-Gesamtdatensatz v2.21 unverändert übernommen (alle Attribute, Koordinaten ohne Rundung)", () => {
  loadReal();
  assert.deepEqual(RP.meta.spalten, ["geom_lon", "geom_lat", "RP_Nr", "WGS_Breite", "WGS_Laenge", "Ortsbeschr", "Schild", "Urheber", "Bundesland", "Staat"]);
  assert.equal(RP.meta.version, "2.21");
  assert.equal(RP.meta.stand, "2026-10");
  assert.equal(RP.meta.anzahl_gesamt, 71621);
  assert.equal(RP.meta.anzahl, RP.rows.length);
  const [s, w, n, e] = RP.meta.auswahl_bbox;
  for (const r of RP.rows) {
    assert.ok(r[1] >= s && r[1] <= n && r[0] >= w && r[0] <= e, "nur räumliche Auswahl");
    assert.equal(r.length, RP.meta.spalten.length);
  }
  // Punktgeometrie in voller Genauigkeit (Shape-Werte), nicht auf 6 Stellen gerundet
  assert.ok(RP.rows.some((r) => String(r[0]).split(".")[1].length > 6));
  const list = Search.rettungspunkte();
  assert.equal(list.length, RP.rows.length);
  for (const f of KWF_FX) {
    const p = list.find((x) => x.nr === f.rp_nr);
    assert.ok(p, f.rp_nr);
    assert.equal(p.lat, f.lat); assert.equal(p.lon, f.lon);
    assert.equal(p.props.Ortsbeschr, f.ortsbeschr); assert.equal(p.props.Urheber, f.urheber);
    assert.equal(p.props.RP_Nr, f.rp_nr);
    assert.equal(p.ortsbeschr, f.ortsbeschr === "" ? null : f.ortsbeschr, "leere Beschreibung nur für die Anzeige als null");
  }
});

test("Rettungspunkte: Quellenvermerk mit Version und Links, Warnung bei Stand älter als 7 Monate", () => {
  loadReal();
  const i = Search.rpInfo(Date.UTC(2026, 10, 22));
  assert.equal(i.version, "2.21");
  assert.equal(i.standText, "10/2026");
  assert.equal(i.attributionText, "© KWF-Rettungspunkte v2.21, Datenurheber, www.rettungspunkte-forst.de");
  // Pflicht-Verlinkung (Vorgabe): "www.rettungspunkte-forst.de" -> Website, "Datenurheber" -> Metadaten-PDF
  assert.match(i.attributionHtml, /^© KWF-Rettungspunkte v2\.21, /);
  assert.match(i.attributionHtml, /<a href="https:\/\/rettungspunkte-forst\.de"[^>]*>www\.rettungspunkte-forst\.de<\/a>/);
  assert.match(i.attributionHtml, /<a href="https:\/\/docs\.rettungspunkte-forst\.de\/Metadaten_KWF_Rettungspunkte\.pdf"[^>]*>Datenurheber<\/a>/);
  assert.match(i.attributionHtml, /CC BY-ND 4\.0/);
  assert.equal(i.veraltet, false); assert.equal(i.warnung, null);
  assert.equal(i.faelligAb, "2027-05-07");
  assert.equal(Search.rpInfo(Date.UTC(2027, 4, 7)).veraltet, false);
  const old = Search.rpInfo(Date.UTC(2027, 4, 8));
  assert.equal(old.veraltet, true);
  assert.match(old.warnung, /älter als 7 Monate/);
  assert.match(first("01-501-SU").quelle, /KWF-Rettungspunkte v2\.21/);
});

// ------------------------------------------------------------------ Synthetische Daten (Logik ohne echte Daten)
test("Synthetisch: Rettungspunkt-Nummernsuche, Toleranz und Ranking", () => {
  loadSynth();
  assert.equal(first("99-123-xy").label, "99-123-XY");
  assert.equal(first("99123XY").label, "99-123-XY");
  assert.equal(first("xy 4567").label, "XY-4567");
  assert.equal(first("TOES1001").label, "TÖS 1001");
  assert.equal(first("tos 1001").label, "TÖS 1001");
  const r = q("Lindenhof", 5);
  assert.equal(r[0].label, "Am Lindenhof", "Straße vor RP-Beschreibung");
  assert.ok(r.some((h) => h.typ === "rettungspunkt" && h.label === "TÖS 1001"), "Beschreibung durchsuchbar");
});

test("Synthetisch: gleichnamige Straßen, Heimatkommune zuerst, Kontext entscheidet", () => {
  loadSynth();
  const r = q("Lindenstraße 1", 5);
  assert.equal(r[0].kommune, "Testdorf");
  assert.equal(r[1].kommune, "Nachbarstadt");
  assert.equal(first("Lindenstr 1, Nachbarstadt").kommune, "Nachbarstadt");
  assert.equal(first("Lindenstraße 3").kommune, "Nachbarstadt");
  assert.equal(first("Lindenstraße 2a").lat, 50.0502);
  assert.equal(first("Unterbach").typ, "ortsteil");
});

// ------------------------------------------------------------------ Laden und Online (Mock)
test("Lazy Loading: ensureLoaded lädt Index und RP genau einmal, auch bei parallelen Aufrufen", async () => {
  _reset();
  const calls = [];
  Search.configure({ fetch: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => (/rettungs/.test(url) ? RP : INDEX) }; } });
  assert.equal(Search.status().geladen, false);
  await Promise.all([Search.ensureLoaded(), Search.ensureLoaded(), Search.ensureLoaded()]);
  await Search.ensureLoaded();
  assert.equal(calls.length, 2, calls.join(","));
  assert.ok(Search.status().geladen);
  assert.equal(first("Seelscheid").label, "Seelscheid");
  Search.configure({ fetch: null });
});

test("Online (Nominatim, MOCK): max. 1 Anfrage/s, Cache, Gebietsbeschränkung, abschaltbar", async () => {
  loadReal();
  let clock = 1_000_000;
  const sent = [];
  Search.configure({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async (url) => {
      sent.push({ url, t: clock });
      return { ok: true, status: 200, json: async () => [{ lat: "50.85", lon: "7.33", display_name: "Testort, Neunkirchen-Seelscheid", name: "Testort", osm_type: "node", osm_id: 1, boundingbox: ["50.84", "50.86", "7.32", "7.34"], address: { village: "Testdorf" } }] };
    },
    online: { enabled: true, minIntervalMs: 1100 },
  });
  const res = await Promise.all([Search.online("Testort eins"), Search.online("Testort zwei"), Search.online("Testort drei")]);
  assert.equal(sent.length, 3);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].t - sent[i - 1].t >= 1100, `Abstand ${sent[i].t - sent[i - 1].t} ms`);
  const u = new URL(sent[0].url);
  assert.equal(u.searchParams.get("bounded"), "1");
  assert.equal(u.searchParams.get("format"), "jsonv2");
  assert.equal(u.searchParams.get("countrycodes"), "de");
  assert.equal(u.searchParams.get("viewbox").split(",").length, 4);
  assert.equal(res[0][0].typ, "online");
  assert.match(res[0][0].quelle, /OpenStreetMap/);
  assert.deepEqual(res[0][0].bbox, [50.84, 7.32, 50.86, 7.34]);
  // gleiche Anfrage erneut: aus dem Cache, keine neue Anfrage
  await Search.online("testort EINS");
  assert.equal(sent.length, 3);
  // zu kurz / abgeschaltet
  await assert.rejects(Search.online("ab"), /zu kurz/);
  Search.configure({ online: { enabled: false } });
  await assert.rejects(Search.online("Testort vier"), /abgeschaltet/);
  assert.equal(sent.length, 3);
  Search.configure({ online: { enabled: true }, fetch: null, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
});

test("Leistung: Suche über den ganzen Index unter 100 ms je Anfrage (Node)", () => {
  loadReal();
  const t0 = Date.now();
  for (const t of ["Seelscheid", "Hauptstraße 5", "Hermreath", "01-501-SU", "Zum Wirbel 12a", "Kolner Str 3"]) q(t);
  assert.ok((Date.now() - t0) / 6 < 100, `${(Date.now() - t0) / 6} ms`);
});

// ------------------------------------------------------------------ Einbindung in die App (0.5.0)
const ROOT = path.join(here, "..");
const readText = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("Einbindung: Loader (index.html) lädt Suche mit ?v=Version, Markup vorhanden, alle Pfade relativ", () => {
  const html = readText("index.html");
  const js = JSON.parse(html.match(/window\.WB_JS = (\[[^\]]+\])/)[1]);
  const css = JSON.parse(html.match(/window\.WB_CSS = (\[[^\]]+\])/)[1]);
  assert.ok(css.includes("css/search.css"), css.join(","));
  assert.ok(js.includes("js/search.js") && js.includes("js/search-ui.js"), js.join(","));
  assert.ok(js.indexOf("js/search.js") < js.indexOf("js/search-ui.js"), "search.js vor search-ui.js");
  assert.ok(js.indexOf("js/search-ui.js") < js.indexOf("js/app.js"), "Suche vor app.js (app.js verdrahtet sie)");
  assert.match(html, /<input id="sx-input"[^>]*role="combobox"/);
  assert.match(html, /<ul id="sx-list"[^>]*role="listbox"/);
  assert.match(html, /id="sx-card"/);
  assert.match(html, /id="search-sources"/);
  assert.match(html, /id="chk-search-online"/);
  // keine absoluten Pfade in den eigenen Dateien (GitHub Pages läuft unter /waldbrand-app/)
  for (const f of ["js/search.js", "js/search-ui.js", "css/search.css"]) {
    const t = readText(f);
    assert.ok(!/fetch\(\s*["'`]\//.test(t) && !/url\(\s*["']?\//.test(t) && !/["']\/data\//.test(t), `${f}: absoluter Pfad`);
  }
  assert.match(readText("js/search.js"), /indexUrl: "data\/suche-index\.json"/);
  assert.match(readText("js/search.js"), /rpUrl: "data\/rettungspunkte-kwf\.json"/);
});

test("Einbindung: Pflicht-Attribution in js/app.js stimmt mit data/rettungspunkte-kwf.json überein", () => {
  const app = readText("js/app.js");
  const kwf = app.match(/const KWF = \{([^}]+)\}/)[1];
  assert.match(kwf, new RegExp(`version: "${RP.meta.version}"`));
  assert.match(kwf, new RegExp(`veroeffentlicht: "${RP.meta.veroeffentlicht}"`));
  assert.match(kwf, new RegExp(`stand: "${RP.meta.stand.slice(5, 7)}/${RP.meta.stand.slice(0, 4)}"`));
  assert.match(kwf, new RegExp(`maxAgeMonths: ${Search.config.rpMaxAgeMonths}`));
  // Quellenvermerk wortgleich, Verlinkung wie vorgegeben
  assert.match(app, /© KWF-Rettungspunkte v\$\{KWF\.version\}, /);
  assert.match(app, /<a href="https:\/\/docs\.rettungspunkte-forst\.de\/Metadaten_KWF_Rettungspunkte\.pdf"[^>]*>Datenurheber<\/a>/);
  assert.match(app, /<a href="https:\/\/rettungspunkte-forst\.de"[^>]*>www\.rettungspunkte-forst\.de<\/a>/);
  assert.match(app, /CC BY-ND 4\.0/);
  assert.match(app, /Daten unverändert/);
  assert.match(app, /Version \$\{KWF\.version\}, Stand \$\{KWF\.stand\}/);
  // Suchindex: Geobasis NRW mit der im Repo verwendeten Lizenzangabe
  assert.match(app, /Gebäudereferenzen NRW/);
  assert.match(app, /dl-de\/zero-2-0/);
  for (const q of INDEX.meta.quellen) assert.match(q.lizenz, /dl-de\/zero-2-0/);
  // Links der Datei passen zur Vorgabe (Reihenfolge: erst Domain, dann Datenurheber)
  assert.deepEqual(Object.keys(RP.meta.quellenvermerk_links), ["www.rettungspunkte-forst.de", "Datenurheber"]);
  assert.equal(RP.meta.quellenvermerk_links["www.rettungspunkte-forst.de"], "https://rettungspunkte-forst.de");
  assert.equal(RP.meta.quellenvermerk_links.Datenurheber, "https://docs.rettungspunkte-forst.de/Metadaten_KWF_Rettungspunkte.pdf");
});
