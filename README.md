<h3 align="center">
  <img src="https://raw.githubusercontent.com/debbiemarkslab/mlab-groceries/refs/heads/main/logo.png" alt="M'lab Groceries" width="256">
</h3>

## Get started

```bash
git clone git@github.com:debbiemarkslab/mlab-groceries.git
cd mlab-groceries
bun start
# Open http://localhost:8080
```

Development: `bun test` runs the test suite, `bun run check` lints/formats with Biome.

## Adding groceries

Add groceries via the web app or edit `groceries.json` directly. Each item needs an ASIN (the 10-character Amazon product ID) and a quantity:

```json
{
  "asin": "B08TQ9F2G8",
  "name": "365 Almond Butter Filled Pretzel Nuggets",
  "quantity": 1,
  "store": "wholefoods"
}
```

Find the ASIN in any Amazon product URL: `amazon.com/dp/B08TQ9F2G8`

Fork the repo, add your items to `groceries.json`, and open a pull request.


## Order groceries

0. One-time setup: drag the **Add Groceries** bookmarklet to your bookmarks bar. The bookmark embeds the engine (`bookmarklet.js`), so it works in any browser. After an engine update, the app's order report will tell you to re-drag the button.
1. Select items and click "Add to Cart" — a signed-in Amazon tab opens.
2. Click the **Add Groceries** bookmarklet once in that tab.

A per-item report (added / unavailable / quantity-capped / failed) appears back in the app, and the Whole Foods cart opens for checkout.


