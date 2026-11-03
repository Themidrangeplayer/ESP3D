#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TLS_DIR="$ROOT_DIR/.tls"
OUT="$ROOT_DIR/firmware/esp32/ESP3D_Controller/tls_credentials.h"

mkdir -p "$TLS_DIR"
umask 077

openssl genrsa -out "$TLS_DIR/ca.key" 3072
openssl req -x509 -new -nodes -key "$TLS_DIR/ca.key" \
  -sha256 -days 3650 -out "$TLS_DIR/ca.crt" \
  -subj "/CN=ESP3D Local CA"

openssl genrsa -out "$TLS_DIR/device.key" 2048
openssl req -new -key "$TLS_DIR/device.key" -out "$TLS_DIR/device.csr" \
  -subj "/CN=ESP3D"

cat > "$TLS_DIR/device.ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:192.168.4.1,DNS:esp3d.local
EOF

openssl x509 -req -in "$TLS_DIR/device.csr" \
  -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
  -out "$TLS_DIR/device.crt" -days 825 -sha256 -extfile "$TLS_DIR/device.ext"

python3 - "$TLS_DIR/device.crt" "$TLS_DIR/device.key" "$OUT" <<'PY'
from pathlib import Path
import sys

def c_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'

cert = Path(sys.argv[1]).read_text()
key = Path(sys.argv[2]).read_text()
out = Path(sys.argv[3])
out.write_text(
    "#pragma once\n"
    "#include <stddef.h>\n\n"
    f"static const uint8_t SERVER_CERTIFICATE[] = {c_string(cert)};\n"
    f"static const size_t SERVER_CERTIFICATE_LEN = sizeof(SERVER_CERTIFICATE) - 1;\n"
    f"static const uint8_t SERVER_PRIVATE_KEY[] = {c_string(key)};\n"
    f"static const size_t SERVER_PRIVATE_KEY_LEN = sizeof(SERVER_PRIVATE_KEY) - 1;\n"
)
PY

printf 'Generated local CA: %s\n' "$TLS_DIR/ca.crt"
printf 'Generated firmware credentials: %s\n' "$OUT"
