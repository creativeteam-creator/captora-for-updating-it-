# Icons

Drop two **23×23 px PNG** files here for the panel chrome:

- `dark.png`   — used in Premiere's **dark theme** (most common)
- `light.png`  — used in Premiere's **light theme**

Both should match the Captora emerald accent on a transparent background.
Until real icons exist the panel will show Premiere's default placeholder
where the icon would render — harmless, just less branded.

To generate quick placeholders:
```powershell
# Quick green dot icon via PowerShell + ImageMagick (if installed):
magick -size 23x23 xc:transparent -fill "#10b981" -draw "circle 11,11 11,4" dark.png
magick -size 23x23 xc:transparent -fill "#10b981" -draw "circle 11,11 11,4" light.png
```

Or just author them in any image editor and save here.
