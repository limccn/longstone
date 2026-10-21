/**
 * Endpoint redaction for errors (L-1).
 *
 * Transport errors embed the request URL, and viem's message includes it
 * verbatim. A configured RPC or gateway URL may carry userinfo, a query token,
 * or a token-like path segment, and `detail` reaches stderr and MCP tool
 * results. Keep the scheme and host (diagnosis needs them), drop everything
 * that can carry a credential.
 *
 * Hashes, addresses, CIDs and revert data are deliberately untouched:
 * redaction must not destroy the facts a caller needs.
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** `scheme://host[:port]/<redacted>`; never userinfo, query or fragment. */
export function redactEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    return '<redacted-url>';
  }
}

/** Redact every absolute URL embedded in free text. */
export function redactText(text: string): string {
  return text.replace(URL_PATTERN, (match) => redactEndpoint(match));
}
