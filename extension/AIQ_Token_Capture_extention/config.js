// Defaults injected by the server when you download the extension from
// Autosupport Analyzer. DEFAULT_BACKEND / DEFAULT_KEY are the primary server.
// DEFAULT_SERVERS lets you ship additional servers so a single extension can
// forward the captured token to several Autosupport Analyzer instances at once.
// When loading this folder unpacked for development, edit these or manage the
// server list from the popup.
const DEFAULT_BACKEND = "http://localhost:8011";
const DEFAULT_KEY = "IwD2gH9dQhUS-pWdHyhJZWfPijDLrcmp";

// Extra servers the captured token is also sent to (multi-server).
// Each entry: { url: "http://host:port", key: "capture key" }
const DEFAULT_SERVERS = [
  { url: "http://10.216.43.66:8011", key: "Nszxk9WmcNKPjQDYqdFzWuQEJTz6AUAs" }
];

const AIQ_URLS = [
  "https://api.activeiq.netapp.com/*",
  "https://apigtwyapps.netapp.com/*",
  "https://aiq.netapp.com/*"
];
