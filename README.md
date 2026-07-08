<h3 align="center">
  <img src="https://raw.githubusercontent.com/debbiemarkslab/mlab-groceries/refs/heads/main/logo.png" alt="M'lab Groceries" width="256">
</h3>

## Get started

```bash
git clone git@github.com:debbiemarkslab/mlab-groceries.git
cd mlab-groceries
node server.js
# Open http://localhost:8080
```

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

0. Drag the **Add Groceries** bookmarklet from page to your bookmarks bar.
1. Select items and click "Add to Cart"
2. Click the "Add Groceries" bookmarklet (opens each product on Amazon/Whole Foods and adds it to cart)

When done, the Whole Foods cart will be open and ready for the order to be placed.


