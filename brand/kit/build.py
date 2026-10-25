import math
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
from shapely import affinity

HONEY, AMBER, BRONZE = "#F5B23D", "#D9962A", "#B57B1F"
GRAPHITE, CREAM = "#16181D", "#F4EFE6"

def rhex(cx, cy, r, corner):
    pts = [(cx + (r - corner * 1.1547) * math.cos(math.radians(-90 + 60 * k)),
            cy + (r - corner * 1.1547) * math.sin(math.radians(-90 + 60 * k))) for k in range(6)]
    return Polygon(pts).buffer(corner, quad_segs=16)

def stack(r=58, corner=12, gap=10, spacing=56, cy=128):
    xs = [128 - spacing, 128, 128 + spacing]
    hexes = [rhex(x, cy, r, corner) for x in xs]
    cells = []
    for i, h in enumerate(hexes):
        shape = h
        for front in hexes[i + 1:]:
            shape = shape.difference(front.buffer(gap, quad_segs=16))
        cells.append(shape.buffer(-4, quad_segs=16).buffer(4, quad_segs=16))
    return cells

def d(geom):
    polys = getattr(geom, "geoms", [geom])
    out = ""
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            c = list(ring.coords)
            out += "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in c[:-1]) + " Z "
    return out.strip()

def svg(vb, body, title="Hive"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><title>{title}</title>{body}</svg>\n'

def write(name, content):
    open(f"svg/{name}.svg", "w").write(content)

def arc(cx, cy, r, a0, a1, n=48):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]

def wordmark():
    w = 13
    lines = [
        [(40, 52), (40, 196)],
        [(40, 196), (40, 140)] + arc(80, 140, 40, 180, 360)[1:] + [(120, 196)],
        [(168, 104), (168, 196)],
        [(208, 104), (248, 196), (288, 104)],
        [(320, 150), (406, 150)] + arc(361, 150, 45, 0, -315)[1:],
    ]
    shapes = [LineString(l).buffer(w, cap_style="round", join_style="round", quad_segs=16) for l in lines]
    shapes.append(rhex(168, 56, 22, 4))
    return unary_union(shapes)

cells = stack()
small = stack(r=60, corner=10, gap=16, spacing=50)
mark = unary_union(cells)

write("hive-symbol", svg("0 0 256 256", f'<path fill="#000" d="{d(mark)}"/>'))
write("hive-symbol-color", svg("0 0 256 256", "".join(f'<path fill="{c}" d="{d(g)}"/>' for c, g in zip((BRONZE, AMBER, HONEY), cells))))
write("hive-symbol-small", svg("0 0 256 256", f'<path fill="#000" d="{d(unary_union(small))}"/>'))

wm = wordmark()
write("hive-wordmark", svg("0 0 448 256", f'<path fill="#000" d="{d(wm)}"/>'))

# horizontal lockup: symbol scaled to the wordmark's ascender height, gap = one cell gap * 4
sym = affinity.scale(mark, 1.25, 1.25, origin=(128, 128))
minx, miny, maxx, maxy = sym.bounds
sym = affinity.translate(sym, -minx + 16, 124 - (miny + maxy) / 2)
sx = sym.bounds[2] + 44
wmt = affinity.translate(wm, sx - wm.bounds[0], 0)
width = wmt.bounds[2] + 16
write("hive-horizontal", svg(f"0 0 {width:.0f} 256", f'<path fill="#000" d="{d(unary_union([sym, wmt]))}"/>'))
cs = [affinity.translate(affinity.scale(g, 1.25, 1.25, origin=(128, 128)), -minx + 16, 124 - (miny + maxy) / 2) for g in cells]
write("hive-horizontal-color", svg(f"0 0 {width:.0f} 256",
      "".join(f'<path fill="{c}" d="{d(g)}"/>' for c, g in zip((BRONZE, AMBER, HONEY), cs)) + f'<path fill="{GRAPHITE}" d="{d(wmt)}"/>'))
write("hive-horizontal-reversed", svg(f"0 0 {width:.0f} 256",
      f'<rect width="100%" height="100%" fill="{GRAPHITE}"/>' + "".join(f'<path fill="{c}" d="{d(g)}"/>' for c, g in zip((BRONZE, AMBER, HONEY), cs)) + f'<path fill="{CREAM}" d="{d(wmt)}"/>'))

# stacked lockup
st_sym = affinity.translate(affinity.scale(mark, 1.6, 1.6, origin=(128, 128)), 96, -10)
st_wm = affinity.translate(affinity.scale(wm, 0.8, 0.8, origin=(0, 0)), 0, 0)
b = st_wm.bounds
st_wm = affinity.translate(st_wm, 224 - (b[0] + b[2]) / 2, st_sym.bounds[3] + 36 - b[1])
st = unary_union([st_sym, st_wm]); b = st.bounds
st = affinity.translate(st, 24 - b[0], 24 - b[1]); b = st.bounds
write("hive-stacked", svg(f"0 0 {b[2] + 24:.0f} {b[3] + 24:.0f}", f'<path fill="#000" d="{d(st)}"/>'))

# app icon: graphite squircle, colour stack
tile = 1024
icon_cells = [affinity.translate(affinity.scale(g, 3.25, 3.25, origin=(128, 128)), 512 - 128, 512 - 128 + 6) for g in cells]
squircle = f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{GRAPHITE}"/>'
write("hive-app-icon", svg("0 0 1024 1024", squircle + "".join(f'<path fill="{c}" d="{d(g)}"/>' for c, g in zip((BRONZE, AMBER, HONEY), icon_cells))))

# menu bar template (black, transparent; macOS tints it) idle + attention (front cell carries a dot cut-out)
mb = unary_union(small)
write("hive-menubar", svg("0 0 256 256", f'<path fill="#000" d="{d(mb)}"/>'))
print("ok")
