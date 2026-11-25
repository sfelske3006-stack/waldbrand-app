#!/usr/bin/env python3
"""
Erzeugt den Offline-Suchindex der App (data/suche-index.json) aus amtlichen Daten (Geobasis NRW).
Rettungspunkte: separates Skript tools/build-rettungspunkte.py (eigener Aktualisierungszyklus, andere Lizenz).

Quellen (Rohdaten NICHT ins Projektverzeichnis legen, nach dem Lauf löschen):
  --gebref      gebref.txt aus https://www.opengeodata.nrw.de/produkte/geobasis/lk/akt/gebref_txt/gebref_EPSG25832_ASCII.zip
                (Gebäudereferenzen NRW, Geobasis NRW, dl-de/zero-2-0), Semikolon, UTF-8, EPSG:25832
  --dvg         dvg1gem_nw.shp aus .../vkg/dvg/dvg1/dvg1_EPSG25832_Shape.zip (Gemeindegrenzen, dl-de/zero-2-0)
  --ortslage    sie01_f als GeoJSON (EPSG:25832) aus .../lm/akt/basis-dlm/basis-dlm_EPSG25832_Shape.zip
                (AX_Ortslage mit Attribut NAM; per HTTP-Range ausgelesen, siehe tools/httpzip.py)

Gebiet: Neunkirchen-Seelscheid + alle Gemeinden mit gemeinsamer Grenze laut DVG1 (ST_Intersects).

Ausgabe-Format suche-index.json (kompakt, gzip-freundlich):
  k: [[Gemeindeschlüssel, Name, bbox[s,w,n,e]], ...]           Index 0 = Neunkirchen-Seelscheid
  o: [[Name, kIdx, lat, lon, s, w, n, e], ...]                 Ortslagen (AX_Ortslage), Koordinaten in 1e-6 Grad
  s: [[Name, kIdx, oIdx|-1, "hnr,hnr,...", [lat0,lon0,dlat,dlon,...], "Qualität"?], ...]
     Hausnummern als Text inkl. Zusatz (z. B. "12a"), Koordinaten in Mikrograd, je Straße delta-kodiert.
     Qualität: nur vorhanden, wenn mindestens eine Adresse nicht "A" ist (ein Zeichen je Adresse).
Aufruf:
  python3 -I tools/build-suche.py --gebref raw/gebref/gebref.txt --dvg raw/dvg/dvg1gem_nw.shp \
      --ortslage raw/ortslage_bbox.geojson --out data --fixtures tests/fixtures
"""
import argparse
import collections
import datetime as dt
import json
import os
import random
import subprocess
import sys

from pyproj import Transformer

GEMEINDEN = ["05382040", "05378024", "05382060", "05382052", "05382028", "05382036", "05382020"]
NKS = "05382040"
T = Transformer.from_crs("EPSG:25832", "EPSG:4326", always_xy=True)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def to_ll(e, n):
    lon, lat = T.transform(e, n)
    return round(lat, 6), round(lon, 6)


def mic(v):
    return int(round(v * 1e6))


# ------------------------------------------------------------------ Geometrie (ohne shapely)
def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def ring_area_centroid(r):
    a = cx = cy = 0.0
    for i in range(len(r) - 1):
        x0, y0 = r[i][0], r[i][1]
        x1, y1 = r[i + 1][0], r[i + 1][1]
        c = x0 * y1 - x1 * y0
        a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
    if a == 0:
        return 0.0, r[0][0], r[0][1]
    return a / 2, cx / (3 * a), cy / (3 * a)


def point_in_ring(x, y, r):
    inside = False
    j = len(r) - 1
    for i in range(len(r)):
        xi, yi = r[i][0], r[i][1]
        xj, yj = r[j][0], r[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_poly(x, y, poly):  # poly = [outer, hole, ...]
    if not point_in_ring(x, y, poly[0]):
        return False
    return not any(point_in_ring(x, y, h) for h in poly[1:])


def label_point(poly):
    """Schwerpunkt, falls innen; sonst Mitte des längsten Innenabschnitts der Waagerechten durch den Schwerpunkt."""
    a, cx, cy = ring_area_centroid(poly[0])
    if point_in_poly(cx, cy, poly):
        return cx, cy
    xs = []
    for r in poly:
        for i in range(len(r) - 1):
            (x0, y0), (x1, y1) = r[i][:2], r[i + 1][:2]
            if (y0 > cy) != (y1 > cy):
                xs.append(x0 + (cy - y0) * (x1 - x0) / (y1 - y0))
    xs.sort()
    best = None
    for i in range(0, len(xs) - 1, 2):
        if best is None or xs[i + 1] - xs[i] > best[1] - best[0]:
            best = (xs[i], xs[i + 1])
    return ((best[0] + best[1]) / 2, cy) if best else (poly[0][0][0], poly[0][0][1])


def bbox_of(polys):
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_ll(b):
    """UTM-BBox (minx,miny,maxx,maxy) -> [s,w,n,e] in Mikrograd (Ecken transformiert, umschließend)."""
    pts = [to_ll(x, y) for x in (b[0], b[2]) for y in (b[1], b[3])]
    return [mic(min(p[0] for p in pts)), mic(min(p[1] for p in pts)), mic(max(p[0] for p in pts)), mic(max(p[1] for p in pts))]


# ------------------------------------------------------------------ Gemeinden
def load_gemeinden(dvg_shp, tmpdir):
    out = os.path.join(tmpdir, "gem_sel.geojson")
    where = "KN IN (%s)" % ",".join("'%s'" % k for k in GEMEINDEN)
    if os.path.exists(out):
        os.remove(out)
    subprocess.run(["ogr2ogr", "-f", "GeoJSON", "-where", where, out, dvg_shp], check=True)
    fc = json.load(open(out, encoding="utf-8"))
    gem = {}
    for f in fc["features"]:
        p = f["properties"]
        gem[p["KN"]] = {"kn": p["KN"], "name": p["GN"], "stand": p.get("STAND"), "polys": rings_of(f["geometry"])}
    # Nachbarschaft belegen (gemeinsame Grenze mit NKS) per SpatiaLite-Dialekt
    sql = ("SELECT b.KN, b.GN, ST_Length(ST_Intersection(a.geometry, b.geometry)) AS len FROM dvg1gem_nw a, dvg1gem_nw b "
           "WHERE a.KN='%s' AND b.KN<>a.KN AND ST_Intersects(a.geometry, b.geometry)" % NKS)
    r = subprocess.run(["ogrinfo", "-ro", "-dialect", "sqlite", "-sql", sql, dvg_shp], check=True, capture_output=True, text=True)
    neigh = {}
    cur = None
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("KN (String) = "):
            cur = line.split("= ", 1)[1]
        elif line.startswith("len (Real) = ") and cur:
            neigh[cur] = float(line.split("= ", 1)[1])
    assert set(neigh) | {NKS} == set(GEMEINDEN), f"Nachbarliste weicht ab: {sorted(neigh)}"
    os.remove(out)
    return gem, neigh


def gemeinde_of(gem, x, y):
    for kn in GEMEINDEN:
        for poly in gem[kn]["polys"]:
            if point_in_poly(x, y, poly):
                return kn
    return None


# ------------------------------------------------------------------ Hausnummern sortieren
def hnr_key(h):
    num = "".join(ch for ch in h if ch.isdigit())
    return (int(num) if num else 10 ** 9, h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gebref", required=True)
    ap.add_argument("--dvg", required=True)
    ap.add_argument("--ortslage", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--seed", type=int, default=20261122)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.fixtures, exist_ok=True)

    gem, neigh = load_gemeinden(a.dvg, a.out)
    korder = GEMEINDEN  # NKS zuerst, dann Nachbarn
    kidx = {kn: i for i, kn in enumerate(korder)}
    log("Nachbarn (gemeinsame Grenzlänge m):", {gem[k]["name"]: round(v) for k, v in neigh.items()})

    # ---------------- Ortslagen (Basis-DLM AX_Ortslage), nur benannte, Label-Punkt in einer der Gemeinden
    ofc = json.load(open(a.ortslage, encoding="utf-8"))
    groups = collections.defaultdict(list)
    for f in ofc["features"]:
        nam = (f["properties"].get("NAM") or "").strip()
        if not nam:
            continue
        for poly in rings_of(f["geometry"]):
            area, _, _ = ring_area_centroid(poly[0])
            lx, ly = label_point(poly)
            kn = gemeinde_of(gem, lx, ly)
            if kn:
                groups[(nam, kn)].append((abs(area), poly, (lx, ly)))
    ortslagen = []
    ortslage_polys = []  # für Zuordnung Straße -> Ortslage
    for (nam, kn), items in sorted(groups.items(), key=lambda t: (kidx[t[0][1]], t[0][0])):
        items.sort(key=lambda t: -t[0])
        lx, ly = items[0][2]  # Label-Punkt der größten Teilfläche
        lat, lon = to_ll(lx, ly)
        b = bbox_of([it[1] for it in items])
        oi = len(ortslagen)
        ortslagen.append([nam, kidx[kn], mic(lat), mic(lon)] + bbox_ll(b))
        for it in items:
            pb = bbox_of([it[1]])
            ortslage_polys.append((oi, pb, it[1]))
    log("Ortslagen im Gebiet:", len(ortslagen))

    def ortslage_at(x, y):
        for oi, pb, poly in ortslage_polys:
            if pb[0] <= x <= pb[2] and pb[1] <= y <= pb[3] and point_in_poly(x, y, poly):
                return oi
        return -1

    # ---------------- Gebäudereferenzen
    # Felder laut Datei/GetFeatureInfo: 0 Satzart, 1 OID, 2 Qualität, 3 Land, 4 Landname, 5 RBz, 6 RBz-Name,
    # 7 Kreis, 8 Kreisname, 9 Gemeinde, 10 Gemeindename, 11 "0000" (unbelegt), 12 leer (unbelegt),
    # 13 Straßenschlüssel, 14 Straßenname, 15 Hausnummer, 16 Zusatz, 17 UTM-Zone, 18 Ost, 19 Nord, 20 Stand
    want = {("3", kn[3:5], kn[5:8]): kn for kn in GEMEINDEN}
    streets = collections.OrderedDict()
    raw_records = []
    stand = set()
    n_addr = 0
    skipped = collections.Counter()
    with open(a.gebref, encoding="utf-8", newline="") as fh:
        for line in fh:
            p = line.rstrip("\r\n").split(";")
            if len(p) < 21 or p[3] != "05":
                continue
            kn = want.get((p[5], p[7], p[9]))
            if not kn:
                continue
            assert p[17] == "32", p
            if p[13] == "99999":  # Platzhalter ohne Straße ("<Gemeinde>, 99999"), nicht suchbar
                skipped["strasse_99999"] += 1
                continue
            e, n = float(p[18]), float(p[19])
            hnr = p[15] + p[16]
            key = (kn, p[13])
            st = streets.setdefault(key, {"name": p[14], "kn": kn, "addr": {}})
            assert st["name"] == p[14], (st["name"], p[14])
            if hnr in st["addr"]:
                # doppelte Hausnummer innerhalb einer Straße: erste behalten, zählen
                st.setdefault("dups", 0)
                st["dups"] += 1
                continue
            st["addr"][hnr] = (e, n, p[2])
            stand.add(p[20])
            raw_records.append(p)
            n_addr += 1
    dups = sum(st.get("dups", 0) for st in streets.values())
    skipped["doppelte_hausnummer"] = dups
    log("Adressen:", n_addr, "Straßen (Schlüssel):", len(streets), "Stand:", stand, "übersprungen:", dict(skipped))

    s_out = []
    for (kn, skey), st in sorted(streets.items(), key=lambda t: (kidx[t[0][0]], t[1]["name"], t[0][1])):
        hs = sorted(st["addr"].keys(), key=hnr_key)
        coords = []
        q = ""
        votes = collections.Counter()
        prev = None
        for h in hs:
            e, n, qual = st["addr"][h]
            lat, lon = to_ll(e, n)
            la, lo = mic(lat), mic(lon)
            if prev is None:
                coords += [la, lo]
            else:
                coords += [la - prev[0], lo - prev[1]]
            prev = (la, lo)
            q += qual
            votes[ortslage_at(e, n)] += 1
        oi, cnt = votes.most_common(1)[0]
        if oi < 0 or cnt * 2 < len(hs):
            oi = -1
        row = [st["name"], kidx[kn], oi, ",".join(hs), coords]
        if set(q) != {"A"}:
            row.append(q)
        s_out.append(row)

    gem_out = []
    for kn in korder:
        g = gem[kn]
        gem_out.append([kn, g["name"], bbox_ll(bbox_of(g["polys"]))])

    area_b = bbox_of([poly for kn in korder for poly in gem[kn]["polys"]])
    meta = {
        "format": "suche-index v1 (siehe tools/build-suche.py)",
        "erzeugt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "crs": "EPSG:4326, Koordinaten in Mikrograd (1e-6). ETRS89 = WGS84 gesetzt (Abweichung < 1 m). Umrechnung aus EPSG:25832 mit pyproj",
        "gebiet": {"kommunen": [{"kn": kn, "name": gem[kn]["name"], "nachbar_grenze_m": round(neigh.get(kn, 0))} for kn in korder],
                    "bbox": bbox_ll(area_b), "quelle": "DVG1 Geobasis NRW, Stand %s" % gem[NKS]["stand"]},
        "quellen": [
            {"name": "Gebäudereferenzen NRW (gebref)", "url": "https://www.opengeodata.nrw.de/produkte/geobasis/lk/akt/gebref_txt/gebref_EPSG25832_ASCII.zip",
             "stand": sorted(stand), "lizenz": "dl-de/zero-2-0", "lizenz_url": "https://www.govdata.de/dl-de/zero-2-0",
             "lizenz_beleg": "GetCapabilities WMS NW GEBAEUDEREFERENZEN (Fees)", "urheber": "Geobasis NRW"},
            {"name": "Basis-DLM NRW, Objektart AX_Ortslage (Ebene sie01_f, Attribut NAM)", "url": "https://www.opengeodata.nrw.de/produkte/geobasis/lm/akt/basis-dlm/basis-dlm_EPSG25832_Shape.zip",
             "stand": "Datei vom 2026-11-18 (NAS-Paket NWAT01_BDA_2026-10-31)", "lizenz": "dl-de/zero-2-0 (Geobasis NRW, laut allgemeinen Nutzungsbedingungen; Einzelbeleg zu prüfen)", "urheber": "Geobasis NRW"},
            {"name": "DVG1 Gemeindegrenzen", "url": "https://www.opengeodata.nrw.de/produkte/geobasis/vkg/dvg/dvg1/dvg1_EPSG25832_Shape.zip",
             "stand": gem[NKS]["stand"], "lizenz": "dl-de/zero-2-0", "lizenz_beleg": "GetCapabilities WMS NW DVG (Fees)", "urheber": "Geobasis NRW"},
        ],
        "anzahl": {"kommunen": len(gem_out), "ortslagen": len(ortslagen), "strassen": len(s_out), "adressen": n_addr,
                   "uebersprungen": dict(skipped)},
        "hinweise": [
            "Ortsteile = benannte Ortslagen des Basis-DLM (bebaute Flächen). Kleine Weiler/Wohnplätze ohne eigene Ortslage fehlen.",
            "Qualitätskennzeichen A/B/C aus gebref (Bedeutung laut Formatbeschreibung zu prüfen; Datei nicht abrufbar).",
            "Gleichnamige Straßen in einer Gemeinde (unterschiedliche Straßenschlüssel) bleiben getrennt; Ortslage zur Unterscheidung.",
        ],
    }
    index = {"v": 1, "meta": meta, "k": gem_out, "o": ortslagen, "s": s_out}
    p_idx = os.path.join(a.out, "suche-index.json")
    with open(p_idx, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))
    log("geschrieben", p_idx, os.path.getsize(p_idx))

    # ---------------- Fixtures: Stichprobe aus Rohdaten + UTM-Prüfpunkte (pyproj)
    rnd = random.Random(a.seed)
    sample = rnd.sample(raw_records, 10)
    fx = []
    for p in sample:
        e, n = float(p[18]), float(p[19])
        lon, lat = T.transform(e, n)
        fx.append({"raw": ";".join(p), "kommune": p[10], "strasse": p[14], "hnr": p[15] + p[16],
                   "e": e, "n": n, "lat": round(lat, 6), "lon": round(lon, 6)})
    json.dump(fx, open(os.path.join(a.fixtures, "gebref-stichprobe.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    pts = []
    # Gebietsecken, Mitte, Zonenränder und entfernte Punkte (Genauigkeit der eigenen Formel prüfen)
    for e, n in [(area_b[0], area_b[1]), (area_b[2], area_b[3]), (area_b[0], area_b[3]), (area_b[2], area_b[1]),
                 ((area_b[0] + area_b[2]) / 2, (area_b[1] + area_b[3]) / 2), (381234, 5634567), (500000, 5600000),
                 (166021.44, 0.01), (833978.56, 9000000), (280000, 5200000), (720000, 6100000), (300000, 5900000),
                 (450000, 5300000), (386000.123, 5636000.456)]:
        lon, lat = T.transform(e, n)
        pts.append({"e": e, "n": n, "lat": lat, "lon": lon})
    for _ in range(12):
        e = rnd.uniform(area_b[0] - 20000, area_b[2] + 20000)
        n = rnd.uniform(area_b[1] - 20000, area_b[3] + 20000)
        lon, lat = T.transform(e, n)
        pts.append({"e": e, "n": n, "lat": lat, "lon": lon})
    json.dump({"crs": "EPSG:25832 -> EPSG:4326 (pyproj %s)" % __import__("pyproj").__version__, "punkte": pts},
              open(os.path.join(a.fixtures, "utm-pyproj.json"), "w", encoding="utf-8"), indent=1)

    log("Fixtures geschrieben")


if __name__ == "__main__":
    main()
