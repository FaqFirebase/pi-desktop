#!/usr/bin/env python3
"""Generate Pi desktop GUI icons from the original geometric design.

Colors:
  - Background: Charcoal #36454F
  - Foreground: Tangerine #e67e22
"""

from pathlib import Path
import subprocess
import sys
import tempfile

ICON_DIR = Path(__file__).resolve().parent
OUTPUT_SIZES = [16, 32, 48, 64, 128, 256, 512]
# ICO entries this size and larger are stored as PNG instead of a bitmap.
ICO_PNG_ENTRY_SIZE = 256

BACKGROUND_COLOR = "#36454F"
FOREGROUND_COLOR = "#e67e22"
SVG_SIZE = 512
SVG_CORNER_RADIUS = 77

# Shared by SVG and MAC_SVG so the letterform path data exists once.
PI_LETTERFORMS = f'''  <!-- Pi letterforms: official brand marks, scaled from 800 -> 512 -->
  <g transform="translate(5.5, 5.5) scale(0.62625)">
    <!-- P shape: outer boundary clockwise, inner hole counter-clockwise -->
    <path fill="{FOREGROUND_COLOR}" fill-rule="evenodd" d="
      M165.29 165.29
      H517.36
      V400
      H400
      V517.36
      H282.65
      V634.72
      H165.29
      Z
      M282.65 282.65
      V400
      H400
      V282.65
      Z
    "/>
    <!-- i dot -->
    <path fill="{FOREGROUND_COLOR}" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
  </g>'''

SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SVG_SIZE} {SVG_SIZE}" fill="none">
  <!-- Charcoal rounded background -->
  <rect width="{SVG_SIZE}" height="{SVG_SIZE}" rx="{SVG_CORNER_RADIUS}" fill="{BACKGROUND_COLOR}"/>

{PI_LETTERFORMS}
</svg>'''

# macOS app icon grid: an 824x824 tile centered on a 1024x1024 canvas.
# A full-bleed icon renders larger than every other icon in the Dock.
MAC_CANVAS_SIZE = 1024
MAC_TILE_SIZE = 824
# Corner radius of the tile on the macOS icon grid (not the scaled SVG radius).
MAC_TILE_RADIUS = 185
MAC_TILE_INSET = (MAC_CANVAS_SIZE - MAC_TILE_SIZE) // 2
MAC_TILE_SCALE = MAC_TILE_SIZE / SVG_SIZE

MAC_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MAC_CANVAS_SIZE} {MAC_CANVAS_SIZE}" fill="none">
  <rect x="{MAC_TILE_INSET}" y="{MAC_TILE_INSET}" width="{MAC_TILE_SIZE}" height="{MAC_TILE_SIZE}" rx="{MAC_TILE_RADIUS}" fill="{BACKGROUND_COLOR}"/>
  <g transform="translate({MAC_TILE_INSET}, {MAC_TILE_INSET}) scale({MAC_TILE_SCALE})">
{PI_LETTERFORMS}
  </g>
</svg>'''

# iconset file name -> pixel size
ICNS_ENTRIES = {
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}


def generate_macos_icons():
    """Write icon-macos.png (dev Dock icon) and icon.icns (packaged app)."""
    with tempfile.TemporaryDirectory() as tmp:
        svg_path = Path(tmp) / "icon-macos.svg"
        svg_path.write_text(MAC_SVG)
        svg_to_png(svg_path, MAC_CANVAS_SIZE, ICON_DIR / "icon-macos.png")
        print(f"  ✓ icon-macos.png ({MAC_CANVAS_SIZE}×{MAC_CANVAS_SIZE})")

        if sys.platform != "darwin":
            print("  - icon.icns skipped (iconutil requires macOS)")
            return
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, size in ICNS_ENTRIES.items():
            svg_to_png(svg_path, size, iconset / name)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICON_DIR / "icon.icns")],
            check=True, capture_output=True,
        )
        print("  ✓ icon.icns")


def svg_to_png(svg_path: Path, size: int, out_path: Path):
    """Convert SVG to PNG using ImageMagick.

    ImageMagick rasterizes the SVG at 16 bits per channel, and macOS ImageIO
    cannot render 16-bit reps inside an .icns: the Dock then falls back to its
    generic white tile with the icon shrunk inside it. Force 8-bit RGBA output
    (PNG32) so the generated icons (PNG pack, ICO, and ICNS) stay in the format
    the OS expects; a palette PNG would also cut the ICO's alpha to 1 bit.
    """
    subprocess.run(
        ["convert", "-background", "none", "-density", "300",
         f"{svg_path}", "-resize", f"{size}x{size}",
         "-strip", f"PNG32:{out_path}"],
        check=True, capture_output=True,
    )


def main():
    print("Generating Pi icons (tangerine #e67e22 on charcoal #36454F)...")

    # Write SVG
    svg_path = ICON_DIR / "icon.svg"
    svg_path.write_text(SVG)
    print(f"  ✓ {svg_path.name}")

    # Generate PNGs via ImageMagick
    for size in OUTPUT_SIZES:
        out_path = ICON_DIR / f"icon-{size}.png"
        svg_to_png(svg_path, size, out_path)
        print(f"  ✓ {out_path.name} ({size}×{size})")

    # Alias icon.png → icon-512.png
    icon_png = ICON_DIR / "icon.png"
    icon_png.write_bytes((ICON_DIR / "icon-512.png").read_bytes())
    print(f"  ✓ {icon_png.name} (copy of icon-512.png)")

    # Multi-resolution ICO
    print("  Generating icon.ico ...")
    ico_sizes = [16, 32, 48, 64, 128, 256]
    # Build ICO using ImageMagick: append all sizes into one file. Store the
    # 256px entry PNG-compressed, as Windows allows, instead of a 256 KB bitmap.
    args = ["convert", "-define", f"icon:png-compression-size={ICO_PNG_ENTRY_SIZE}"]
    for size in ico_sizes:
        args.extend([str(ICON_DIR / f"icon-{size}.png")])
    args.append(str(ICON_DIR / "icon.ico"))
    subprocess.run(args, check=True, capture_output=True)
    print(f"  ✓ icon.ico ({ico_sizes})")

    generate_macos_icons()

    print("\nAll icons generated successfully!")


if __name__ == "__main__":
    main()
