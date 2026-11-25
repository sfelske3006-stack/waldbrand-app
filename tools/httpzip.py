"""Liest einzelne Mitglieder großer ZIP-Dateien per HTTP-Range (ohne Gesamtdownload)."""
import io, sys, zipfile, urllib.request

class HttpFile(io.RawIOBase):
    def __init__(self, url):
        self.url = url; self.pos = 0
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"]); self.ranges = r.headers.get("Accept-Ranges")
        self.nreq = 0
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos
    def read(self, n=-1):
        if n is None or n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b""
        end = min(self.pos + n, self.size) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=300) as r: data = r.read()
                break
            except Exception as e:
                if attempt == 4: raise
        self.nreq += 1; self.pos += len(data); return data
    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)

def open_zip(url):
    f = HttpFile(url)
    return zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 20)), f

if __name__ == "__main__":
    url = sys.argv[1]
    z, f = open_zip(url)
    if len(sys.argv) == 2:
        print("size", f.size, "ranges", f.ranges)
        for i in z.infolist(): print(i.file_size, i.compress_size, i.filename)
    else:
        out = sys.argv[2]
        for name in sys.argv[3:]:
            import os
            dst = os.path.join(out, os.path.basename(name))
            with z.open(name) as src, open(dst, "wb") as d:
                while True:
                    b = src.read(1 << 20)
                    if not b: break
                    d.write(b)
            print("ok", name, os.path.getsize(dst))
