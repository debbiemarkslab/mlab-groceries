import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.ts";

const dir = mkdtempSync(join(tmpdir(), "mlab-test-"));
await Bun.write(join(dir, "index.html"), "<h1>app</h1>");
const server = createServer(0, dir);
afterAll(() => server.stop());

test("serves the app at /", async () => {
	const res = await fetch(server.url);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("<h1>app</h1>");
});

test("POST /save writes groceries.json", async () => {
	const body = '{"items":[]}';
	const res = await fetch(new URL("/save", server.url), { method: "POST", body });
	expect(res.status).toBe(200);
	expect(await Bun.file(join(dir, "groceries.json")).text()).toBe(body);
});

test("POST /diag writes last-diagnostics.json", async () => {
	const res = await fetch(new URL("/diag", server.url), { method: "POST", body: '{"v":1}' });
	expect(res.status).toBe(200);
	expect(await Bun.file(join(dir, "last-diagnostics.json")).text()).toBe('{"v":1}');
});

test("404s on missing files", async () => {
	const res = await fetch(new URL("/nope.js", server.url));
	expect(res.status).toBe(404);
});
