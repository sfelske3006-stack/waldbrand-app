#!/usr/bin/env python3
"""
Erzeugt das Offline-Geländemodell der App (data/dgm25.bin + data/dgm25.json) aus dem
amtlichen DGM1 NRW (Geobasis NRW, Open Data, dl-de/zero-2-0).

Ablauf
  1. Gemeindegrenze Neunkirchen-Seelscheid aus den amtlichen Digitalen Verwaltungsgrenzen
     (DVG1, Geobasis NRW, EPSG:25832) lesen -> Bounding Box, plus Puffer (Standard 5 km).
  2. Zielraster in geografischen Koordinaten (EPSG:4326, ca. 25 m) festlegen.
     Begründung: js/grid.js rechnet mit lat/lon und einer lokalen Projektion um den
     Brandschwerpunkt (ohne proj4). Ein reguläres lat/lon-Raster lässt sich im Browser ohne
     Projektionsrechnung bilinear abfragen (js/dem.js). ETRS89 und WGS84 werden dabei
     gleichgesetzt (Abweichung < 1 m, bei 25 m Zellgröße unerheblich).
  3. Nur die nötigen 1x1-km-Kacheln laden (Namensschema dgm1_32_<E km>_<N km>_1_nw_<Jahr>.tif,
     E/N = linke untere Ecke in EPSG:25832), Verzeichnisindex von opengeodata.nrw.de.
  4. gdalbuildvrt + gdalwarp -r average (Flächenmittel 1 m -> ca. 25 m) nach EPSG:4326.
     Mit --stream wird jede Kachel sofort auf 5 m gemittelt und die 1-m-Rohdatei gelöscht
     (für knappe Plattenquoten).
  5. Ausgabe Int16 little-endian in Dezimetern (NoData -32768), Zeile 0 = Norden,
     plus Metadaten-JSON (Ursprung, Zellgröße, nx/ny, CRS, Quelle, Abrufdatum, Lizenz).

Voraussetzungen: GDAL-Kommandozeilenwerkzeuge (gdalbuildvrt, gdalwarp, gdaltransform, ogr2ogr),
Python 3.9+ mit numpy. Netz: www.opengeodata.nrw.de.

Aufruf (Rohdaten NICHT ins Projektverzeichnis legen):
  python3 tools/build-dgm.py --raw-dir /tmp/dgm_raw
  python3 tools/build-dgm.py --raw-dir /tmp/dgm_raw --stream      # wenig Plattenplatz
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

BASE_DGM = "https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/"
DVG_ZIP = "https://www.opengeodata.nrw.de/produkte/geobasis/vkg/dvg/dvg1/dvg1_EPSG25832_Shape.zip"
GEMEINDE = "Neunkirchen-Seelscheid"
GEMEINDE_KN = "05382040"  # amtlicher Gemeindeschlüssel laut DVG1
NODATA_OUT = -32768
# Zielauflösung in Grad: 0,000225° Breite = 25,0 m; 0,000355° Länge = 24,9 m bei 50,85° N
D_LAT = 0.000225
D_LON = 0.000355
LICENSE = "dl-de/zero-2-0"
LICENSE_URL = "https://www.govdata.de/dl-de/zero-2-0"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(url, dest=None, tries=4):
    last = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            if dest:
                tmp = dest + ".part"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, dest)
            return data
        except Exception as e:  # Netzfehler: kurz warten, erneut versuchen
            last = e
            time.sleep(2 + 3 * k)
    raise RuntimeError(f"Abruf fehlgeschlagen: {url}: {last}")


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{p.stderr}")
    return p.stdout


def transform(points, s_srs, t_srs):
    """Koordinaten mit gdaltransform umrechnen (Ausgabe x y je Zeile)."""
    inp = "\n".join(f"{x} {y}" for x, y in points) + "\n"
    p = subprocess.run(["gdaltransform", "-s_srs", s_srs, "-t_srs", t_srs, "-output_xy"],
                       input=inp, capture_output=True, text=True, check=True)
    return [tuple(map(float, l.split()[:2])) for l in p.stdout.strip().splitlines()]


def edge_points(x0, y0, x1, y1, n=40):
    pts = []
    for k in range(n + 1):
        t = k / n
        pts += [(x0 + (x1 - x0) * t, y0), (x0 + (x1 - x0) * t, y1), (x0, y0 + (y1 - y0) * t), (x1, y0 + (y1 - y0) * t)]
    return pts


def gemeinde_bbox(raw_dir):
    """Bounding Box der Gemeinde aus DVG1 (EPSG:25832) und Datenstand."""
    zpath = os.path.join(raw_dir, "dvg1_EPSG25832_Shape.zip")
    if not os.path.exists(zpath):
        log("Lade DVG1 (Verwaltungsgrenzen) …")
        fetch(DVG_ZIP, zpath)
    gj = run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", f"/vsizip/{zpath}/dvg1gem_nw.shp",
              "-where", f"KN = '{GEMEINDE_KN}'"])
    feats = json.loads(gj)["features"]
    if len(feats) != 1 or feats[0]["properties"].get("GN") != GEMEINDE:
        raise RuntimeError(f"Gemeinde {GEMEINDE} ({GEMEINDE_KN}) nicht eindeutig in DVG1 gefunden")
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for cc in c:
                walk(cc)
    walk(feats[0]["geometry"]["coordinates"])
    return (min(xs), min(ys), max(xs), max(ys)), feats[0]["properties"].get("STAND")


def tile_index(raw_dir):
    xml = fetch(BASE_DGM)
    with open(os.path.join(raw_dir, "index.xml"), "wb") as f:
        f.write(xml)
    root = ET.fromstring(xml)
    tiles = {}
    for fe in root.iter("file"):
        m = re.match(r"dgm1_32_(\d+)_(\d+)_1_nw_(\d{4})\.tif$", fe.get("name", ""))
        if not m:
            continue
        e, n, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        old = tiles.get((e, n))
        if old is None or y > old["year"]:
            tiles[(e, n)] = {"name": fe.get("name"), "size": int(fe.get("size")), "year": y, "timestamp": fe.get("timestamp")}
    meta = [m.get("name") for m in root.iter("metafile")]
    return tiles, meta


def tile_meta(raw_dir):
    """Aktualität je Kachel aus dgm1_meta.zip (CSV)."""
    zpath = os.path.join(raw_dir, "dgm1_meta.zip")
    try:
        if not os.path.exists(zpath):
            fetch(BASE_DGM + "dgm1_meta.zip", zpath)
        with zipfile.ZipFile(zpath) as z:
            txt = z.read("dgm1_nw.csv").decode("utf-8", "replace")
    except Exception as e:
        log("Hinweis: Kachel-Metadaten nicht lesbar:", e)
        return {}
    out = {}
    for line in txt.splitlines():
        p = line.split(";")
        if len(p) >= 9 and p[0].startswith("dgm1_32_"):
            out[p[0]] = {"aktualitaet": p[1], "genauigkeit_m": p[5], "crs_lage": p[6], "crs_hoehe": p[7]}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw-dir", required=True, help="Arbeitsverzeichnis für Rohdaten (nicht im Projekt!)")
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    ap.add_argument("--buffer-m", type=float, default=5000)
    ap.add_argument("--stream", action="store_true", help="Kacheln einzeln auf 5 m mitteln, 1-m-Rohdaten sofort löschen")
    ap.add_argument("--keep-raw", action="store_true", help="1-m-Kacheln nach dem Lauf behalten (Cache für Wiederholung)")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    raw = os.path.abspath(a.raw_dir)
    out_dir = os.path.abspath(a.out_dir)
    proj_root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    if raw.startswith(proj_root + os.sep):
        sys.exit("--raw-dir darf nicht im Projektverzeichnis liegen (Rohdaten ~1 GB).")
    os.makedirs(raw, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    tiles_dir = os.path.join(raw, "tiles")
    os.makedirs(tiles_dir, exist_ok=True)
    retrieved = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

    # 1. Gemeindegebiet + Puffer (UTM32)
    (gx0, gy0, gx1, gy1), dvg_stand = gemeinde_bbox(raw)
    b = a.buffer_m
    ux0, uy0, ux1, uy1 = gx0 - b, gy0 - b, gx1 + b, gy1 + b
    log(f"Gemeinde {GEMEINDE}: E {gx0:.0f}–{gx1:.0f}, N {gy0:.0f}–{gy1:.0f} (DVG1 Stand {dvg_stand}); mit Puffer {b:.0f} m")

    # 2. Zielraster lat/lon: Hülle des gepufferten UTM-Rechtecks, auf Rasterschritte gerundet
    ll = transform(edge_points(ux0, uy0, ux1, uy1), "EPSG:25832", "EPSG:4326")
    lon_min, lon_max = min(p[0] for p in ll), max(p[0] for p in ll)
    lat_min, lat_max = min(p[1] for p in ll), max(p[1] for p in ll)
    west = math.floor(lon_min / D_LON) * D_LON
    east = math.ceil(lon_max / D_LON) * D_LON
    south = math.floor(lat_min / D_LAT) * D_LAT
    north = math.ceil(lat_max / D_LAT) * D_LAT
    nx = int(round((east - west) / D_LON))
    ny = int(round((north - south) / D_LAT))
    east, north = west + nx * D_LON, south + ny * D_LAT
    log(f"Zielraster EPSG:4326: W {west:.6f} E {east:.6f} S {south:.6f} N {north:.6f}, {nx} x {ny} Zellen")

    # 3. Nötige Kacheln (UTM-Hülle des lat/lon-Rechtecks)
    back = transform(edge_points(west, south, east, north), "EPSG:4326", "EPSG:25832")
    e0 = int(math.floor(min(p[0] for p in back) / 1000)); e1 = int(math.floor(max(p[0] for p in back) / 1000))
    n0 = int(math.floor(min(p[1] for p in back) / 1000)); n1 = int(math.floor(max(p[1] for p in back) / 1000))
    index, metafiles = tile_index(raw)
    want = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    have = [k for k in want if k in index]
    missing = [k for k in want if k not in index]
    total_mb = sum(index[k]["size"] for k in have) / 1e6
    log(f"Kacheln E {e0}–{e1} km, N {n0}–{n1} km: {len(want)} benötigt, {len(have)} im Index ({total_mb:.0f} MB), fehlend: {len(missing)}")
    log(f"Metadateien im Verzeichnis: {metafiles}")
    tmeta = tile_meta(raw)

    # 4. Laden (parallel) und ggf. streamend mitteln
    mid_dir = os.path.join(raw, "tiles_5m")
    if a.stream:
        os.makedirs(mid_dir, exist_ok=True)

    def get(k):
        t = index[k]
        p = os.path.join(tiles_dir, t["name"])
        mid = os.path.join(mid_dir, t["name"].replace(".tif", "_5m.tif"))
        if a.stream and os.path.exists(mid):
            return mid
        if not (os.path.exists(p) and os.path.getsize(p) == t["size"]):
            fetch(BASE_DGM + t["name"], p)
            if os.path.getsize(p) != t["size"]:
                raise RuntimeError(f"Größe stimmt nicht: {t['name']}")
        if a.stream:
            run(["gdalwarp", "-q", "-overwrite", "-tr", "5", "5", "-r", "average", "-srcnodata", "-9999",
                 "-dstnodata", "-9999", "-ot", "Float32", "-co", "COMPRESS=DEFLATE", p, mid])
            os.remove(p)
            return mid
        return p

    paths, done = [], 0
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for p in ex.map(get, have):
            paths.append(p)
            done += 1
            if done % 25 == 0 or done == len(have):
                log(f"  {done}/{len(have)} Kacheln")

    vrt = os.path.join(raw, "dgm.vrt")
    lst = os.path.join(raw, "tiles.txt")
    with open(lst, "w") as f:
        f.write("\n".join(paths) + "\n")
    run(["gdalbuildvrt", "-q", "-overwrite", "-srcnodata", "-9999", "-vrtnodata", "-9999", "-input_file_list", lst, vrt])
    warped = os.path.join(raw, "dgm25_4326.envi")
    run(["gdalwarp", "-q", "-overwrite", "-t_srs", "EPSG:4326", "-te", repr(west), repr(south), repr(east), repr(north),
         "-ts", str(nx), str(ny), "-r", "average", "-srcnodata", "-9999", "-dstnodata", "-9999",
         "-ot", "Float32", "-of", "ENVI", "-wm", "1024", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", vrt, warped])

    # 5. Umwandeln in Int16-Dezimeter
    h = np.fromfile(warped, dtype="<f4")
    if h.size != nx * ny:
        raise RuntimeError(f"unerwartete Größe {h.size} != {nx * ny}")
    valid = h > -1000
    dm = np.full(h.shape, NODATA_OUT, dtype="<i2")
    dm[valid] = np.round(h[valid] * 10).astype("<i2")
    bin_path = os.path.join(out_dir, "dgm25.bin")
    dm.tofile(bin_path)
    sha = hashlib.sha256(dm.tobytes()).hexdigest()
    hv = h[valid]
    stats = {
        "min_m": round(float(hv.min()), 1), "max_m": round(float(hv.max()), 1),
        "mean_m": round(float(hv.mean()), 1), "p01_m": round(float(np.percentile(hv, 1)), 1),
        "p99_m": round(float(np.percentile(hv, 99)), 1),
        "nodata_cells": int((~valid).sum()), "cells": int(nx * ny),
    }
    akt = sorted({tmeta[index[k]["name"][:-4]]["aktualitaet"] for k in have if index[k]["name"][:-4] in tmeta})
    years = sorted({index[k]["year"] for k in have})
    gdal_version = run(["gdalinfo", "--version"]).strip()
    meta = {
        "format": "int16le, Dezimeter (Höhe = Wert/10 m), NoData -32768, Zeile 0 = Norden, Spalte 0 = Westen",
        "file": "dgm25.bin",
        "dtype": "int16le", "scale": 0.1, "unit": "m", "nodata": NODATA_OUT,
        "crs": "EPSG:4326",
        "crs_note": "Geografische Koordinaten (ETRS89 gleich WGS84 gesetzt, Abweichung < 1 m). Gewählt, weil js/grid.js mit lat/lon und lokaler Projektion arbeitet (kein proj4).",
        "vertical": "DHHN2016 (Normalhöhen NHN), laut Kachel-Metadaten DE_DHHN2016_NH",
        "west": west, "north": north, "east": east, "south": south,
        "dLon": D_LON, "dLat": D_LAT, "nx": nx, "ny": ny,
        "cellM_approx": [round(D_LON * math.pi / 180 * 6371008.8 * math.cos(math.radians((north + south) / 2)), 2),
                         round(D_LAT * math.pi / 180 * 6371008.8, 2)],
        "pixel": "Flächenpixel; Zellmitte Spalte c / Zeile r: lon = west + (c+0.5)*dLon, lat = north - (r+0.5)*dLat",
        "source": "DGM1 NRW (Digitales Geländemodell, Rasterweite 1 m, GeoTIFF), Geobasis NRW",
        "source_url": BASE_DGM,
        "source_owner": "Land Nordrhein-Westfalen, Bezirksregierung Köln, Geobasis NRW",
        "license": LICENSE, "license_url": LICENSE_URL,
        "attribution": "Geobasis NRW, dl-de/zero-2-0",
        "license_evidence": "Im Download-Verzeichnis keine Lizenzdatei (nur dgm1_meta.zip mit Kachelinformationen). dl-de/zero-2-0 laut Katalog-Metadaten und laut <Fees> der Geobasis-NRW-WMS (z. B. wms_nw_dgm-schummerung, GetCapabilities). Zu prüfen.",
        "retrieved": retrieved,
        "tiles": {"count": len(have), "missing_in_index": [f"{e}_{n}" for e, n in missing],
                  "range_km": {"E": [e0, e1], "N": [n0, n1]}, "years_in_filename": years,
                  "aktualitaet": [akt[0], akt[-1]] if akt else None,
                  "naming": "dgm1_32_<E km>_<N km>_1_nw_<Jahr>.tif, E/N = linke untere Ecke in EPSG:25832, 1000 x 1000 Pixel à 1 m"},
        "area": {"gemeinde": GEMEINDE, "kn": GEMEINDE_KN, "bbox_utm32": [gx0, gy0, gx1, gy1], "buffer_m": b,
                 "boundary_source": f"DVG1 Geobasis NRW (Stand {dvg_stand}), {DVG_ZIP}"},
        "processing": f"gdalbuildvrt + gdalwarp -r average (Flächenmittel) von 1 m nach ca. 25 m, EPSG:25832 -> EPSG:4326{', streamend über 5-m-Zwischenstufe' if a.stream else ''}; {gdal_version}; tools/build-dgm.py",
        "stats": stats,
        "sha256": sha,
    }
    with open(os.path.join(out_dir, "dgm25.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")
    log(f"Geschrieben: {bin_path} ({os.path.getsize(bin_path) / 1e6:.2f} MB) und dgm25.json")
    log(f"Höhen: min {stats['min_m']} m, max {stats['max_m']} m, Mittel {stats['mean_m']} m, NoData {stats['nodata_cells']} Zellen")
    if not (0 < stats["min_m"] < stats["max_m"] < 700):
        log("WARNUNG: Höhenbereich unplausibel für die Region – Ergebnis prüfen!")
    if not a.keep_raw and not a.stream:
        for p in paths:
            try:
                os.remove(p)
            except OSError:
                pass
    os.remove(warped)
    for ext in (".hdr", ".aux.xml"):
        if os.path.exists(warped.replace(".envi", ext)):
            os.remove(warped.replace(".envi", ext))
        if os.path.exists(warped + ext):
            os.remove(warped + ext)


if __name__ == "__main__":
    main()
