import { describe, expect, test } from "bun:test";

const { P } = require("../src/bookmarklet.js");

describe("parsePayload", () => {
	test("parses asin:qty:store triples", () => {
		const p = P.parsePayload("#mlab-groceries=B004T38OCA:2:wholefoods,B0078DS86U:1:fresh");
		expect(p.cart).toEqual([
			{ asin: "B004T38OCA", qty: 2, store: "wholefoods" },
			{ asin: "B0078DS86U", qty: 1, store: "fresh" },
		]);
	});

	test("defaults qty to 1 and unknown store to wholefoods, skips bad asins", () => {
		const p = P.parsePayload("#mlab-groceries=b004t38oca::costco,NOTANASIN,short");
		expect(p.cart).toEqual([{ asin: "B004T38OCA", qty: 1, store: "wholefoods" }]);
	});

	test("parses names payload and import mode", () => {
		expect(P.parsePayload("#mlab-names=B004T38OCA,bogus").names).toEqual(["B004T38OCA"]);
		expect(P.parsePayload("#mlab-import").importMode).toBe(true);
	});
});

describe("cleanTitle", () => {
	test("decodes entities and strips Amazon suffixes/breadcrumbs", () => {
		expect(P.cleanTitle("Amazon.com : Theo Orange &amp; Dark Chocolate")).toBe(
			"Theo Orange & Dark Chocolate",
		);
		expect(P.cleanTitle("Organic Bananas : Fresh Produce : Grocery")).toBe("Organic Bananas");
	});
});

describe("parseCart", () => {
	test("reads data-asin/data-quantity attributes", () => {
		const c = P.parseCart(
			'<div data-asin="B004T38OCA" data-quantity="2"></div><div data-asin="B0078DS86U" data-quantity="1"></div>',
		);
		expect(c.items).toEqual({ B004T38OCA: 2, B0078DS86U: 1 });
		expect(c.method).toBe("data-attrs");
	});

	test("falls back to embedded JSON, then form fields", () => {
		const json = P.parseCart('{"asin":"B004T38OCA","quantity":"3"}');
		expect(json.items).toEqual({ B004T38OCA: 3 });
		expect(json.method).toBe("json");

		const form = P.parseCart(
			'<input name="asin.1" value="B004T38OCA"><input name="quantity.1" value="2">',
		);
		expect(form.items).toEqual({ B004T38OCA: 2 });
		expect(form.method).toBe("form-fields");
	});

	test("flags sign-in pages", () => {
		expect(P.parseCart('<input name="signIn">').signin).toBe(true);
	});
});

describe("findJsonPayloads", () => {
	// shaped like the real qs-widget payload from a logged-in WFM product page
	const atcPayload =
		"{&quot;reftag&quot;:&quot;dp&quot;,&quot;csrfToken&quot;:&quot;g5abc==&quot;," +
		"&quot;clientID&quot;:&quot;detail-page&quot;,&quot;qsUID&quot;:&quot;u1&quot;," +
		"&quot;asin&quot;:&quot;B004T38OCA&quot;,&quot;storeId&quot;:&quot;s1&quot;," +
		"&quot;offerListingID&quot;:&quot;enc123&quot;}";

	test("finds entity-encoded add-to-cart payloads", () => {
		const html = `<span data-fresh-add-to-cart="${atcPayload}">Add</span>`;
		const [p] = P.findJsonPayloads(html, "B004T38OCA");
		expect(p.csrfToken).toBe("g5abc==");
		expect(p.offerListingID).toBe("enc123");
	});

	// regression: real pages embed the asin in unrelated widget configs
	// (wishlist, faceout…) — replaying one of those breaks the add
	test("ignores JSON blobs that do not look like add-to-cart payloads", () => {
		const html =
			'{"isRobot":false,"asin":"B004T38OCA","wishlistButtonId":"w1"}' +
			'{"dimValues":[],"asin":"B004T38OCA"}';
		expect(P.findJsonPayloads(html, "B004T38OCA")).toEqual([]);
	});

	test("ignores payloads for other asins", () => {
		const html = '{"clientID":"x","storeId":"s","asin":"B999999999"}';
		expect(P.findJsonPayloads(html, "B004T38OCA")).toEqual([]);
	});
});

describe("extractPage", () => {
	test("pulls title, csrf token, and availability", () => {
		const pg = P.extractPage(
			"<title>Bananas : Amazon.com</title>" +
				'<input name="anti-csrftoken-a2z" value="tok123">' +
				'<div id="availability">In Stock</div>',
		);
		expect(pg.title).toBe("Bananas");
		expect(pg.csrf).toBe("tok123");
		expect(pg.availability).toBe("In Stock");
	});

	test("detects bot checks and sign-in walls", () => {
		expect(P.extractPage("Type the characters you see in this image").botCheck).toBe(true);
		expect(P.extractPage('<input name="signIn">').signedOut).toBe(true);
	});
});
