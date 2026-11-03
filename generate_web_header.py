from pathlib import Path

root = Path(__file__).parent / "phone-app"
output = Path(__file__).parent / "firmware/esp32/ESP3D_Controller/web_ui.h"

files = {
    "INDEX_HTML": root / "index.html",
    "STYLE_CSS": root / "css/style.css",
    "APP_JS": root / "js/app.js",
}

# Guard against the accidental shell-heredoc contamination that previously
# leaked into style.css and, from there, into web_ui.h.
STRAY_MARKERS = ("</EOF>", "<<'EOF'", "<<EOF")

with output.open("w", encoding="utf-8") as out:
    out.write("#pragma once\n#include <Arduino.h>\n\n")
    for name, path in files.items():
        content = path.read_text(encoding="utf-8")

        for marker in STRAY_MARKERS:
            if marker in content:
                raise SystemExit(
                    f"Refusing to embed {path}: found stray marker {marker!r}"
                )

        if ')ESP3D"' in content:
            raise SystemExit(
                f"Refusing to embed {path}: contains the raw string delimiter"
            )

        out.write(f"const char {name}[] PROGMEM = R\"ESP3D(\n")
        out.write(content)
        out.write("\n)ESP3D\";\n\n")

print("Generated:", output)
