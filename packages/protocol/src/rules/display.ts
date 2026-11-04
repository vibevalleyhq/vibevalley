// Never with allow-same-origin: the page gets an opaque origin, none of the farm's cookies, storage or API.

/** The <iframe>'s sandbox attribute; the server's CSP sandbox directive is the same tokens. */
export const htmlSandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
