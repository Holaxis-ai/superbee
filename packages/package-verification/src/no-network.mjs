import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const denied = () => { throw new Error("Network refused by package verification"); };
globalThis.fetch = async () => denied();
for (const transport of [http, https]) { transport.request = denied; transport.get = denied; }
net.connect = denied;
net.createConnection = denied;
net.Socket.prototype.connect = denied;
syncBuiltinESMExports();
