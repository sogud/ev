#!/usr/bin/env python3
"""生成 EV Browser 扩展图标（16/32/48/96/128）。

品牌标记与桌面 EvMark 同源：八向辐条 + 双八边形环 + 中心点。
纯 Python 光栅化（超采样抗锯齿），无第三方依赖；修改几何后重跑即可。
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public'

BG = (36, 120, 150)          # --ev-color-brand-mark light (#247896)
MARK = (255, 255, 255)
NODE = (185, 242, 255)       # brand-mark 深色态点缀 (#b9f2ff)
RADIUS = 6.8                 # 圆角方底（32 空间）
SS = 4                       # 超采样倍数

SPOKES = [
    ((16, 16), (16, 3.5)),
    ((16, 16), (24.8, 7.2)),
    ((16, 16), (28.5, 16)),
    ((16, 16), (24.8, 24.8)),
    ((16, 16), (16, 28.5)),
    ((16, 16), (7.2, 24.8)),
    ((16, 16), (3.5, 16)),
    ((16, 16), (7.2, 7.2)),
]
INNER = [(16, 8.6), (21.2, 10.8), (23.4, 16), (21.2, 21.2), (16, 23.4), (10.8, 21.2), (8.6, 16), (10.8, 10.8)]
OUTER = [(16, 4.9), (23.8, 8.2), (27.1, 16), (23.8, 23.8), (16, 27.1), (8.2, 23.8), (4.9, 16), (8.2, 8.2)]


def seg_dist(px, py, a, b):
    (ax, ay), (bx, by) = a, b
    abx, aby = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)))
    return math.hypot(px - (ax + abx * t), py - (ay + aby * t))


def poly_edges(points):
    return [(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]


EDGES = poly_edges(INNER) + poly_edges(OUTER)


def rounded_box(px, py, size=32.0, r=RADIUS):
    h = size / 2
    qx = max(abs(px - 16) - (h - r), 0)
    qy = max(abs(py - 16) - (h - r), 0)
    return math.hypot(qx, qy) <= r


def cover(dist, width):
    return max(0.0, min(1.0, width / 2 + 0.5 - dist))


def subpixel_color(px, py, spoke_w, ring_w):
    """返回 (r, g, b, a)，背景外为全透明。"""
    if not rounded_box(px, py):
        return (0, 0, 0, 0)
    r, g, b = BG
    ds = min(seg_dist(px, py, a, c) for a, c in SPOKES)
    de = min(seg_dist(px, py, a, c) for a, c in EDGES)
    w = max(cover(ds, spoke_w), cover(de, ring_w))
    w = max(w, cover(math.hypot(px - 16, py - 16), 3.4))  # 中心点 r=1.7 → 直径覆盖
    if w > 0:
        r, g, b = (r * (1 - w) + MARK[0] * w, g * (1 - w) + MARK[1] * w, b * (1 - w) + MARK[2] * w)
    d2 = cover(math.hypot(px - 23.8, py - 8.2), 2.4)
    if d2 > 0:
        r, g, b = (r * (1 - d2) + NODE[0] * d2, g * (1 - d2) + NODE[1] * d2, b * (1 - d2) + NODE[2] * d2)
    return (r, g, b, 1)


def render(size):
    scale = size / 32.0
    spoke_w = 2.1 if size >= 48 else 2.6
    ring_w = 1.7 if size >= 48 else 2.1
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            sr = sg = sb = sa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    px = (x + (sx + 0.5) / SS) / scale
                    py = (y + (sy + 0.5) / SS) / scale
                    r, g, b, a = subpixel_color(px, py, spoke_w, ring_w)
                    sr += r
                    sg += g
                    sb += b
                    sa += a
            n = SS * SS
            row += bytes((round(sr / n), round(sg / n), round(sb / n), round(255 * sa / n)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + row for row in rows)
    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 96, 128):
        rows = render(size)
        name = 'icon.png' if size == 128 else f'icon-{size}.png'
        write_png(OUT / name, size, rows)
        print('wrote', name)


if __name__ == '__main__':
    main()
