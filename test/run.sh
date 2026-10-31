#!/bin/sh
# Runs test.js headed, under a virtual X server (only for this headless test
# machine). Two displays are faked inside the extension, since the logic
# under test (tab switches, races, bring back) does not depend on them;
# window placement on the real desktop can only be checked there.
# Needs: Xvfb, openssl, node with playwright.
cd "$(dirname "$0")"
export CERT_DIR="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 1 -subj /CN=www.youtube.com 2>/dev/null
Xvfb :99 -screen 0 3200x1080x24 >/dev/null 2>&1 &
X=$!
sleep 1
DISPLAY=:99 timeout 150 node test.js
r=$?
kill $X
rm -rf "$CERT_DIR"
exit $r
