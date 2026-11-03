# Local HTTPS setup

The controller now serves the phone app and secure WebSocket endpoint at:

```text
https://192.168.4.1
```

The certificate is signed by a device-local CA. The generated CA and private
key are intentionally ignored by Git.

## Generate credentials

Run this from the project root:

```sh
tools/generate_tls_credentials.sh
```

Run it again if the credentials are lost or if the certificate expires.

## Trust the CA on the phone

Copy `.tls/ca.crt` to the phone and install it as a trusted CA certificate.
The exact menu depends on the operating system. On iOS, use a configuration
profile and then enable full trust under certificate trust settings. On
Android, install it as a CA certificate for VPN and apps.

The phone must trust the CA before opening the controller page; otherwise the
browser will continue to show a certificate warning and may block motion
permissions.

The certificate is valid for `192.168.4.1` and `esp3d.local`. The controller
uses the IP address while operating as an access point.
