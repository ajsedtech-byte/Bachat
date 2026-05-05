"""Extract embedded raster from converter SVG and write a web-sized WebP + PNG."""
import base64
import re
import sys
from pathlib import Path

try:
    from PIL import Image
    from io import BytesIO
except ImportError:
    print("Requires Pillow: pip install Pillow")
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = Path.home() / "Downloads" / "png_to_svg_converter_by_poper.svg"


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.is_file():
        print("Missing source:", src)
        sys.exit(1)
    text = src.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r'href="(data:image/[^;]+;base64,[^"]+)"', text)
    if not m:
        print("No data:image base64 in SVG")
        sys.exit(1)
    data_url = m.group(1)
    b64 = data_url.split(",", 1)[1]
    raw = base64.standard_b64decode(b64)
    im = Image.open(BytesIO(raw)).convert("RGBA")
    # Max width for login tiles / hero strip (sharp enough on retina)
    max_w = 480
    w, h = im.size
    if w > max_w:
        nh = int(h * (max_w / w))
        im = im.resize((max_w, nh), Image.Resampling.LANCZOS)
    out_dir = ROOT / "public" / "assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    webp = out_dir / "bachat-team-brand.webp"
    png = out_dir / "bachat-team-brand.png"
    im.save(webp, "WEBP", quality=86, method=6)
    im.save(png, "PNG", optimize=True)
    print("Wrote", webp, webp.stat().st_size, "bytes")
    print("Wrote", png, png.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
