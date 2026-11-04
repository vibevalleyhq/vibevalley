// How the owner's notes name a page: the server files and links pages by it, and the page links a [[title]] or #tag the
// same way before it asks.

/** A page's name from its title: trimmed, lower case, spaces as dashes, "/" (or "\") as "__". */
export const slugOf = (title: string) => title.trim().replace(/\\/gu, "/").replace(/\//gu, "__").replace(/\s+/gu, "-").toLowerCase();
