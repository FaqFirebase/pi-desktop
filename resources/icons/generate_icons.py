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

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <!-- Charcoal rounded background -->
  <rect width="512" height="512" rx="77" fill="#36454F"/>

  <!-- Pi letterforms: official brand marks, scaled from 800 -> 512 -->
  <g transform="translate(5.5, 5.5) scale(0.62625)">
    <!-- P shape: outer boundary clockwise, inner hole counter-clockwise -->
    <path fill="#e67e22" fill-rule="evenodd" d="
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
    <path fill="#e67e22" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
  </g>
</svg>'''

# macOS app icon grid: an 824x824 tile centered on a 1024x1024 canvas.
# A full-bleed icon renders larger than every other icon in the Dock.
MAC_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#36454F"/>
  <g transform="translate(100, 100) scale(1.609375) translate(5.5, 5.5) scale(0.62625)">
    <path fill="#e67e22" fill-rule="evenodd" d="
      M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z
      M282.65 282.65 V400 H400 V282.65 Z
    "/>
    <path fill="#e67e22" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
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
        svg_to_png(svg_path, 1024, ICON_DIR / "icon-macos.png")
        print("  ✓ icon-macos.png (1024×1024)")

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
    generic white tile with the icon shrunk inside it. Force 8-bit output so the
    generated icons (PNG pack, ICO, and ICNS) stay in the format the OS expects.
    """
    subprocess.run(
        ["convert", "-background", "none", "-density", "300",
         f"{svg_path}", "-resize", f"{size}x{size}",
         "-strip", "-depth", "8", str(out_path)],
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
    # Build ICO using ImageMagick: append all sizes into one file
    args = ["convert"]
    for size in ico_sizes:
        args.extend([str(ICON_DIR / f"icon-{size}.png")])
    args.append(str(ICON_DIR / "icon.ico"))
    subprocess.run(args, check=True, capture_output=True)
    print(f"  ✓ icon.ico ({ico_sizes})")

    generate_macos_icons()

    print("\nAll icons generated successfully!")


if __name__ == "__main__":
    main()
