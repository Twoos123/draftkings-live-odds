"use client";

import ReactDOM from "react-dom";

/**
 * The browser loads the board straight from DraftKings; open that connection
 * (DNS + TCP + TLS) while the page is still loading instead of on first use.
 * crossOrigin "anonymous" matches the credential-less fetch, so it's reused.
 */
export function Preconnect() {
  ReactDOM.preconnect("https://sportsbook-nash.draftkings.com", { crossOrigin: "anonymous" });
  ReactDOM.prefetchDNS("https://sportsbook-nash.draftkings.com");
  return null;
}
