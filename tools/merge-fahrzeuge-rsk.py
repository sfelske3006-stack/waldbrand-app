#!/usr/bin/env python3
"""
Führt die Kreis-Recherche (fahrzeuge_rsk.json, wasserführende Fahrzeuge Rhein-Sieg-Kreis) mit
data/fahrzeuge.json zusammen.

Regeln:
  - Fahrzeuge der FF Neunkirchen-Seelscheid ohne Löschwasser (ELW, MTF, DLK, GW-G, KEF) aus data/fahrzeuge.json
    BLEIBEN (die Kreis-Recherche hat Fahrzeuge ohne Tank bewusst weggelassen).
  - Wasserführende Fahrzeuge: Eintrag der Kreis-Recherche (gleiche id) ersetzt den bisherigen, ids bleiben stabil
    (Pflichtfahrzeuge se-hlf20, se-lf20, se-lfkats).
  - Wachen: Felder der Kreis-Recherche ergänzen/überschreiben (u. a. Koordinaten aus GEOBASIS.NRW-Gebäudereferenzen).
  - Alle Angaben der Kreis-Recherche: "ungeprüft, aus Websuche" (Feld zugriff/quelle_typ je Fahrzeug).

Aufruf: python3 tools/merge-fahrzeuge-rsk.py /pfad/fahrzeuge_rsk.json   (schreibt data/fahrzeuge.json)
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "fahrzeuge.json")


def main():
    rsk = json.load(open(sys.argv[1], encoding="utf8"))
    old = json.load(open(OUT, encoding="utf8"))
    # Basis: bisherige Datei (nur bei erstem Lauf schema 1); bei erneutem Lauf alte NKS-Einträge erhalten
    old_v = {v["id"]: v for v in old["fahrzeuge"]}
    rsk_v = {v["id"]: v for v in rsk["fahrzeuge"]}
    fahrzeuge = []
    for v in old["fahrzeuge"]:
        if v.get("kommune", "Neunkirchen-Seelscheid") != "Neunkirchen-Seelscheid" and v["id"] in rsk_v:
            continue  # wird unten aus der Kreis-Recherche übernommen
        if v["id"] in rsk_v:
            merged = {**v, **rsk_v[v["id"]]}
            merged["quelle_hinweis"] = (rsk_v[v["id"]].get("quelle_hinweis") or "") + " | zusammengeführt mit data/fahrzeuge.json (0.3.0)"
            fahrzeuge.append(merged)
        elif v.get("kommune", "Neunkirchen-Seelscheid") == "Neunkirchen-Seelscheid":
            v = dict(v)
            v.setdefault("kommune", "Neunkirchen-Seelscheid")
            v.setdefault("einheit", {"lz-nk": "Löschzug Neunkirchen (LZ1)", "lz-se": "Löschzug Seelscheid (LZ2)"}.get(v.get("wache")))
            v.setdefault("quelle_typ", "offiziell")
            v.setdefault("zugriff", "Suchindex (Direktabruf gesperrt)")
            fahrzeuge.append(v)
    have = {v["id"] for v in fahrzeuge}
    for v in rsk["fahrzeuge"]:
        if v["id"] not in have:
            fahrzeuge.append(v)
    old_w = {w["id"]: w for w in old["wachen"]}
    wachen = []
    for w in rsk["wachen"]:
        base = old_w.get(w["id"], {})
        wachen.append({**base, **w})
    have_w = {w["id"] for w in wachen}
    for w in old["wachen"]:
        if w["id"] not in have_w:
            wachen.append(w)
    for w in wachen:
        w.setdefault("typ", "FF")
    out = {
        "schema_version": 2,
        "stand": rsk.get("stand"),
        "gebiet": rsk.get("gebiet"),
        "hinweis": "UNGEPRÜFT, AUS WEBSUCHE: " + rsk.get("hinweis", "") + " Fahrzeuge ohne Löschwasser nur für Neunkirchen-Seelscheid (aus ffnkse.de, Suchindex).",
        "quellen": {"neunkirchen_seelscheid": old.get("quellen"), "kreis": rsk.get("quellen")},
        "kommunen": rsk.get("kommunen"),
        "kreisweit": rsk.get("kreisweit"),
        "wachen": wachen,
        "fahrzeuge": fahrzeuge,
    }
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"{OUT}: {len(fahrzeuge)} Fahrzeuge, {len(wachen)} Wachen, {os.path.getsize(OUT) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
