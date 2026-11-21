/*
 * Digitales Geländemodell (Offline-Datei data/dgm25.bin + data/dgm25.json, erzeugt mit
 * tools/build-dgm.py aus dem DGM1 NRW, Geobasis NRW, dl-de/zero-2-0).
 *
 * Raster in geografischen Koordinaten (EPSG:4326), Int16 in Dezimetern, Zeile 0 = Norden.
 * sample(lat, lon) interpoliert bilinear zwischen Zellmitten und liefert null außerhalb des
 * Rasters oder wenn eine beteiligte Zelle NoData ist. Fehlt die Datei, liefert load() dem = null
 * und einen Fehlertext; die App rechnet dann wie bisher ohne Hang (mit Warnung).
 */
(function (root) {
  function fromBuffer(meta, buf) {
    const n = meta.nx * meta.ny;
    if (!buf || buf.byteLength !== n * 2) throw new Error(`DGM-Datei hat ${buf ? buf.byteLength : 0} Byte, erwartet ${n * 2}`);
    // Int16 little-endian; auf Big-Endian-Systemen umkopieren
    let data;
    const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (le) data = new Int16Array(buf.slice ? buf.slice(0) : buf);
    else {
      const dv = new DataView(buf); data = new Int16Array(n);
      for (let k = 0; k < n; k++) data[k] = dv.getInt16(2 * k, true);
    }
    const dem = { meta, data, nodata: meta.nodata ?? -32768, scale: meta.scale ?? 0.1 };
    dem.sample = (lat, lon) => sample(dem, lat, lon);
    return dem;
  }

  /** Höhe in m an Zelle (Spalte c, Zeile r) oder null. */
  function cellValue(dem, c, r) {
    const { nx, ny } = dem.meta;
    if (c < 0 || r < 0 || c >= nx || r >= ny) return null;
    const v = dem.data[r * nx + c];
    return v === dem.nodata ? null : v * dem.scale;
  }

  /** Bilineare Höhe in m oder null (außerhalb / NoData). */
  function sample(dem, lat, lon) {
    const m = dem.meta;
    if (!(lon >= m.west && lon <= m.east && lat >= m.south && lat <= m.north)) return null;
    // Position in Zellmitten-Koordinaten; am Rand auf die äußerste Zellmitte begrenzen
    const fx = Math.min(Math.max((lon - m.west) / m.dLon - 0.5, 0), m.nx - 1);
    const fy = Math.min(Math.max((m.north - lat) / m.dLat - 0.5, 0), m.ny - 1);
    const c0 = Math.floor(fx), r0 = Math.floor(fy);
    const c1 = Math.min(c0 + 1, m.nx - 1), r1 = Math.min(r0 + 1, m.ny - 1);
    const tx = fx - c0, ty = fy - r0;
    const a = cellValue(dem, c0, r0), b = cellValue(dem, c1, r0), c = cellValue(dem, c0, r1), d = cellValue(dem, c1, r1);
    if (a === null || b === null || c === null || d === null) return null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /**
   * Lädt Metadaten und Binärdatei. fetchFn austauschbar (Tests).
   * @returns {Promise<{dem: object|null, error: string|null}>}
   */
  async function load(url, fetchFn) {
    const f = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return { dem: null, error: "fetch nicht verfügbar" };
    try {
      const r = await f(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const meta = await r.json();
      const binUrl = url.replace(/[^/]*$/, "") + (meta.file || "dgm25.bin");
      const rb = await f(binUrl, { cache: "no-cache" });
      if (!rb.ok) throw new Error(`${binUrl}: HTTP ${rb.status}`);
      return { dem: fromBuffer(meta, await rb.arrayBuffer()), error: null };
    } catch (e) {
      return { dem: null, error: String((e && e.message) || e) };
    }
  }

  /** Base64 (eingebettete Vorschau) -> ArrayBuffer */
  function fromBase64(meta, b64) {
    const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const u = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    return fromBuffer(meta, u.buffer);
  }

  /** Kurzbeschreibung für Ergebnis und Protokoll. */
  function describe(dem) {
    if (!dem) return null;
    const m = dem.meta;
    return {
      quelle: m.source, lizenz: m.license, attribution: m.attribution,
      stand: m.tiles && m.tiles.aktualitaet ? `${m.tiles.aktualitaet[0]} bis ${m.tiles.aktualitaet[1]}` : "unbekannt",
      abgerufen: m.retrieved, aufloesung_m: m.cellM_approx, crs: m.crs, sha256: m.sha256,
    };
  }

  /**
   * Schummerung (Hillshade) des ganzen DGM als RGBA-Bild (nur Schatten dunkel, Lichtseiten hell,
   * ebene Flächen transparent). Horn-Gradient, Lichtquelle azimuthDeg/altitudeDeg.
   * @returns {width, height, rgba: Uint8ClampedArray}
   */
  function hillshadeRGBA(dem, opt) {
    const o = Object.assign({ azimuthDeg: 315, altitudeDeg: 45, zFactor: 1, shadowAlpha: 200, lightAlpha: 90 }, opt || {});
    const m = dem.meta, nx = m.nx, ny = m.ny;
    const latC = ((m.north + m.south) / 2) * Math.PI / 180;
    const dx = m.dLon * Math.PI / 180 * 6371008.8 * Math.cos(latC), dy = m.dLat * Math.PI / 180 * 6371008.8;
    const az = (360 - o.azimuthDeg + 90) * Math.PI / 180; // mathematischer Winkel
    const zen = (90 - o.altitudeDeg) * Math.PI / 180;
    const flat = Math.cos(zen);
    const rgba = new Uint8ClampedArray(nx * ny * 4);
    const z = (c, r) => {
      const cc = Math.min(Math.max(c, 0), nx - 1), rr = Math.min(Math.max(r, 0), ny - 1);
      const v = dem.data[rr * nx + cc];
      return v === dem.nodata ? null : v * dem.scale * o.zFactor;
    };
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      const e = z(c, r);
      if (e === null) continue;
      const g = (cc, rr) => { const v = z(cc, rr); return v === null ? e : v; };
      const a = g(c - 1, r - 1), b = g(c, r - 1), cc = g(c + 1, r - 1), d = g(c - 1, r), f = g(c + 1, r), gg = g(c - 1, r + 1), h = g(c, r + 1), i = g(c + 1, r + 1);
      const dzdx = ((cc + 2 * f + i) - (a + 2 * d + gg)) / (8 * dx); // nach Osten
      const dzdy = ((a + 2 * b + cc) - (gg + 2 * h + i)) / (8 * dy); // nach Norden (Zeile 0 = Norden)
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdy, -dzdx); // Richtung des Gefälles (bergab), mathematischer Winkel
      const shade = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
      const k = (r * nx + c) * 4;
      const diff = shade - flat;
      if (diff < 0) { rgba[k + 3] = Math.min(o.shadowAlpha, (-diff / flat) * o.shadowAlpha * 1.6); }
      else { rgba[k] = 255; rgba[k + 1] = 255; rgba[k + 2] = 255; rgba[k + 3] = Math.min(o.lightAlpha, (diff / (1 - flat)) * o.lightAlpha * 1.6); }
    }
    return { width: nx, height: ny, rgba };
  }

  const Dem = { load, fromBuffer, fromBase64, sample, cellValue, describe, hillshadeRGBA };
  root.Dem = Dem;
  if (typeof module !== "undefined" && module.exports) module.exports = Dem;
})(typeof globalThis !== "undefined" ? globalThis : this);
