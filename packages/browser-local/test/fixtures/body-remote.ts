/** Typed body port on the existing disposable HTTP fixture, never a product route. */
import { createRemoteFixture } from "./remote-fixture.ts";
import { serveRemoteFixture } from "./remote-http.ts";
import { createBodyAuthority } from "./body-authority.ts";

export async function serveBodyFixture() {
  const fixture = await createRemoteFixture();
  const body = await createBodyAuthority(fixture.authority);
  const original = fixture.hosted;
  fixture.hosted = async request => {
    const path = new URL(request.url).pathname;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (path === "/fixture/body/control") {
      if (request.method === "POST") {
        const change = await request.json() as { action: string };
        if (change.action === "offline") body.knobs.offline = true;
        else if (change.action === "online") { body.knobs.offline = false; body.knobs.lookupUnavailable = false; }
        else if (change.action === "drop") { body.knobs.dropNextResponse = true; body.knobs.lookupUnavailable = true; }
        else return new Response("Unknown fixture control", { status: 400 });
      }
      return json({ ...body.counts, offline: body.knobs.offline, droppedPending: body.knobs.lookupUnavailable });
    }
    if (path === "/fixture/body/submit") return json(await body.transport.submit(await request.json() as never));
    if (path === "/fixture/body/lookup") return json(await body.transport.lookup(await request.json() as never));
    if (body.knobs.offline) throw new TypeError("Synthetic authority offline");
    return original(request);
  };
  return { ...(await serveRemoteFixture(fixture)), body };
}
