AIQ_Token_Capture_extention — Autosupport Analyzer
==================================================

Install (Chrome / Edge / Brave):
  1. Unzip this folder somewhere permanent.
  2. Open chrome://extensions/ (or edge://extensions/).
  3. Turn on Developer mode (top-right).
  4. Click 'Load unpacked' and select the AIQ_Token_Capture_extention folder.

How it works:
  It watches outbound requests ONLY to these AIQ hosts:
    - https://api.activeiq.netapp.com/*
    - https://apigtwyapps.netapp.com/*
    - https://aiq.netapp.com/*
  When it sees an 'Authorization: Bearer eyJ...' header it extracts the
  token and POSTs it to <server>/api/asup/token/capture on EVERY configured
  server (multi-server). The same token is not re-sent within 60 seconds.

Use:
  1. In Autosupport Analyzer, click 'Authenticate via ActiveIQ'.
  2. Sign in on the ActiveIQ tab - capture is automatic.
  3. Back in Autosupport Analyzer, click 'Refresh' (token shows loaded).

Servers (multi-server, no re-download needed):
  Click the extension icon. Each server row has a URL + capture key.
  Use '+ Add server' to forward the captured token to more than one
  Autosupport Analyzer instance, 'Remove' to drop one, then 'Save'.
  You'll be asked to grant access to each server's origin. The popup shows
  a per-server send result (check / cross) after each capture.

Note:
  When downloaded from the Autosupport Analyzer app, config.js is filled in
  with your server URL and capture key automatically (open the box and use).
  When loading this directory unpacked for development, set them in the popup.

Debug: click the icon to see last-capture status; the toolbar badge shows
a check on success or ! on failure.
