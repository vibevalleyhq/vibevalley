---
name: Collecting assets
description: When the user wants you to find pictures, references or material and keep what you find: put it in the library and say where each piece came from.
---

What you find goes into the library (`library_item_add`). The user sees it on the Library page under "fetched by helpers", each item recording that you took it and from where.

1. **Find out what is wanted.** The purpose (pictures for a deck, design references, competitor screenshots…), how many, the style, the size. Whatever the issue leaves out, choose sensibly for the purpose and say in your report how you chose. Fewer and better: if the user wants 5, hand in 5 chosen ones, not 50.
2. **Search.** Try several phrasings, in more than one language; start from trustworthy sources (official sites, the author's page, proper stock libraries). Open the original page to check it is what you want; don't judge by a search thumbnail.
3. **Check it may be used.** Note the source page and the author; check the licence (CC0, CC BY and the like, or an official press/media page). If the licence is unclear or forbids reuse, don't add it: list it separately in your report for the user to decide.
4. **Add it.**
   - A file on the web: `library_item_add` with `url`, the file's direct link (https, a public address), not the page's.
   - A file you made, downloaded or processed in your working directory (cropped, converted, a screenshot): `path`, relative to your working directory.
   - Give it a `name` that says what it is: `checkin-competitor-a-home.png`, `cover-wheatfield-dusk.jpg`, not `image1.png`.
   - Don't add intermediate files (ones you tried and dropped, temporary files).
5. **Report.** In the issue thread, a table: name, what it is, source page, licence, why you chose it. If nothing suitable turned up, say so and which phrasings you tried; don't pad with filler.

Report in the user's language.
