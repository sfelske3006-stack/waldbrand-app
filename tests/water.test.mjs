// Tests Modul Wasserversorgung (Entwurf). Start: node --test tests/water.test.mjs
// Synthetische Szenarien (KEINE echten Entnahmestellen). Alle Zahlen sind Annahmen aus js/water-params.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WP = require("../js/water-params.js");
const Water = require("../js/water.js");
const Dem = require("../js/dem.js");

const params = (over = {}) => {
  const W = JSON.parse(JSON.stringify(WP));
  for (const [k, v] of Object.entries(over)) Object.assign(W[k], v);
  return W;
};
const pr = Water.makeProj(50.85, 7.35);
const at = (x, y) => { const [lat, lon] = pr.toLL(x, y); return { lat, lon }; };
const hydrant = (id, x, y, tags = {}) => ({ id, ...at(x, y), kind: "fire_hydrant", tags: { emergency: "fire_hydrant", ...tags }, source: "OSM", verified: false });
const veh = (id, typ, tank, pump, anf, extra = {}) => ({ id, typ, bezeichnung: `${typ} (${id})`, kommune: "Testkommune", tank_l: tank, pumpe_lpm: pump, anfahrtMin: anf, ...extra });
const cons = (id, x, y, readyMin, kind = "Riegel", extra = {}) => ({ id, label: id, ...at(x, y), readyMin, tankL: 2000, kind, ...extra });
const base = (W, o) => ({ W, consumers: [], vehicles: [], sources: [], basins: null, terrain: null, hazard: null, roads: null, ...o });

/** Massenbilanz und Grenzen je Becken: 0 <= Füllstand <= Volumen, Füllstand(t+1) = Füllstand(t) + Zufluss - Abfluss. */
function checkBalance(sim, W) {
  for (const b of sim.basins) {
    for (let k = 0; k <= sim.N; k++) {
      assert.ok(b.level[k] >= -1e-9, `${b.id} t=${k}: Füllstand negativ (${b.level[k]})`);
      assert.ok(b.level[k] <= W.becken.volumenL + 1e-6, `${b.id} t=${k}: Überlauf (${b.level[k]})`);
    }
    for (let k = 0; k < sim.N; k++) {
      const exp = b.level[k] + (b.inflow[k] - b.outflow[k]) * sim.dt;
      assert.ok(Math.abs(b.level[k + 1] - exp) < 1e-6, `${b.id} t=${k}: Bilanz ${b.level[k + 1]} != ${exp}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ Pendelzyklus
test("Pendelzyklus: Handbeispiel TLF 4000 an Hydrant 800 l/min, 2 km Luftlinie", () => {
  const W = params();
  const s = Water.classifySource(hydrant("h", 0, 0), W);
  const b = { ...at(0, 2000), slowM: 0 };
  s.slowM = 0;
  const c = Water.cycle({ tank_l: 4000, pumpe_lpm: 2000 }, s, b, W);
  // Handrechnung: Weg 2.000 m x 1,3 = 2,6 km bei 25 km/h = 6,24 min je Richtung
  //   Füllen 3 min Rüsten + 4.000 l / min(800 Hydrant, 2.000 Pumpe, 1.600 Füllgrenze) = 3 + 5 = 8 min
  //   Entleeren 2 min Rüsten + 4.000 l / 1.600 l/min = 4,5 min; Umlauf 8 + 6,24 + 4,5 + 6,24 = 24,98 min
  assert.ok(Math.abs(Water.distM(s, b) - 2000) < 0.5);
  assert.ok(Math.abs(c.driveMin - 6.24) < 0.01, `Fahrt ${c.driveMin}`);
  assert.equal(c.fillMin, 8);
  assert.equal(c.unloadMin, 4.5);
  assert.ok(Math.abs(c.cycleMin - 24.98) < 0.01, `Umlauf ${c.cycleMin}`);
  assert.ok(Math.abs(c.lpm - 4000 / 24.98) < 0.1, `Lieferung ${c.lpm}`); // ca. 160 l/min
});

test("Pendelzyklus: Simulation trifft das Handbeispiel (14 Entleerungen in 6 h)", () => {
  const W = params();
  // Becken liegt 2 km vom Hydranten; Abnehmer brauchen mehr als geliefert wird (Becken nie voll)
  const r = Water.run(base(W, {
    consumers: [cons("A1", 0, 2000, 0, "Riegel", { demandLpm: 1000, tankL: 0 })],
    vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 10)],
    sources: [hydrant("h", 0, 0)],
    basins: [{ id: "B1", ...at(0, 2000) }],
  }));
  const v = r.sim.vehicles.find((x) => x.id === "tlf");
  // erste Entleerung (voll angereist): 10 + 4,5 = 14,5 min, danach alle 24,98 min
  const expected = 1 + Math.floor((360 - 14.5) / 24.98);
  assert.equal(v.cycles, expected, `Entleerungen ${v.cycles} statt ${expected}`);
  assert.equal(Math.round(v.deliveredL), 4000 * expected);
  checkBalance(r.sim, W);
});

// ------------------------------------------------------------------------------------------------ Grenze
test("Grenze Schlauchleitung vs. Pendelverkehr bei maxSchlauchwegM (konfigurierbar)", () => {
  const mk = (W, luftM) => Water.planSupply(base(W, {
    consumers: [cons("A1", 0, luftM, 30)],
    vehicles: [veh("lf1", "LF 20", 2000, 2000, 15), veh("lf2", "LF 10", 1200, 1000, 18), veh("tlf", "TLF 3000", 3000, 2000, 25)],
    sources: [hydrant("h", 0, 0)],
    basins: [{ id: "B1", ...at(0, luftM) }],
  }));
  const W = params();
  const inside = mk(W, 590 / W.schlauch.umwegFaktor); // Schlauchweg 590 m
  const outside = mk(W, 610 / W.schlauch.umwegFaktor); // Schlauchweg 610 m
  assert.equal(inside.basins[0].supply.kind, "schlauch");
  assert.ok(Math.abs(inside.basins[0].supply.hose.lengthM - 590) < 0.5);
  assert.equal(inside.vehicles.find((v) => v.role === "pumpe").cls.stufe, 3, "Pumpe an der Entnahmestelle: Löschfahrzeug, nicht der Tanker");
  assert.equal(outside.basins[0].supply.kind, "pendel");
  assert.ok(outside.vehicles.some((v) => v.role === "pendel"));
  const W2 = params({ schlauch: { maxSchlauchwegM: 800 } });
  assert.equal(mk(W2, 610 / W2.schlauch.umwegFaktor).basins[0].supply.kind, "schlauch");
});

test("Förderstrecke: Höhenunterschied erfordert Verstärkerpumpe, ohne zweite Pumpe weniger Durchfluss", () => {
  const W = params();
  const s = Water.classifySource(hydrant("h", 0, 0, { flow_rate: "1600" }), W);
  const b = at(0, 450); // Schlauchweg 540 m
  const flat = { elevation: () => 200 };
  const slope = { elevation: (lat) => 200 + ((lat - s.lat) * 111195) * (40 / 450) }; // +40 m auf 450 m
  const h0 = Water.hoseDesign(s, b, flat, W, 800);
  // Reibung 1,0 bar/100 m bei 800 l/min: 5,4 bar <= 8 - 1,5 = 6,5 bar -> eine Pumpe
  assert.equal(h0.pumps, 1); assert.equal(h0.boosters, 0);
  assert.ok(Math.abs(h0.lossBar - 5.4) < 1e-9);
  const h1 = Water.hoseDesign(s, b, slope, W, 800);
  // 5,4 bar + 40 m x 0,1 bar/m = 9,4 bar > 6,5 -> zwei Pumpen (eine Verstärkerpumpe)
  assert.ok(Math.abs(h1.dhMaxM - 40) < 0.5, `dh ${h1.dhMaxM}`);
  assert.equal(h1.pumps, 2); assert.equal(h1.boosters, 1);
  const h2 = Water.hoseDesign(s, b, slope, W, 800, 1);
  // nur eine Pumpe: Q = 800 x sqrt((6,5 - 4,0) / 5,4) = ca. 544 l/min
  assert.equal(h2.reduced, true);
  assert.ok(Math.abs(h2.flowLpm - 800 * Math.sqrt(2.5 / 5.4)) < 2, `Q ${h2.flowLpm}`);
});

test("DGM aus dem Projekt (nur lesen): Höhenprofil einer Förderstrecke plausibel", { skip: !fs.existsSync(path.join(HERE, "../data/dgm25.bin")) && "data/dgm25.bin fehlt" }, () => {
  const meta = JSON.parse(fs.readFileSync(path.join(HERE, "../data/dgm25.json"), "utf8"));
  const buf = fs.readFileSync(path.join(HERE, "../data/dgm25.bin"));
  const dem = Dem.fromBuffer(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const terrain = { elevation: (lat, lon) => dem.sample(lat, lon) };
  const W = params();
  const s = { ...Water.classifySource(hydrant("h", 0, 0), W) };
  const p = Water.hoseProfile(s, at(300, 300), terrain, W);
  assert.equal(p.ok, true);
  assert.ok(p.z0 > 50 && p.z0 < 400, `Höhe ${p.z0}`);
  assert.ok(p.dhMax >= 0 && p.dhMax < 150);
});

// ------------------------------------------------------------------------------------------------ Becken
test("Becken: läuft nie über, Zufuhr wird gedrosselt; Massenbilanz exakt", () => {
  const W = params();
  const r = Water.run(base(W, {
    consumers: [cons("A1", 0, 300, 20, "Objektschutz")], // 2 x 100 l/min
    vehicles: [veh("lf1", "LF 20", 2000, 2000, 10)],
    sources: [hydrant("h", 0, 0)],
  }));
  const b = r.sim.basins[0];
  assert.equal(r.plan.basins[0].supply.kind, "schlauch");
  assert.equal(b.maxLevel, W.becken.volumenL);
  assert.ok(b.throttledL > 0, "Förderstrecke muss gedrosselt werden");
  for (let k = 0; k < r.sim.N; k++) if (b.level[k] >= W.becken.volumenL - 1e-9) assert.ok(b.inflow[k] <= b.outflow[k] + W.becken.volumenL - b.level[k] + 1e-6);
  assert.equal(r.sim.kpi.totalUnmetL, 0);
  checkBalance(r.sim, W);
});

test("Becken ohne Versorgung bleibt leer; Abnehmer nutzt den eigenen Tank bis leer", () => {
  const W = params();
  const r = Water.run(base(W, { consumers: [cons("A1", 0, 0, 30, "Riegel", { tankL: 1500 })], vehicles: [], sources: [] }));
  const b = r.sim.basins[0], c = r.sim.consumers[0];
  assert.equal(b.readyMin, Infinity);
  assert.ok(b.level.every((v) => v === 0));
  assert.equal(c.firstDryMin, 30 + 1500 / 300); // 300 l/min ab 30 min
  assert.equal(c.fromTankL, 1500);
  assert.equal(Math.round(c.unmetL), (360 - 35) * 300);
  assert.ok(r.sim.diagnosis.some((d) => d.code === "becken_ohne_versorgung"));
});

test("Becken leert sich mit dem Verbrauch und meldet das erste Leerlaufen", () => {
  const W = params();
  // ein TLF mit weitem Weg: Becken wird gefüllt und läuft zwischen den Lieferungen leer
  const r = Water.run(base(W, {
    consumers: [cons("A1", 0, 3000, 0, "Riegel", { tankL: 0 })],
    vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 10)],
    sources: [hydrant("h", 0, 0)],
    basins: [{ id: "B1", ...at(0, 3000) }],
  }));
  const b = r.sim.basins[0];
  assert.ok(b.firstEmptyMin !== null && b.firstEmptyMin > b.firstFillMin);
  // während Entnahme ohne Zufluss sinkt der Füllstand genau um 300 l/min
  let seen = 0;
  for (let k = 0; k < r.sim.N; k++) if (b.inflow[k] === 0 && b.level[k] >= 300) { assert.ok(Math.abs(b.level[k] - b.level[k + 1] - 300) < 1e-6); seen++; }
  assert.ok(seen > 10);
  checkBalance(r.sim, W);
});

// ------------------------------------------------------------------------------------------------ Warteschlange
test("Warteschlange am Hydranten: FIFO, ein Füllplatz -> Wartezeit; drei Füllplätze -> keine", () => {
  const mk = (W) => Water.simulate(Water.planSupply(base(W, {
    consumers: [cons("A1", 0, 1500, 0, "Riegel", { demandLpm: 2000, tankL: 0 })],
    vehicles: [veh("t1", "TLF 4000", 4000, 2000, 10), veh("t2", "TLF 4000", 4000, 2000, 10), veh("t3", "TLF 4000", 4000, 2000, 10)],
    sources: [hydrant("h", 0, 0, { flow_rate: "4800" })],
    basins: [{ id: "B1", ...at(0, 1500) }],
  })));
  // leer angereist: alle drei kommen gleichzeitig (10 min) am Hydranten an
  const W1 = params({ pendel: { anfahrtVoll: false } }); W1.quellen.hydrant.maxGleichzeitig = 1;
  const W3 = params({ pendel: { anfahrtVoll: false } }); W3.quellen.hydrant.maxGleichzeitig = 3;
  const s1 = mk(W1), s3 = mk(W3);
  // Füllen je 3 min Rüsten + 4.000 l / 1.600 l/min = 5,5 min: t2 wartet 5,5 min, t3 11 min (erste Runde)
  const firstFill = (sim, id) => { const v = sim.vehicles.find((x) => x.id === id); return v.state.findIndex((st) => Water.STATES[st] === "fuellen"); };
  // Zeitreihe = Zustand am Ende jeder Minute; Nachrücken aus der Warteschlange zu Beginn des nächsten
  // Minutenschritts (Diskretisierung <= 1 min): t1 füllt ab 10, t2 ab 16 (statt 15,5), t3 ab 22 (statt 21,5)
  assert.deepEqual(["t1", "t2", "t3"].map((id) => firstFill(s1, id)), [10, 17, 23], "FIFO-Reihenfolge und Füllzeit 5,5 min");
  assert.ok(s1.sources[0].waitMin >= 16.5, `Wartezeit ${s1.sources[0].waitMin}`);
  assert.equal(s1.sources[0].maxQueue, 2);
  assert.equal(s3.sources[0].waitMin, 0);
  assert.ok(s3.kpi.deliveredLpm >= s1.kpi.deliveredLpm);
  checkBalance(s1, W1);
});

// ------------------------------------------------------------------------------------------------ Fahrzeugauswahl
test("Großtanker bevorzugt für Pendelverkehr trotz längerer Anfahrt", () => {
  const W = params();
  const p = Water.planSupply(base(W, {
    consumers: [cons("A1", 0, 2500, 30)], // 300 l/min
    vehicles: [veh("lf", "LF 20", 2000, 2000, 12), veh("tlf", "TLF 3000", 3000, 2000, 25), veh("tw", "TW 17000 (Tankwagen)", 17000, null, 55, { kommune: "Hennef (Sieg)" })],
    sources: [hydrant("h", 0, 0, { flow_rate: "1600" })],
  }));
  const pend = p.vehicles.filter((v) => v.role === "pendel").map((v) => v.id);
  assert.equal(pend[0], "tw", `Reihenfolge ${pend}`);
  assert.equal(p.vehicles.find((v) => v.id === "tw").cls.label, "Großtanker");
  assert.equal(p.vehicles.find((v) => v.id === "lf").role, "reserve", "LF wird nicht gebraucht, obwohl es zuerst da wäre");
});

test("Grundschutz-, Pflicht- und NK-Fahrzeuge sind ausgeschlossen (auch wenn sie übergeben werden)", () => {
  const W = params();
  const vehicles = [
    veh("gs-hlf", "HLF 20", 2000, 2000, 12, { kommune: "Ruppichteroth" }),
    veh("se-hlf20", "HLF 20", 2000, 2000, 10, { kommune: "Neunkirchen-Seelscheid" }),
    veh("x-pflicht", "LF 20", 2000, 2000, 10, { pflicht: true }),
    veh("nk-lf20", "LF 20", 2000, 2000, 8, { kommune: "Neunkirchen-Seelscheid" }),
    veh("elw", "ELW 1", 0, null, 8),
    veh("wlf", "WLF 26 + AB Wasser", null, null, 40),
    veh("weit", "TLF 4000", 4000, 2000, 120),
    veh("ok-tlf", "TLF 4000", 4000, 2000, 30, { kommune: "Lohmar" }),
    veh("ok-hlf", "HLF 20", 2000, 2000, 14, { kommune: "Much" }),
  ];
  const exclude = { grundschutzIds: ["gs-hlf"], pflichtIds: ["se-hlf20", "se-lfkats", "se-lf20"], assignedIds: [] };
  const e = Water.eligibleSupplyVehicles(vehicles, exclude, W);
  assert.deepEqual(e.eligible.map((v) => v.id), ["ok-tlf", "ok-hlf"]);
  const why = Object.fromEntries(e.excluded.map((x) => [x.id, x.reason]));
  assert.match(why["gs-hlf"], /Grundschutz/);
  assert.match(why["se-hlf20"], /Pflicht/);
  assert.match(why["x-pflicht"], /Pflicht/);
  assert.match(why["nk-lf20"], /eigenen Kommune/);
  assert.match(why.elw, /kein Löschwasser/);
  assert.match(why.wlf, /Tankvolumen/);
  assert.match(why.weit, /Anfahrt über 90/);
  const p = Water.planSupply(base(W, { consumers: [cons("A1", 0, 2500, 30)], vehicles, exclude, sources: [hydrant("h", 0, 0)] }));
  const ids = new Set(p.vehicles.map((v) => v.id));
  for (const id of ["gs-hlf", "se-hlf20", "x-pflicht", "nk-lf20", "elw", "wlf", "weit"]) assert.ok(!ids.has(id), `${id} eingeplant`);
});

test("Fahrzeug ohne Pumpe füllt nicht aus offenem Gewässer", () => {
  const W = params();
  const sp = { id: "s", ...at(0, 0), kind: "suction_point", tags: { emergency: "suction_point" }, source: "OSM" };
  const s = Water.classifySource(sp, W);
  assert.equal(s.needsPump, true);
  assert.equal(Water.cycle({ tank_l: 17000, pumpe_lpm: null }, s, at(0, 2000), W).ok, false);
  const p = Water.planSupply(base(W, { consumers: [cons("A1", 0, 2000, 30)], vehicles: [veh("tw", "TW 17000 (Tankwagen)", 17000, null, 40)], sources: [sp] }));
  assert.equal(p.vehicles[0].role, "reserve");
});

// ------------------------------------------------------------------------------------------------ Diagnose
test("Engpassdiagnose: zu wenige Tanker -> 'zusätzlich X Tanker'", () => {
  const W = params();
  const r = Water.run(base(W, {
    consumers: [cons("A1", 0, 3000, 30), cons("A2", 150, 3000, 30)], // 600 l/min
    vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 25)],
    sources: [hydrant("h", 0, 0, { flow_rate: "1600" })],
  }));
  const d = r.sim.diagnosis.find((x) => x.code === "tanker_fehlen");
  assert.ok(d, r.sim.diagnosis.map((x) => x.code).join(","));
  const expected = Math.ceil(r.sim.kpi.unmetLpm / r.sim.kpi.perTankerLpm - 1e-9);
  assert.equal(d.count, expected);
  assert.ok(d.count >= 2);
});

test("Engpassdiagnose: Hydrant überlastet -> Entnahmestelle benannt, keine Tanker-Empfehlung", () => {
  const W = params();
  const r = Water.run(base(W, {
    consumers: [cons("A1", 0, 1200, 30), cons("A2", 150, 1200, 30), cons("A3", 300, 1200, 30)],
    vehicles: ["a", "b", "c", "d", "e"].map((k, i) => veh(`t${k}`, "TLF 4000", 4000, 2000, 15 + i)),
    sources: [hydrant("h", 0, 0, { flow_rate: "400" })],
  }));
  const codes = r.sim.diagnosis.map((x) => x.code);
  assert.ok(codes.includes("quelle_ueberlastet") || codes.includes("quelle_engpass"), codes.join(","));
  assert.ok(!codes.includes("tanker_fehlen"));
  assert.ok(r.sim.diagnosis.find((x) => /quelle/.test(x.code)).text.includes("h"));
});

test("Löschwasserbehälter mit endlichem Volumen wird erschöpft und gemeldet", () => {
  const W = params();
  const tank = { id: "wt", ...at(0, 0), kind: "water_tank", tags: { emergency: "water_tank", water_volume: "10" }, source: "OSM" };
  const r = Water.run(base(W, { consumers: [cons("A1", 0, 1500, 20)], vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 15)], sources: [tank] }));
  const s = r.sim.sources[0];
  assert.ok(s.depletedAt !== null);
  assert.ok(s.usedL <= 10000 + 1e-6);
  assert.ok(r.sim.diagnosis.some((d) => d.code === "quelle_leer"));
});

// ------------------------------------------------------------------------------------------------ Entnahmestellen
test("Entnahmestellen: Ergiebigkeit aus OSM-Tags, sonst gekennzeichnete Annahme; Gewässer eingestuft", () => {
  const W = params();
  const c = (tags, extra = {}) => Water.classifySource({ id: "x", lat: 50.85, lon: 7.35, tags, source: "OSM", ...extra }, W);
  assert.equal(c({ emergency: "fire_hydrant", flow_rate: "1200" }).capLpm, 1200);
  assert.equal(c({ emergency: "fire_hydrant", flow_rate: "72 m3/h" }).capLpm, 1200);
  const d80 = c({ emergency: "fire_hydrant", "fire_hydrant:diameter": "80" });
  assert.equal(d80.capLpm, 600); assert.match(d80.capWhy, /ANNAHME/);
  const none = c({ emergency: "fire_hydrant" });
  assert.equal(none.capLpm, W.quellen.hydrant.defaultLpm); assert.equal(none.status, "Annahme"); assert.ok(none.annahmen.includes("Ergiebigkeit"));
  assert.equal(c({ emergency: "water_tank", water_volume: "150" }).volumeL, 150000);
  assert.equal(c({ emergency: "fire_water_pond" }).volumeL, W.quellen.behaelter.defaultM3 * 1000);
  assert.equal(c({ natural: "water" }, { areaM2: 100 }).usable, false);
  assert.equal(c({ natural: "water" }, { areaM2: 8000 }).status, "ausreichend");
  assert.equal(c({ natural: "water" }, { areaM2: 1000 }).status, "unsicher");
  assert.equal(c({ waterway: "stream" }, { wasserTyp: "waterway_stream" }).status, "unsicher");
  assert.equal(Water.classifySource({ id: "m", lat: 50.85, lon: 7.35, kind: "manuell erfasst", source: "manuell", verified: true }, W).typ, "unbekannt");
});

// Regression: nearest() startete früher bei 50 m Suchradius; bei maxM < 50 lief die Schleife nie und
// lieferte immer null (Becken galten dadurch als "kein Weg in der Nähe", Gewässerzugänge fielen weg).
test("roadNet.nearest: auch Suchradien unter 50 m liefern den nächsten Punkt", () => {
  const roads = Water.roadNet([{ latlngs: [[at(-500, 0).lat, at(-500, 0).lon], [at(500, 0).lat, at(500, 0).lon]], kind: 1 }]);
  const p = at(0, 2); // 2 m seitlich der Straße
  for (const maxM of [3, 5, 10, 30, 49, 50, 100]) {
    const n = roads.nearest(p.lat, p.lon, maxM);
    assert.ok(n, `maxM ${maxM}: kein Punkt gefunden`);
    assert.ok(Math.abs(n.d - 2) < 0.5, `maxM ${maxM}: Abstand ${n.d}`);
  }
  assert.equal(roads.nearest(p.lat, p.lon, 1), null, "kleiner als der Abstand -> null");
  const far = at(0, 300);
  assert.equal(roads.nearest(far.lat, far.lon, 30), null);
  assert.ok(Math.abs(roads.nearest(far.lat, far.lon, 1000).d - 300) < 1);
  assert.ok(Math.abs(roads.slowDistM(far.lat, far.lon) - 300) < 1);
});

test("Entnahmestellen aus Overpass: Bach nur an Wegen zugänglich, Teich ohne Weg verworfen", () => {
  const W = params();
  const roads = Water.roadNet([{ latlngs: [[at(-500, 0).lat, at(-500, 0).lon], [at(500, 0).lat, at(500, 0).lon]], kind: 1 }]);
  const ll = (x, y) => { const p = at(x, y); return { lat: p.lat, lon: p.lon }; };
  const json = { elements: [
    { type: "way", id: 1, tags: { waterway: "stream", name: "Testbach" }, geometry: [ll(0, -800), ll(0, 800)] }, // kreuzt die Straße bei (0,0)
    { type: "way", id: 2, tags: { natural: "water" }, geometry: [ll(1000, 1000), ll(1100, 1000), ll(1100, 1100), ll(1000, 1100), ll(1000, 1000)] }, // 1 ha, weit weg vom Weg
    { type: "node", id: 3, ...ll(100, 10), tags: { emergency: "fire_hydrant", "fire_hydrant:type": "underground" } },
  ] };
  const r = Water.sourcesFromOsm(json, roads, W);
  const ids = r.points.map((p) => p.id);
  assert.ok(ids.includes("way/1#1"), ids.join(","));
  assert.equal(ids.filter((i) => i.startsWith("way/1")).length, 1);
  assert.ok(!ids.includes("way/2"));
  assert.ok(r.rejected.some((x) => x.id === "way/2"));
  assert.equal(Water.classifySource(r.points.find((p) => p.id === "node/3"), W).label, "Unterflurhydrant");
});

// ------------------------------------------------------------------------------------------------ Standorte
test("Becken-Standort: außerhalb der 6-h-„möglich“-Zone mit Sicherheitsabstand, an befahrbarem Weg", () => {
  const W = params();
  // Brand bei (0,0), "möglich"-Zone kreisförmig mit 3 m/min -> 1.080 m nach 6 h
  const hazard = { center: at(0, 0), possibleMinAt: (lat, lon) => Water.distM(at(0, 0), { lat, lon }) / 3 };
  const road = (y) => ({ latlngs: [[at(-2000, y).lat, at(-2000, y).lon], [at(2000, y).lat, at(2000, y).lon]], kind: 1 });
  const roads = Water.roadNet([road(1000), road(1300)]);
  const p = Water.planSupply(base(W, { consumers: [cons("A1", 0, 1050, 40), cons("A2", 200, 1050, 40)], hazard, roads, sources: [hydrant("h", 0, 3000)], vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 20)] }));
  assert.equal(p.basins.length, 1);
  const b = p.basins[0];
  assert.equal(b.safety.level, 1, b.safety.text);
  assert.ok(Water.distM(b, at(0, 0)) >= 1080 + W.becken.sicherheitM - 1, `Abstand ${Water.distM(b, at(0, 0))}`);
  assert.ok(roads.nearest(b.lat, b.lon, 5), "Becken liegt am Weg");
  // vom Nutzer in die Zone verschoben -> Warnung, Rechnung mit den Nutzerkoordinaten
  const p2 = Water.planSupply(base(W, { consumers: [cons("A1", 0, 1050, 40)], hazard, roads, basins: [{ id: "B1", ...at(0, 400) }, { id: "B2", ...at(0, 900) }], sources: [hydrant("h", 0, 3000)], vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 20)] }));
  assert.equal(p2.basins[0].manual, true);
  assert.ok(Math.abs(p2.basins[0].lat - at(0, 400).lat) < 1e-12);
  // B1: Zone (± 100 m) nach 100 min, vor Bereitschaft + 120 min -> unsicher; B2: nach 267 min -> nur bis dahin nutzbar
  assert.equal(p2.basins[0].safety.level, 3);
  assert.equal(p2.basins[1].safety.level, 2);
  assert.ok(Math.abs(p2.basins[1].safety.untilMin - 800 / 3) < 1);
  assert.ok(p2.warnings.some((w) => w.includes("B1")) && p2.warnings.some((w) => w.includes("B2")));
});

test("Nachplanung: Becken-Engpass durch Großtanker -> zusätzliches Becken (nur automatische Becken)", () => {
  const W = params();
  const inp = base(W, {
    consumers: [cons("A1", 0, 1000, 30), cons("A2", 200, 1000, 40)],
    vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 20), veh("tw", "TW 17000 (Tankwagen)", 17000, null, 35), veh("lf", "LF 20", 2000, 2000, 15)],
    sources: [hydrant("h", 0, -1000)],
  });
  const r = Water.run(inp);
  assert.ok(r.plan.basins.length >= 2, r.log.join("; "));
  assert.ok(r.log.some((l) => /Becken-Engpass/.test(l)));
  const single = Water.simulate(Water.planSupply({ ...inp, extraShuttle: 0 }));
  assert.ok(r.sim.kpi.unmetLpm < single.kpi.unmetLpm);
  const manual = Water.run({ ...inp, basins: [{ id: "B1", ...at(100, 1100) }] });
  assert.equal(manual.plan.basins.length, 1, "vom Nutzer gesetzte Becken bleiben unverändert");
});

// ------------------------------------------------------------------------------------------------ Determinismus, Performance
function bigScenario(W) {
  const vehicles = [];
  const typs = [["TLF 4000", 4000, 2000], ["TLF 3000", 3000, 2000], ["HLF 20", 2000, 2000], ["LF 10", 1200, 1000], ["LF 20", 2000, 2000]];
  for (let i = 0; i < 18; i++) { const [t, tank, pump] = typs[i % typs.length]; vehicles.push(veh(`v${i + 1}`, t, tank, pump, 12 + i * 3)); }
  vehicles.push(veh("tw", "TW 17000 (Tankwagen)", 17000, null, 50), veh("ltw", "LTW (Löschwassertransportwagen)", 14000, null, 70));
  const consumers = [];
  for (let i = 0; i < 6; i++) consumers.push(cons(`R${i + 1}`, -500 + i * 200, 1200, 30 + i * 5));
  consumers.push(cons("O1", 1500, -200, 25, "Objektschutz"), cons("O2", 1600, -100, 35, "Objektschutz"));
  const sources = [hydrant("h1", 1500, -350), hydrant("h2", -2500, 0, { flow_rate: "1200" }), hydrant("h3", 2500, 2500),
    { id: "sp", ...at(0, 2200), kind: "suction_point", tags: { emergency: "suction_point" }, source: "OSM" }];
  return base(W, { consumers, vehicles, sources });
}
const plain = (o) => JSON.stringify(o, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v === Infinity ? "Inf" : v));

test("Determinismus: zweimal gleiche Eingabe -> identisches Ergebnis (inkl. Zeitreihen)", () => {
  const W = params();
  const a = Water.run(bigScenario(W)), b = Water.run(bigScenario(W));
  assert.equal(plain(a.sim), plain(b.sim));
  assert.equal(plain(Water.summary(a.plan, a.sim)), plain(Water.summary(b.plan, b.sim)));
});

test("Performance: 20 Fahrzeuge, 8 Abnehmer, 6 h in 1-min-Schritten < 200 ms", () => {
  const W = params();
  const inp = bigScenario(W);
  Water.run(inp); // Aufwärmen (JIT)
  const t0 = performance.now();
  const plan = Water.planSupply({ ...inp, extraShuttle: 0 });
  const sim = Water.simulate(plan);
  const t1 = performance.now();
  const r = Water.run(inp);
  const t2 = performance.now();
  console.log(`# Planung+Simulation ${(t1 - t0).toFixed(1)} ms, run() mit ${r.iterations} Läufen ${(t2 - t1).toFixed(1)} ms, Fahrzeuge ${plan.vehicles.length}, Schritte ${sim.N}`);
  assert.equal(plan.vehicles.length, 20);
  assert.ok(t1 - t0 < 200, `${(t1 - t0).toFixed(1)} ms`);
  assert.ok(t2 - t1 < 200 * r.iterations, `${(t2 - t1).toFixed(1)} ms`);
  checkBalance(r.sim, W);
});

test("Animation: Position zwischen den Minutenwerten linear, vor Eintreffen ohne Herkunft unsichtbar", () => {
  const W = params();
  const r = Water.run(base(W, {
    consumers: [cons("A1", 0, 2000, 0, "Riegel", { demandLpm: 1000 })],
    vehicles: [veh("tlf", "TLF 4000", 4000, 2000, 10), veh("tw", "TW 17000 (Tankwagen)", 17000, null, 30, { originLat: at(0, -8000).lat, originLon: at(0, -8000).lon })],
    sources: [hydrant("h", 0, 0)],
    basins: [{ id: "B1", ...at(0, 2000) }],
  }));
  const vi = r.sim.vehicles.findIndex((x) => x.id === "tlf");
  assert.ok(Number.isNaN(Water.vehicleAt(r.sim, vi, 5).lat), "ohne Herkunft während der Anfahrt nicht auf der Karte");
  const ti = r.sim.vehicles.findIndex((x) => x.id === "tw");
  const p10 = Water.vehicleAt(r.sim, ti, 10), p11 = Water.vehicleAt(r.sim, ti, 11), pm = Water.vehicleAt(r.sim, ti, 10.5);
  assert.equal(p10.state, "anfahrt");
  assert.ok(Math.abs(pm.lat - (p10.lat + p11.lat) / 2) < 1e-12);
});
