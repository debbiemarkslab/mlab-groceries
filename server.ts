// M'lab Groceries dev server: static files + two write endpoints.
// Run: bun server.ts

const DIR = import.meta.dir;

export function createServer(port: number, dir = DIR) {
	return Bun.serve({
		port,
		async fetch(req) {
			const { pathname } = new URL(req.url);

			if (req.method === "POST" && pathname === "/save") {
				await Bun.write(`${dir}/groceries.json`, await req.text());
				return Response.json({ ok: true });
			}

			// Order-run diagnostics from the app tab, saved to disk so Claude can
			// read them directly instead of the user copy-pasting.
			if (req.method === "POST" && pathname === "/diag") {
				await Bun.write(`${dir}/last-diagnostics.json`, await req.text());
				return Response.json({ ok: true });
			}

			if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
			const file = Bun.file(`${dir}${pathname === "/" ? "/index.html" : pathname}`);
			if (!(await file.exists())) return new Response("Not found", { status: 404 });
			return new Response(file, { headers: { "Cache-Control": "no-store" } });
		},
	});
}

if (import.meta.main) {
	const server = createServer(8080);
	console.log(server.url.href);
}
