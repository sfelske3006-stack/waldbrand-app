#!/usr/bin/env python3
"""
Erzeugt data/rettungspunkte-kwf.json aus dem offiziellen KWF-Gesamtdatensatz (Shapefile).

Quelle: KWF-Rettungspunkte (Kuratorium für Waldarbeit und Forsttechnik e.V.), Download nach Zustimmung zu den
Nutzungsbedingungen auf https://kwf2020.kwf-online.de/rettungspunkte-download/ (Datei KWF_RP_V<x>_SHP.zip).
Lizenz: CC BY-ND 4.0 + Haftungsausschluss. Die Daten werden INHALTLICH UNVERÄNDERT übernommen:
  - alle DBF-Attribute wie geliefert (Texte unverändert, Zahlen wie in der DBF),
  - Punktgeometrie als Gleitkommazahl ohne Rundung, keine Umprojektion (Shape ist bereits WGS84/EPSG:4326),
  - keine Korrektur, keine Umbenennung, keine Zusammenführung, keine Dubletten-Bereinigung.
Bearbeitung: nur räumliche Auswahl (BBox Gebiet + Puffer) und Formatwandlung Shapefile -> JSON-Zeilen.
Lizenzrechtlich zu prüfen (ND): ob Ausschnitt + Formatwandlung als "Bearbeitung" gelten. Laut KWF-Download-Seite ist
"Weiterverarbeiten der Daten z. B. zur Integration in Fachanwendungen" zulässig, "Verändern der Daten" nicht.

Rohdaten (entpacktes Shapefile) gehören NICHT ins Projektverzeichnis und werden nach dem Lauf gelöscht.

Aufruf (Zip zuerst mit `unzip -l` prüfen und in ein leeres Verzeichnis entpacken):
  python3 -I tools/build-rettungspunkte.py --shp kwf_raw/KWF_RP.shp --doku kwf_raw/KWF_RP_V2_21_Doku.txt \
      --zip KWF_RP_V2_21_SHP.zip --veroeffentlicht 2026-10-07 --out data --fixtures tests/fixtures [--wfs raw/kwf/rp_area.geojson]
"""
import argparse
import hashlib
import json
import math
import os
import random
import re
import sys

import shapefile  # pyshp

# Gebiet: BBox der 7 Kommunen laut DVG1 (50.6962-50.9877 N, 7.1742-7.5303 O) + ca. 2 km Puffer. [süd, west, nord, ost]
AREA_BBOX = [50.678, 7.145, 51.006, 7.559]
META_PDF = "https://docs.rettungspunkte-forst.de/Metadaten_KWF_Rettungspunkte.pdf"
SITE = "https://rettungspunkte-forst.de"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def read_doku(path):
    """Version und Stand aus KWF_RP_V*_Doku.txt (Windows-1252, obwohl dort UTF-8 angegeben ist)."""
    raw = open(path, "rb").read()
    try:
        txt = raw.decode("utf-8")
    except UnicodeDecodeError:
        txt = raw.decode("cp1252")
    m = re.search(r"Historie der Datenversionen\s+Version\s+(\d+\.\d+)\s+(\d{2})/(\d{4})", txt)
    if not m:
        raise SystemExit("Version/Stand in der Doku nicht gefunden")
    umfang = re.search(r"Umfang:\s*(\d+)\s*Punkte", txt[m.end():])
    return {"version": m.group(1), "stand": f"{m.group(3)}-{m.group(2)}", "umfang": int(umfang.group(1)) if umfang else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shp", required=True, help="KWF_RP.shp (entpackt)")
    ap.add_argument("--doku", required=True, help="KWF_RP_V*_Doku.txt aus demselben Paket")
    ap.add_argument("--zip", help="Original-Zip (nur für SHA-256 in den Metadaten)")
    ap.add_argument("--veroeffentlicht", help="Datum der Veröffentlichung laut Metadaten-PDF (JJJJ-MM-TT)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--wfs", help="optional: früherer WFS-Gebietsexport (GeoJSON) zum Abgleich")
    ap.add_argument("--seed", type=int, default=20261122)
    a = ap.parse_args()

    doku = read_doku(a.doku)
    base = os.path.splitext(a.shp)[0]
    prj = open(base + ".prj", encoding="utf-8").read()
    if "WGS_1984" not in prj or "PROJCS" in prj:
        raise SystemExit("Unerwartetes Koordinatensystem in .prj: " + prj)
    r = shapefile.Reader(base, encoding="utf-8")
    if r.shapeType != shapefile.POINT:
        raise SystemExit("Shapefile ist kein Punkt-Layer")
    fields = [f[0] for f in r.fields[1:]]
    total = len(r)
    log("Shapefile:", total, "Punkte, Felder:", fields, "Doku:", doku)
    if doku["umfang"] and doku["umfang"] != total:
        log("WARNUNG: Doku nennt", doku["umfang"], "Punkte, Shapefile hat", total)

    s, w, n, e = AREA_BBOX
    rows = []
    for sr in r.iterShapeRecords():
        if not sr.shape.points:
            continue
        lon, lat = sr.shape.points[0]
        if s <= lat <= n and w <= lon <= e:
            rows.append([lon, lat] + list(sr.record))  # Werte unverändert
    log("Im Gebiet (BBox", AREA_BBOX, "):", len(rows))

    ver = doku["version"]
    meta = {
        "quelle": "KWF-Rettungspunkte, Gesamtdatensatz Shapefile (KWF_RP.shp), Kuratorium für Waldarbeit und Forsttechnik e.V. (KWF)",
        "version": ver,
        "stand": doku["stand"],
        "veroeffentlicht": a.veroeffentlicht,
        "anzahl_gesamt": total,
        "anzahl": len(rows),
        "crs": "EPSG:4326 (WGS84) wie geliefert, keine Umprojektion",
        "lizenz": "CC BY-ND 4.0",
        "lizenz_url": "https://creativecommons.org/licenses/by-nd/4.0/legalcode.de",
        "haftungsausschluss": "https://kwf2020.kwf-online.de/rettungspunkte-download/",
        "quellenvermerk": f"© KWF-Rettungspunkte v{ver}, Datenurheber, www.rettungspunkte-forst.de",
        # Reihenfolge wichtig: Die App ersetzt die Schlüssel nacheinander im Quellenvermerk. Zuerst die Domain
        # (sonst würde sie in einem bereits eingefügten href getroffen), dann "Datenurheber".
        "quellenvermerk_links": {"www.rettungspunkte-forst.de": SITE, "Datenurheber": META_PDF},
        "aenderungen": "Inhalt unverändert (alle Attribute, Bezeichnungen und Koordinaten wie geliefert). "
                       "Bearbeitung nur: räumlicher Ausschnitt (BBox Gebiet + ca. 2 km) und Formatwandlung Shapefile -> JSON. "
                       "Lizenzrechtlich zu prüfen (ND).",
        "aktualisierung": "KWF exportiert etwa 2x jährlich. Laut Nutzungsbedingungen ist eine veraltete Version zu löschen und durch die aktuelle zu ersetzen. "
                          "Die App warnt, wenn die Veröffentlichung mehr als 7 Monate zurückliegt.",
        "auswahl_bbox": AREA_BBOX,
        "spalten": ["geom_lon", "geom_lat"] + fields,
        "sha256": {"KWF_RP.shp": sha256(base + ".shp"), "KWF_RP.dbf": sha256(base + ".dbf")},
    }
    if a.zip:
        meta["sha256"][os.path.basename(a.zip)] = sha256(a.zip)
    rp = {"v": 2, "meta": meta, "rows": rows}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "rettungspunkte-kwf.json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(rp, fh, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    log("geschrieben", p, os.path.getsize(p))

    # Größe, falls statt des Ausschnitts der vollständige Datensatz ausgeliefert würde (nur Messung, keine Datei)
    allrows = [[sr.shape.points[0][0], sr.shape.points[0][1]] + list(sr.record) for sr in r.iterShapeRecords() if sr.shape.points]
    full = json.dumps({"v": 2, "meta": meta, "rows": allrows}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    import gzip
    log("Vollständiger Datensatz als JSON wäre:", len(full), "Byte, gzip:", len(gzip.compress(full, 9)))

    # Test-Stichprobe: 5 zufällige Punkte aus dem Ausschnitt (unverändert)
    rnd = random.Random(a.seed)
    col = {c: i for i, c in enumerate(meta["spalten"])}
    smp = rnd.sample(rows, 5)
    os.makedirs(a.fixtures, exist_ok=True)
    json.dump([{"rp_nr": x[col["RP_Nr"]], "lon": x[0], "lat": x[1], "ortsbeschr": x[col["Ortsbeschr"]], "urheber": x[col["Urheber"]]} for x in smp],
              open(os.path.join(a.fixtures, "kwf-stichprobe.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # Abgleich mit früherem WFS-Export (Bericht, nichts wird übernommen)
    if a.wfs:
        wfs = json.load(open(a.wfs, encoding="utf-8"))
        wmap = {}
        for f in wfs["features"]:
            wmap.setdefault(f["properties"]["rp_nr"], []).append(f)
        smap = {}
        for x in rows:
            smap.setdefault(x[col["RP_Nr"]], []).append(x)
        only_s = sorted(set(smap) - set(wmap))
        only_w = sorted(set(wmap) - set(smap))
        both = sorted(set(smap) & set(wmap))
        dmax, dsum, nd, attr_diff = 0.0, 0.0, 0, []
        for k in both:
            x, f = smap[k][0], wmap[k][0]
            lon2, lat2 = f["geometry"]["coordinates"]
            d = math.hypot((x[1] - lat2) * 111320, (x[0] - lon2) * 111320 * math.cos(math.radians(lat2)))
            dmax = max(dmax, d); dsum += d; nd += 1
            pr = f["properties"]
            for sf, wf in (("Ortsbeschr", "ortsbeschr"), ("Schild", "schild"), ("Urheber", "urheber"), ("Bundesland", "bundesland")):
                sv, wv = x[col[sf]], pr.get(wf)
                if (sv or "") != (wv or ""):
                    attr_diff.append((k, sf, sv, wv))
        dup_s = {k: len(v) for k, v in smap.items() if len(v) > 1}
        rep = {"shape_im_gebiet": len(rows), "wfs_im_gebiet": len(wfs["features"]), "gemeinsam": len(both),
               "nur_shape": only_s, "nur_wfs": only_w, "doppelte_nummern_shape": dup_s,
               "lageabweichung_m": {"max": round(dmax, 3), "mittel": round(dsum / max(nd, 1), 3)},
               "attributabweichungen": len(attr_diff), "attributabweichungen_beispiele": attr_diff[:10]}
        print(json.dumps(rep, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
