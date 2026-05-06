# App icons

Electron-builder picks up icon files from this folder when building installers.
The first release ships with Electron's default icon — replace these with QHT
branding when ready.

## Files needed

| File | Purpose | Format |
|------|---------|--------|
| `icon.ico` | Windows installer + taskbar icon | Multi-size .ico (16, 24, 32, 48, 64, 128, 256 px) |
| `icon.icns` | Mac DMG + Dock icon | Multi-size .icns (16, 32, 64, 128, 256, 512, 1024 px) |
| `icon.png` | Source artwork | 1024×1024 PNG |

## Easy generation from a single PNG

Drop `icon.png` here (1024×1024) and run:

```bash
# Mac (uses iconutil — built-in)
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
cp icon.png       icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
rm -rf icon.iconset

# Windows (uses ImageMagick)
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

After dropping `icon.ico` and `icon.icns` in this folder, re-add icon paths
to root `package.json`'s `build.win.icon` and `build.mac.icon`.
