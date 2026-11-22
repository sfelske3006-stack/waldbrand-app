#!/usr/bin/env python3
"""
Erzeugt data/gemeindeteile.json: Gemarkungen der Gemeinde Neunkirchen-Seelscheid (ALKIS, Geobasis NRW)
mit Zuordnung zu den Gemeindeteilen Neunkirchen / Seelscheid (für die Bereitschaftsvorgabe 25/40 min).

Quelle: ALKIS "Grundrissdaten vereinfacht" (GeoPackage, Paketierung Kreis), Tabelle KatasterBezirk
(art = 'Gemarkung', gmdschl = '05382040') und VerwaltungsEinheit (ags = '05382040'),
https://www.opengeodata.nrw.de/produkte/geobasis/lk/akt/gru_vereinfacht_gpkg/ , dl-de/zero-2-0.

BEFUND (22.11.2026): Die Gemeinde hat 5 Gemarkungen: Eischeid, Herkenrath, Seelscheid, Söntgerath, Wolperath.
Eine Gemarkung "Neunkirchen" gibt es nicht; die frühere Gemeindegrenze (Zusammenschluss 1969) ist in den
offenen Daten nicht enthalten. Zuordnung daher:
  - Seelscheid -> Seelscheid (Name; Gerätehaus LZ Seelscheid liegt darin)        = belegt durch Daten
  - Wolperath  -> Neunkirchen (Gerätehaus LZ Neunkirchen liegt darin)            = Ableitung, zu prüfen
  - übrige     -> Teil des näheren Gerätehauses (Luftlinie zum Schwerpunkt)      = ANNAHME, zu prüfen
Gerätehaus-Koordinaten aus data/fahrzeuge.json (GEOBASIS.NRW Gebäudereferenzen).

Aufruf:  python3 tools/build-gemeindeteile.py --gpkg /pfad/gru_vereinf_05382000_Rhein-Sieg-Kreis_EPSG25832.gpkg
         (GeoPackage ca. 1 GB entpackt, Download ca. 340 MB; NICHT ins Projekt legen.)
Voraussetzung: GDAL (ogr2ogr).
"""
import argparse, json, math, os, subprocess, tempfile, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GMD = "05382040"


def ogr(gpkg, sql, out):
    subprocess.run(["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-simplify", "5",
                    "-lco", "COORDINATE_PRECISION=6", out, gpkg, "-sql", sql], check=True)
    with open(out, encoding="utf8") as f:
        return json.load(f)


def polys(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def inside(pt, ring):
    x, y = pt
    c = False
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def contains(geom, lat, lon):
    return any(inside((lon, lat), p[0]) and not any(inside((lon, lat), h) for h in p[1:]) for p in polys(geom))


def centroid(geom):
    pts = [p for poly in polys(geom) for p in poly[0]]
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def dist(a, b):
    k = math.cos(math.radians(a[0]))
    return math.hypot((a[0] - b[0]) * 111195, (a[1] - b[1]) * 111195 * k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gpkg", required=True)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "gemeindeteile.json"))
    a = ap.parse_args()
    with open(os.path.join(ROOT, "data", "fahrzeuge.json"), encoding="utf8") as f:
        wachen = {w["id"]: w for w in json.load(f)["wachen"]}
    gh = {"Neunkirchen": wachen["lz-nk"], "Seelscheid": wachen["lz-se"]}
    with tempfile.TemporaryDirectory() as td:
        gem = ogr(a.gpkg, f"SELECT name, schluessel, aktualit, geometrie FROM KatasterBezirk WHERE art='Gemarkung' AND gmdschl='{GMD}'", os.path.join(td, "g.json"))
        gde = ogr(a.gpkg, f"SELECT name, ags, aktualit, geometrie FROM VerwaltungsEinheit WHERE ags='{GMD}'", os.path.join(td, "v.json"))
    out = []
    for f in sorted(gem["features"], key=lambda x: x["properties"]["name"]):
        p, g = f["properties"], f["geometry"]
        teil, how = None, None
        if p["name"] == "Seelscheid":
            teil, how = "Seelscheid", "belegt: Name der Gemarkung; Gerätehaus LZ Seelscheid liegt in der Gemarkung"
        for t, w in gh.items():
            if w.get("lat") is not None and contains(g, w["lat"], w["lon"]) and not teil:
                teil, how = t, f"abgeleitet: Gerätehaus LZ {t} liegt in der Gemarkung (zu prüfen)"
        if not teil:
            c = centroid(g)
            d = {t: dist(c, (w["lat"], w["lon"])) for t, w in gh.items() if w.get("lat") is not None}
            teil = min(d, key=d.get)
            how = "ANNAHME: Teil des näheren Gerätehauses (Luftlinie zum Schwerpunkt: " + ", ".join(f"{t} {v / 1000:.1f} km" for t, v in d.items()) + "); historische Zugehörigkeit nicht belegt, zu prüfen"
        out.append({"name": p["name"], "schluessel": p["schluessel"], "stand": p["aktualit"], "teil": teil, "zuordnung": how, "polygone": polys(g)})
    res = {
        "beschreibung": "Gemarkungen Neunkirchen-Seelscheid mit Zuordnung zu den Gemeindeteilen (für Bereitschaft 25/40 min, Vorgabe Auftraggeber 22.11.2026)",
        "quelle": "ALKIS Grundrissdaten vereinfacht (KatasterBezirk/VerwaltungsEinheit), Geobasis NRW, opengeodata.nrw.de",
        "lizenz": "dl-de/zero-2-0", "attribution": "Geobasis NRW, dl-de/zero-2-0",
        "erzeugt": datetime.date.today().isoformat(), "crs": "EPSG:4326 (Koordinaten [lon, lat]), vereinfacht 5 m",
        "befund": "Keine Gemarkung 'Neunkirchen'; die Grenze der früheren Gemeinden (Zusammenschluss 1969) ist in den offenen Daten nicht enthalten. Zuordnung je Gemarkung siehe 'zuordnung' (teils ANNAHME).",
        "gemeinde": {"name": gde["features"][0]["properties"]["name"], "ags": GMD, "polygone": polys(gde["features"][0]["geometry"])},
        "gemarkungen": out,
    }
    with open(a.out, "w", encoding="utf8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{a.out}: {os.path.getsize(a.out) / 1024:.0f} KB")
    for g in out:
        print(f"  {g['name']}: {g['teil']} – {g['zuordnung']}")


if __name__ == "__main__":
    main()
