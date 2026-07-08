/*
 * M'lab Groceries — cart engine.
 *
 * Snapshotted base64 into the bookmark by the app (see index.html) and run
 * on amazon.com. Runs entirely in the user's logged-in Amazon tab: fetches
 * product pages same-origin, replays Amazon's own add-to-cart requests
 * directly (no popups, no DOM clicking), verifies results by diffing the
 * store cart before/after, and posts a per-item report back to the app tab.
 *
 * The parsing helpers (P) are pure string functions so they can be unit-tested
 * against saved Amazon HTML (bun test).
 *
 * Everything lives inside one closure: amazon.com already has a global `P`
 * (AmazonUIPageJS), so leaking ANY name into global scope shadows or breaks
 * things depending on which of ours/theirs runs first.
 */

(() => {
	const MLAB_VERSION = "2.4.1";

	const ALM_BRAND_IDS = {
		wholefoods: "VUZHIFdob2xlIEZvb2Rz",
		fresh: "QW1hem9uIEZyZXNo",
	};

	const P = {
		// #mlab-groceries=ASIN:QTY:STORE,...  /  #mlab-names=ASIN,...  /  #mlab-import
		parsePayload(hash) {
			const out = { cart: [], names: [], importMode: false };
			if (/mlab-import/.test(hash)) {
				out.importMode = true;
				return out;
			}
			const cm = hash.match(/mlab-groceries=([^&\s]+)/);
			const nm = hash.match(/mlab-names=([^&\s]+)/);
			if (cm) {
				for (const s of decodeURIComponent(cm[1]).split(",")) {
					const p = s.trim().split(":");
					if (/^[A-Z0-9]{10}$/i.test(p[0])) {
						out.cart.push({
							asin: p[0].toUpperCase(),
							qty: Math.max(1, Number.parseInt(p[1], 10) || 1),
							store: ALM_BRAND_IDS[p[2]] ? p[2] : "wholefoods",
						});
					}
				}
			}
			if (nm) {
				for (const a of decodeURIComponent(nm[1]).split(",")) {
					if (/^[A-Z0-9]{10}$/i.test(a.trim())) out.names.push(a.trim().toUpperCase());
				}
			}
			return out;
		},

		cleanTitle(t) {
			if (!t) return "";
			let s = t
				.replace(/&amp;/g, "&")
				.replace(/&#x27;|&#39;/g, "'")
				.replace(/&quot;/g, '"')
				.replace(/\s*[:\-|]+\s*(Amazon\.com|Whole Foods Market).*$/i, "")
				.replace(/^Amazon\.com\s*[:\-|]+\s*/i, "")
				.replace(/\s+/g, " ")
				.trim();
			// trailing " : Category" breadcrumbs are letters-only — product names aren't
			let prev;
			do {
				prev = s;
				s = s.replace(/\s+:\s+[A-Za-z&',\- ]+$/, "");
			} while (s !== prev);
			return s.trim();
		},

		// Everything we can learn from one product page's HTML.
		extractPage(html) {
			const pg = {
				title: "",
				image: "",
				csrf: "",
				availability: "",
				forms: [],
				offerListingIds: [],
				offeringIds: [],
				signedOut: false,
				botCheck: false,
				flags: {},
				snippets: [],
			};

			if (
				/api-services-support@amazon\.com|Type the characters you see|validateCaptcha/i.test(html)
			) {
				pg.botCheck = true;
			}

			let m = html.match(/<title[^>]*>([^<]+)/i);
			if (m) pg.title = P.cleanTitle(m[1]);

			m =
				html.match(/og:image[^>]*content=["']([^"']+)/i) ||
				html.match(/"hiRes":"(https:[^"]+)"/) ||
				html.match(/data-old-hires=["'](https?:[^"']+)/i);
			if (m) pg.image = m[1];

			m =
				html.match(/name=["']anti-csrftoken-a2z["'][^>]*value=["']([^"']+)/i) ||
				html.match(/["']anti-csrftoken-a2z["']\s*[:=]\s*["']([^"']+)/i) ||
				html.match(/csrfToken["']?\s*[:=]\s*["']([^"']{16,})["']/);
			if (m) pg.csrf = m[1];

			m = html.match(/id=["']availability["'][^>]*>([\s\S]{0,400}?)<\/div>/i);
			if (m) {
				pg.availability = m[1]
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
					.substring(0, 160);
			}

			// Any form that smells like add-to-cart, with all its fields.
			let count = 0;
			for (const f of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
				if (++count > 40 || pg.forms.length >= 6) break;
				const block = f[0];
				if (!/add-?to-?cart|addToCart|handle-buy-box|submit\.add/i.test(block)) continue;
				const action = block.match(/action=["']([^"']+)/i)?.[1] ?? "";
				const method = (block.match(/method=["']([^"']+)/i)?.[1] ?? "get").toLowerCase();
				const inputs = {};
				for (const inp of block.matchAll(/<input\b[^>]*>/gi)) {
					const nameM = inp[0].match(/name=["']([^"']+)/i);
					if (!nameM) continue;
					const valM = inp[0].match(/value=["']([^"']*)/i);
					inputs[nameM[1]] = valM ? valM[1] : "";
				}
				pg.forms.push({ action, method, inputs });
			}

			let seen = {};
			for (const re of [
				/offer[-_]?listing[-_]?I[dD]["']?\s*[:=]\s*["']([A-Za-z0-9%+/=._-]{20,})/g,
				/name=["']offerListingI[dD][^"']*["'][^>]*value=["']([A-Za-z0-9%+/=._-]{20,})/gi,
			]) {
				for (const ol of html.matchAll(re)) {
					if (pg.offerListingIds.length >= 4) break;
					if (!seen[ol[1]]) {
						seen[ol[1]] = 1;
						pg.offerListingIds.push(ol[1]);
					}
				}
			}
			seen = {};
			for (const re of [
				/offering[-_]?I[dD](?:\.1)?["']?\s*[:=]\s*["']([A-Za-z0-9%+/=._-]{30,})/g,
				/name=["']offering-?I[dD][^"']*["'][^>]*value=["']([A-Za-z0-9%+/=._-]{30,})/gi,
			]) {
				for (const of_ of html.matchAll(re)) {
					if (pg.offeringIds.length >= 4) break;
					if (!seen[of_[1]]) {
						seen[of_[1]] = 1;
						pg.offeringIds.push(of_[1]);
					}
				}
			}

			pg.flags = {
				shouldRenderAtc:
					html.match(/data-should-render-add-to-cart-button=["'](\w+)/)?.[1] ?? "absent",
				atcButton: (html.match(/add-to-cart-button/g) || []).length,
				freshAtc: (html.match(/fresh-add-to-cart/g) || []).length,
				qsAtc: (html.match(/qs-widget-atc/g) || []).length,
				almBrand: (html.match(/almBrandId/g) || []).length,
				unavailable: /currently unavailable|out of stock/i.test(pg.availability),
				unavailPhrase: (html.match(/currently unavailable/gi) || []).length,
				signin: /name=["']signIn["']|id=["']ap_email/.test(html),
				length: html.length,
			};
			pg.signedOut = pg.flags.signin;

			// Small context windows around interesting markers, for the diagnostics bundle.
			for (const marker of [
				"fresh-add-to-cart",
				"qs-widget-atc",
				"data-should-render-add-to-cart-button",
				"offerListingId",
				"offeringID",
				"almShipsFrom",
				"submit.add-to-cart",
			]) {
				const i = html.indexOf(marker);
				if (i >= 0) {
					pg.snippets.push(
						`${marker} @${i}: ${html.substring(Math.max(0, i - 60), i + 220).replace(/\s+/g, " ")}`,
					);
				}
			}

			return pg;
		},

		// ASIN -> quantity map from a cart page's HTML. Tries several markups,
		// reports which one matched so failures are diagnosable.
		parseCart(html) {
			const items = {};
			let method = "none";

			for (const m of html.matchAll(
				/<[^>]*data-asin=["']([A-Z0-9]{10})["'][^>]*data-quantity=["'](\d+)/gi,
			)) {
				items[m[1]] = (items[m[1]] ?? 0) + Number.parseInt(m[2], 10);
				method = "data-attrs";
			}

			if (method === "none") {
				for (const m of html.matchAll(
					/<[^>]*data-quantity=["'](\d+)["'][^>]*data-asin=["']([A-Z0-9]{10})/gi,
				)) {
					items[m[2]] = (items[m[2]] ?? 0) + Number.parseInt(m[1], 10);
					method = "data-attrs-rev";
				}
			}

			if (method === "none") {
				for (const m of html.matchAll(
					/"asin"\s*:\s*"([A-Z0-9]{10})"[^{}]{0,300}?"quantity"\s*:\s*"?(\d+)/gi,
				)) {
					items[m[1]] = (items[m[1]] ?? 0) + Number.parseInt(m[2], 10);
					method = "json";
				}
			}

			if (method === "none") {
				const asins = {};
				const qtys = {};
				for (const m of html.matchAll(/name=["']asin\.(\d+)["'][^>]*value=["']([A-Z0-9]{10})/gi))
					asins[m[1]] = m[2];
				for (const m of html.matchAll(/name=["']quantity\.(\d+)["'][^>]*value=["'](\d+)/gi)) {
					qtys[m[1]] = Number.parseInt(m[2], 10);
				}
				for (const k of Object.keys(asins)) {
					items[asins[k]] = (items[asins[k]] ?? 0) + (qtys[k] || 1);
					method = "form-fields";
				}
			}

			return {
				items,
				method,
				count: Object.keys(items).length,
				signin: /name=["']signIn["']|id=["']ap_email/.test(html),
				length: html.length,
			};
		},

		// JSON blobs mentioning this ASIN. The fresh/qs-widget add-to-cart buttons
		// carry their whole request payload as JSON in markup attributes (usually
		// entity-encoded), and replaying that payload verbatim against
		// /alm/addtofreshcart is how Amazon's own widget adds grocery items.
		findJsonPayloads(html, asin) {
			const text = html.replace(/&quot;|&#0?34;/g, '"').replace(/&amp;/g, "&");
			const out = [];
			const seenStr = {};
			let scanned = 0;
			for (const m of text.matchAll(new RegExp(`"asin"\\s*:\\s*"${asin}"`, "gi"))) {
				if (out.length >= 4 || ++scanned > 60) break;
				// walk back to each '{' before the hit, take the first that parses
				for (let j = m.index; j > m.index - 3000 && j >= 0; j--) {
					if (text[j] !== "{") continue;
					let depth = 0;
					let inStr = false;
					let esc = false;
					let end = -1;
					for (let k = j; k < j + 8000 && k < text.length; k++) {
						const ch = text[k];
						if (esc) {
							esc = false;
							continue;
						}
						if (ch === "\\") {
							esc = true;
							continue;
						}
						if (ch === '"') {
							inStr = !inStr;
							continue;
						}
						if (inStr) continue;
						if (ch === "{") depth++;
						else if (ch === "}") {
							depth--;
							if (depth === 0) {
								end = k;
								break;
							}
						}
					}
					if (end < 0) continue;
					const str = text.substring(j, end + 1);
					let obj;
					try {
						obj = JSON.parse(str);
					} catch {
						continue;
					}
					if (!obj || String(obj.asin).toUpperCase() !== asin.toUpperCase()) continue;
					if (seenStr[str]) break;
					seenStr[str] = 1;
					obj.__score =
						("additionalParams" in obj ? 2 : 0) +
						("clientID" in obj ? 1 : 0) +
						("storeId" in obj ? 1 : 0) +
						("qsUID" in obj ? 1 : 0) +
						("oid" in obj ? 1 : 0) +
						("almBrandId" in obj ? 1 : 0);
					// score 0 = some unrelated widget's config (wishlist, faceout…), not
					// an add-to-cart payload — replaying one of those breaks the add
					if (obj.__score > 0) out.push(obj);
					break;
				}
			}
			return out;
		},

		redact(s) {
			if (!s) return s;
			const str = String(s);
			return str.length <= 14
				? `<${str.length} chars>`
				: `${str.substring(0, 10)}…<${str.length} chars>`;
		},
	};

	/* ── test hook (bun test) ───────────────────────────────────────────────── */

	if (typeof window === "undefined") {
		module.exports = { P, MLAB_VERSION, ALM_BRAND_IDS };
		return;
	}

	/* ── browser engine ─────────────────────────────────────────────────────── */

	if (window.__mlabRunning) {
		alert("M'lab Groceries is already running on this page.");
		return;
	}
	if (!/(^|\.)amazon\.com$/.test(location.hostname)) {
		alert("M'lab Groceries: this bookmark only works on amazon.com pages.");
		return;
	}
	window.__mlabRunning = true;

	/* ── overlay UI ── */

	let ui = null;
	const overlay = () => {
		if (ui) return ui;
		const host = document.createElement("div");
		host.id = "mlab-overlay";
		host.style.cssText =
			'position:fixed;top:12px;right:12px;width:380px;max-width:94vw;max-height:82vh;overflow:auto;z-index:2147483647;background:#fffdf8;color:#2a2522;border:1.5px solid #ded5c8;border-radius:12px;box-shadow:0 8px 30px rgba(42,37,34,.25);font:13px/1.45 -apple-system,"Segoe UI",sans-serif;padding:14px 16px;';
		const head = document.createElement("div");
		head.style.cssText =
			"font-weight:700;font-size:15px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;";
		head.textContent = "M'lab Groceries";
		const x = document.createElement("span");
		x.textContent = "✕";
		x.style.cssText = "cursor:pointer;color:#a89e94;padding:2px 6px;";
		x.onclick = () => {
			host.remove();
			ui = null;
			window.__mlabRunning = false;
		};
		head.appendChild(x);
		const status = document.createElement("div");
		status.style.cssText = "color:#6e645c;margin-bottom:10px;";
		const list = document.createElement("div");
		const foot = document.createElement("div");
		foot.style.cssText = "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;";
		host.appendChild(head);
		host.appendChild(status);
		host.appendChild(list);
		host.appendChild(foot);
		// body can still be null if the bookmark is clicked while the page loads
		(document.body || document.documentElement).appendChild(host);
		ui = { host, status, list, foot, rows: {} };
		return ui;
	};

	const setStatus = (msg) => {
		overlay().status.textContent = msg;
	};

	const DOT = {
		pending: "#a89e94",
		working: "#c0956c",
		added: "#2d6a4f",
		partial: "#c0956c",
		failed: "#b84233",
		unavailable: "#b84233",
		unknown: "#6e645c",
	};

	const itemRow = (asin) => {
		const o = overlay();
		if (o.rows[asin]) return o.rows[asin];
		const row = document.createElement("div");
		row.style.cssText =
			"display:flex;gap:8px;align-items:baseline;padding:4px 0;border-top:1px solid #ede6da;";
		const dot = document.createElement("span");
		dot.style.cssText = `flex-shrink:0;width:9px;height:9px;border-radius:50%;background:${DOT.pending};position:relative;top:0px;display:inline-block;`;
		const txt = document.createElement("span");
		txt.style.cssText = "flex:1;min-width:0;";
		txt.textContent = asin;
		const note = document.createElement("div");
		note.style.cssText = "color:#6e645c;font-size:11.5px;";
		const wrap = document.createElement("div");
		wrap.style.cssText = "flex:1;min-width:0;";
		wrap.appendChild(txt);
		wrap.appendChild(note);
		row.appendChild(dot);
		row.appendChild(wrap);
		o.list.appendChild(row);
		o.rows[asin] = { dot, txt, note };
		return o.rows[asin];
	};

	const updateRow = (asin, state, name, noteText) => {
		const r = itemRow(asin);
		r.dot.style.background = DOT[state] || DOT.unknown;
		if (name) r.txt.textContent = name.substring(0, 60);
		r.note.textContent = noteText || "";
	};

	const footButton = (label, fn, primary) => {
		const b = document.createElement("button");
		b.textContent = label;
		b.style.cssText = `padding:7px 12px;border-radius:8px;border:1.5px solid ${primary ? "#2d6a4f" : "#ded5c8"};background:${primary ? "#2d6a4f" : "#fffdf8"};color:${primary ? "#fff" : "#2a2522"};cursor:pointer;font:600 12.5px -apple-system,sans-serif;`;
		b.onclick = fn;
		overlay().foot.appendChild(b);
		return b;
	};

	/* ── messaging back to the app tab ── */

	const tellApp = (data) => {
		try {
			window.opener?.postMessage(data, "*");
		} catch {}
	};

	/* ── fetch helpers ── */

	const fetchText = async (url, opts = {}) => {
		const ctl = new AbortController();
		setTimeout(() => ctl.abort(), 25000);
		opts.signal = ctl.signal;
		opts.credentials = "include";
		const r = await fetch(url, opts);
		return { status: r.status, url: r.url, ok: r.ok, text: await r.text() };
	};

	const postForm = (url, fields, csrf) => {
		const body = new URLSearchParams(
			Object.entries(fields).map(([k, v]) => [k, v ?? ""]),
		).toString();
		const headers = {
			"Content-Type": "application/x-www-form-urlencoded",
			"X-Requested-With": "XMLHttpRequest",
		};
		if (csrf) headers["anti-csrftoken-a2z"] = csrf;
		return fetchText(url, { method: "POST", headers, body });
	};

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	/* ── add-to-cart strategies ── */

	const ATC_SUCCESS =
		/huc-v2|sw-atc|added to (your )?cart|"cartQuantity"\s*:\s*[1-9]|"isOK"\s*:\s*true|"success"\s*:\s*true|NoCartUpdateRequired|clientResponseModel/i;
	const ATC_ERROR_TEXT = /<div[^>]*class="[^"]*a-alert-content[^"]*"[^>]*>([\s\S]{0,240}?)<\/div>/i;

	const classifyResponse = (r) => {
		const errM = r.text.match(ATC_ERROR_TEXT);
		const err = errM
			? errM[1]
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
					.substring(0, 140)
			: "";
		return {
			status: r.status,
			finalUrl: r.url.substring(0, 120),
			looksOk: r.ok && ATC_SUCCESS.test(r.text) && !/ap\/signin/.test(r.url),
			error: err,
			snippet: r.text.substring(0, 260).replace(/\s+/g, " "),
		};
	};

	// Amazon's own grocery add-to-cart: the fresh/qs widget POSTs its button
	// payload as JSON to /alm/addtofreshcart. Replay a payload harvested from
	// the product page when we have one, else send a minimal one.
	const tryAlmAtc = async (item, pg, brandId) => {
		let payload = null;
		for (const p of pg.almPayloads ?? []) {
			if (!payload || p.__score > payload.__score) payload = p;
		}
		const body = {};
		for (const [k, v] of Object.entries(payload ?? { clientID: "mlab-groceries" })) {
			// stepper payloads carry setQuantityFlag ("set to N"); we want a plain add
			if (k !== "__score" && k !== "setQuantityFlag") body[k] = v;
		}
		body.asin = item.asin;
		body.quantity = item.qty;
		body.almBrandId ??= brandId;
		for (const k of ["additionalParams", "queryLogInfoParams"]) {
			if (typeof body[k] === "string") {
				try {
					body[k] = JSON.parse(body[k]);
				} catch {}
			}
		}
		const csrf = body.additionalParams?.csrfToken || pg.csrf;
		const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
		if (csrf) headers["anti-csrftoken-a2z"] = csrf;
		try {
			const r = await fetchText(
				`/alm/addtofreshcart?almBrandId=${encodeURIComponent(brandId)}&ref_=mlab`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(body),
				},
			);
			return {
				...classifyResponse(r),
				name: "alm-api",
				harvestedPayload: payload ? Object.keys(payload).join(",") : "none",
				csrf: csrf ? "sent" : "none",
			};
		} catch (e) {
			return { name: "alm-api", err: String(e).substring(0, 140) };
		}
	};

	const tryFormPost = async (item, pg, brandId) => {
		const form = pg.forms.find(
			(f) => "submit.add-to-cart" in f.inputs || /add-?to-?cart|handle-buy-box/i.test(f.action),
		);
		if (!form) return { name: "form-post", skipped: "no add-to-cart form found" };
		const fields = { ...form.inputs, quantity: String(item.qty) };
		if (!fields["anti-csrftoken-a2z"] && pg.csrf) fields["anti-csrftoken-a2z"] = pg.csrf;
		let action = form.action || "/gp/add-to-cart/html";
		if (!action.startsWith("http") && !action.startsWith("/")) action = `/${action}`;
		if (!action.includes("almBrandId"))
			action += `${action.includes("?") ? "&" : "?"}almBrandId=${brandId}`;
		try {
			const r = await postForm(action, fields, pg.csrf);
			return {
				...classifyResponse(r),
				name: "form-post",
				action,
				fieldNames: Object.keys(fields).join(","),
			};
		} catch (e) {
			return { name: "form-post", action, err: String(e).substring(0, 140) };
		}
	};

	const tryLegacyJson = async (item, pg, brandId) => {
		const fields = {
			ASIN: item.asin,
			quantity: String(item.qty),
			almBrandId: brandId,
			clientName: "mlab-groceries",
		};
		if (pg.offerListingIds.length) fields.offerListingID = pg.offerListingIds[0];
		if (pg.csrf) fields["anti-csrftoken-a2z"] = pg.csrf;
		try {
			const r = await postForm(`/gp/add-to-cart/json?almBrandId=${brandId}`, fields, pg.csrf);
			return { ...classifyResponse(r), name: "legacy-json" };
		} catch (e) {
			return { name: "legacy-json", err: String(e).substring(0, 140) };
		}
	};

	const tryCartApi = async (item, pg, brandId) => {
		const fields = { asin: item.asin, quantity: String(item.qty), almBrandId: brandId };
		if (pg.offerListingIds.length) fields.offerListingId = pg.offerListingIds[0];
		try {
			const r = await postForm(`/cart/add-to-cart?almBrandId=${brandId}`, fields, pg.csrf);
			return { ...classifyResponse(r), name: "cart-api" };
		} catch (e) {
			return { name: "cart-api", err: String(e).substring(0, 140) };
		}
	};

	/* ── cart snapshot ── */

	const cartSnapshot = async (brandId) => {
		try {
			const r = await fetchText(`/cart/localmarket?almBrandId=${brandId}`);
			return { ...P.parseCart(r.text), status: r.status, finalUrl: r.url.substring(0, 120) };
		} catch (e) {
			return { items: {}, method: "fetch-failed", count: 0, error: String(e).substring(0, 140) };
		}
	};

	/* ── cart run ── */

	const runCart = async (cartItems) => {
		const stores = [...new Set(cartItems.map((it) => it.store))];

		const diag = {
			version: MLAB_VERSION,
			ua: navigator.userAgent,
			when: new Date().toISOString(),
			stores,
			cartBefore: {},
			cartAfter: {},
			items: [],
		};
		const results = [];
		const names = {};
		const images = {};

		overlay();
		for (const it of cartItems) itemRow(it.asin);
		setStatus("Checking your cart…");

		const before = {};
		const after = {};

		for (const s of stores) {
			const snap = await cartSnapshot(ALM_BRAND_IDS[s]);
			before[s] = snap;
			diag.cartBefore[s] = {
				method: snap.method,
				count: snap.count,
				status: snap.status,
				signin: snap.signin,
			};
		}

		// Product pages are ~2 MB each and dominate the run time, so fetch the
		// next item's page while the current item's add request is in flight.
		// Never more than one fetch ahead — gentle enough to not look like a bot.
		const pageCache = [];
		const pageFor = (i) => {
			if (i >= cartItems.length) return null;
			if (!pageCache[i]) {
				const it = cartItems[i];
				pageCache[i] = fetchText(`/dp/${it.asin}?almBrandId=${ALM_BRAND_IDS[it.store]}&fpw=alm`);
				pageCache[i].catch(() => {}); // consumed later; avoid unhandled-rejection noise
			}
			return pageCache[i];
		};

		for (const [idx, item] of cartItems.entries()) {
			setStatus(`Adding ${idx + 1}/${cartItems.length}…`);
			updateRow(item.asin, "working", null, "fetching product page…");
			tellApp({
				type: "mlab-progress",
				current: idx + 1,
				total: cartItems.length,
				asin: item.asin,
			});

			const brandId = ALM_BRAND_IDS[item.store];
			const rec = { asin: item.asin, qty: item.qty, store: item.store, attempts: [] };
			diag.items.push(rec);

			try {
				const r = await pageFor(idx);
				pageFor(idx + 1);
				const pg = P.extractPage(r.text);
				pg.almPayloads = P.findJsonPayloads(r.text, item.asin);
				rec.page = {
					almPayloads: pg.almPayloads.map((p) => Object.keys(p).join(",")),
					status: r.status,
					finalUrl: r.url.substring(0, 120),
					flags: pg.flags,
					forms: pg.forms.map((f) => ({
						action: f.action,
						fields: Object.keys(f.inputs).join(","),
					})),
					offerListingIds: pg.offerListingIds.map(P.redact),
					offeringIds: pg.offeringIds.map(P.redact),
					csrf: pg.csrf ? `found(${pg.csrf.length})` : "MISSING",
					availability: pg.availability,
					snippets: pg.snippets,
				};
				if (pg.title) {
					names[item.asin] = pg.title;
					updateRow(item.asin, "working", pg.title, "adding…");
				}
				if (pg.image) images[item.asin] = pg.image;

				// A store page with no fresh-add-to-cart widget, no payload, no form,
				// and no offer id gives the strategies nothing to work with — Amazon
				// isn't selling this item at the user's store right now.
				const noAtcOffered =
					!pg.almPayloads.length &&
					!pg.flags.freshAtc &&
					!pg.forms.length &&
					!pg.offerListingIds.length;

				if (pg.signedOut || /ap\/signin/.test(r.url)) rec.outcome = "not-signed-in";
				else if (pg.botCheck) rec.outcome = "bot-check";
				else if (pg.flags.unavailable) rec.outcome = "unavailable";
				else if (noAtcOffered) rec.outcome = "no-atc-offered";
				else {
					rec.outcome = "attempts-failed";
					const strategies = [tryAlmAtc, tryFormPost, tryLegacyJson, tryCartApi];
					for (const [sIdx, strat] of strategies.entries()) {
						if (sIdx) await sleep(300);
						const attempt = await strat(item, pg, brandId);
						rec.attempts.push(attempt);
						if (attempt.looksOk) {
							rec.outcome = "attempt-ok";
							break;
						}
					}
				}
			} catch (e) {
				rec.outcome = "page-fetch-failed";
				rec.err = String(e).substring(0, 140);
			}
			await sleep(150);
		}

		for (const s of stores) {
			setStatus("Verifying cart…");
			const snap = await cartSnapshot(ALM_BRAND_IDS[s]);
			after[s] = snap;
			diag.cartAfter[s] = {
				method: snap.method,
				count: snap.count,
				status: snap.status,
				signin: snap.signin,
			};
		}

		let added = 0;
		let problems = 0;

		for (const [idx, item] of cartItems.entries()) {
			const rec = diag.items[idx];
			const b = before[item.store];
			const a = after[item.store];
			const cartWorks = a && a.method !== "none" && a.method !== "fetch-failed" && !a.signin;
			const qBefore = b?.items[item.asin] || 0;
			const qAfter = a?.items[item.asin] || 0;
			const delta = qAfter - qBefore;
			rec.cart = { before: qBefore, after: qAfter };

			let status;
			let detail;
			if (rec.outcome === "not-signed-in") {
				status = "failed";
				detail = "Not signed in to Amazon — sign in and retry.";
			} else if (rec.outcome === "bot-check") {
				status = "failed";
				detail = "Amazon showed a bot check — open any product page, complete it, retry.";
			} else if (rec.outcome === "unavailable") {
				status = "unavailable";
				detail = "Currently unavailable at your store.";
			} else if (rec.outcome === "no-atc-offered") {
				status = "unavailable";
				detail = "Amazon offers no add-to-cart for this item at your store — likely unavailable.";
			} else if (rec.outcome === "page-fetch-failed") {
				status = "failed";
				detail = "Could not load product page.";
			} else if (cartWorks && delta >= item.qty) {
				status = "added";
				detail = `In cart: ${qAfter}${qBefore ? ` (was ${qBefore})` : ""}`;
			} else if (cartWorks && delta > 0) {
				status = "partial";
				detail = `Requested ${item.qty}, cart went up by ${delta} — possible quantity limit.`;
			} else if (cartWorks && qBefore >= item.qty && delta === 0 && rec.outcome === "attempt-ok") {
				status = "added";
				detail = `Already in cart (${qBefore}); Amazon reported no change needed.`;
			} else if (rec.outcome === "attempt-ok" && !cartWorks) {
				status = "unknown";
				detail = "Add request looked OK but the cart could not be read to verify.";
			} else if (rec.outcome === "attempt-ok") {
				status = "unknown";
				detail = "Add request looked OK but the item did not appear in the cart.";
			} else {
				status = "failed";
				let lastErr = "";
				for (const at of rec.attempts) if (at.error) lastErr = at.error;
				detail = lastErr || "All add strategies failed — the diagnostics were sent to the app.";
			}

			if (status === "added") added++;
			else problems++;
			rec.status = status;
			results.push({
				asin: item.asin,
				qty: item.qty,
				store: item.store,
				status,
				detail,
				name: names[item.asin] || "",
			});
			updateRow(item.asin, status, names[item.asin], detail);
		}

		let diagStr = JSON.stringify(diag, null, 1);
		if (diagStr.length > 60000) diagStr = `${diagStr.substring(0, 60000)}\n…truncated`;

		setStatus(
			`${added}/${cartItems.length} added${problems ? `, ${problems} need attention` : ""}`,
		);

		tellApp({
			type: "mlab-report",
			version: MLAB_VERSION,
			results,
			names,
			images,
			diagnostics: diagStr,
		});

		const cartUrl = `https://www.amazon.com/cart/localmarket?almBrandId=${ALM_BRAND_IDS[stores[0]]}`;
		footButton("Copy diagnostics", () => {
			(navigator.clipboard ? navigator.clipboard.writeText(diagStr) : Promise.reject()).then(
				() => setStatus("Diagnostics copied — paste them to Claude."),
				() => prompt("Copy this:", diagStr.substring(0, 2000)),
			);
		});
		footButton(
			`Open ${stores[0] === "fresh" ? "Fresh" : "Whole Foods"} cart`,
			() => {
				location.href = cartUrl;
			},
			true,
		);

		if (!problems) {
			setTimeout(() => {
				location.href = cartUrl;
			}, 1800);
		}
	};

	/* ── names sync (Sync button in the app) ── */

	const runNames = async (asins) => {
		overlay();
		const names = {};
		const images = {};
		for (const [idx, asin] of asins.entries()) {
			setStatus(`Fetching info ${idx + 1}/${asins.length}…`);
			updateRow(asin, "working");
			try {
				const r = await fetchText(`/dp/${asin}`);
				const pg = P.extractPage(r.text);
				if (pg.title) names[asin] = pg.title;
				if (pg.image) images[asin] = pg.image;
				updateRow(asin, pg.title ? "added" : "unknown", pg.title, pg.title ? "" : "no title found");
			} catch {
				updateRow(asin, "failed", null, "fetch failed");
			}
			await sleep(250);
		}
		tellApp({ type: "mlab-names", names, images });
		setStatus(`Done — sent ${Object.keys(names).length} names to the app. This tab can be closed.`);
	};

	/* ── order import (scrape ASINs off the current page) ── */

	const runImport = () => {
		const found = {};
		for (const a of document.querySelectorAll('a[href*="/dp/"],a[href*="/gp/product/"]')) {
			const m = a.href.match(/[/](?:dp|gp[/]product)[/]([A-Z0-9]{10})/i);
			if (!m) continue;
			const asin = m[1].toUpperCase();
			if (found[asin]) continue;
			let name = a.textContent.trim().substring(0, 120) || asin;
			if (name.length < 3 || /^(shop|buy|view|see)/i.test(name)) name = asin;
			const box = a.closest("tr,div,[class*=item],[class*=order]");
			const img = box?.querySelector("img[src*=media-amazon]");
			found[asin] = { asin, name, image: img ? img.src : "" };
		}
		const items = Object.values(found);
		if (items.length) {
			tellApp({ type: "mlab-import", items });
			alert(`Found ${items.length} item(s) — sent to your grocery list.`);
		} else {
			alert("No products found on this page.");
		}
	};

	/* ── entry ── */

	// A crash must never be silent: it would leave the "already running" flag
	// stuck with nothing on screen. The overlay itself may be what crashed, so
	// fall back to alert().
	const reportCrash = (e) => {
		window.__mlabRunning = false;
		try {
			setStatus(`Crashed: ${e}`);
		} catch {
			alert(`M'lab Groceries crashed: ${e}`);
		}
	};

	try {
		const payload = P.parsePayload(location.hash);
		if (!payload.importMode && /mlab-import/.test(location.href)) payload.importMode = true;

		if (payload.importMode) {
			runImport();
		} else if (payload.cart.length) {
			runCart(payload.cart).catch(reportCrash);
		} else if (payload.names.length) {
			runNames(payload.names).catch(reportCrash);
		} else {
			const manual = prompt(
				"No M'lab payload found in the URL.\nPaste an ASIN:QTY list (comma-separated), or Cancel:",
			);
			if (manual) {
				const p2 = P.parsePayload(`mlab-groceries=${manual.replace(/\s+/g, "")}`);
				if (p2.cart.length) runCart(p2.cart).catch(reportCrash);
				else alert("No valid ASINs found.");
			} else {
				window.__mlabRunning = false;
			}
		}
	} catch (e) {
		window.__mlabRunning = false;
		alert(
			`M'lab Groceries could not start: ${e}\n\nIf the page was still loading, let it finish and click the bookmark again.`,
		);
	}
})();
