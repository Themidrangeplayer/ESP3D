from pathlib import Path

root = Path(__file__).parent / "phone-app"
output = Path(__file__).parent / "firmware/esp32/ESP3D_Controller/web_ui.h"

files = {
    "INDEX_HTML": root / "index.html",
    "STYLE_CSS": root / "css/style.css",
    "APP_JS": root / "js/app.js",
}

with output.open("w", encoding="utf-8") as out:
    out.write("#pragma once\n#include <Arduino.h>\n\n")
    for name, path in files.items():
        content = path.read_text(encoding="utf-8")
        out.write(f"const char {name}[] PROGMEM = R\"ESP3D(\n")
        out.write(content)
        out.write("\n)ESP3D\";\n\n")

print("Generated:", output)
