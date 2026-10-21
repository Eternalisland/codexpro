import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

let pending = Buffer.alloc(0);
const events = [];
let failRefs = false;
let emptySymbols = false;
let flatSymbols = false;
const file = name => pathToFileURL(path.join(process.cwd(), name)).href;
const point = (line, character) => ({ line, character });
const range = (line, char, last = char + 10) => ({ start: point(line, char), end: point(line, last) });
const location = (name, line, char) => ({ uri: file(name), range: range(line, char) });
const method = { name: "updateUser(String)", kind: 6,
  range: { start: point(2,0), end: point(2,42) },
  selectionRange: range(2,14) };
const cls = { name: "UserService", kind: 5,
  range: { start: point(1,0), end: point(3,1) },
  selectionRange: range(1,13), children: [method] };
const iface = { name: "Repo", kind: 11,
  range: { start: point(0,0), end: point(2,0) },
  selectionRange: range(0,17) };
function send(body) {
  const json = Buffer.from(JSON.stringify(body));
  const output = Buffer.concat([Buffer.from("Content-Length: " + json.length + "\r\n\r\n"), json]);
  // Fragment a response so the client cannot assume each chunk is a whole frame.
  process.stdout.write(output.subarray(0, 15));
  process.stdout.write(output.subarray(15));
}
function respond(id, result, error) {
  send({ jsonrpc: "2.0", id, ...(error ? { error: { code: -32000, message: "simulated" } } : { result }) });
}
function handle(msg) {
  if (msg.method) events.push({ method: msg.method, params: msg.params });
  if (msg.method === "initialized") {
    send({ jsonrpc: "2.0", method: "language/status", params: { type: 0, message: "test ready" } });
    send({ jsonrpc: "2.0", method: "$/progress", params: { token: "import", value: { kind: "begin" } } });
    send({ jsonrpc: "2.0", method: "$/progress", params: { token: "import", value: { kind: "end" } } });
  }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    const folders = msg.params?.initializationOptions?.workspaceFolders;
    const expected = file(".");
    if (!Array.isArray(folders) || folders.length !== 1 || folders[0] !== expected ||
        msg.params?.initializationOptions?.settings?.java?.import?.maven?.enabled !== true) {
      respond(msg.id,null,true); return;
    }
    respond(msg.id, { capabilities: { documentSymbolProvider: true, referencesProvider: true,
      implementationProvider: true, typeHierarchyProvider: true } }); return;
  }
  if (msg.method === "textDocument/documentSymbol") {
    const selected = msg.params.textDocument.uri.endsWith("/Repo.java") ? iface : cls;
    respond(msg.id, emptySymbols ? [] : flatSymbols ? [{
      name: selected.name, kind: selected.kind,
      location: { uri: msg.params.textDocument.uri, range: selected.selectionRange }
    }] : [selected]); return;
  }
  if (msg.method === "textDocument/references") {
    if (failRefs) { respond(msg.id, null, true); return; }
    respond(msg.id, [
      location("src/UserService.java",2,14), location("src/Caller.java",2,22),
      location("src/test/UserServiceTest.java",1,21),
      location("../outside-secret.java",0,0)
    ]); return;
  }
  if (msg.method === "textDocument/implementation") {
    respond(msg.id, [location("src/UserService.java",1,13)]); return;
  }
  if (msg.method === "textDocument/prepareTypeHierarchy") {
    respond(msg.id, [{ name:"Repo", kind:11, uri:file("src/Repo.java"),
      range:range(0,0), selectionRange:range(0,17), data:{ key:"repo" } }]); return;
  }
  if (msg.method === "typeHierarchy/supertypes") { respond(msg.id, []); return; }
  if (msg.method === "typeHierarchy/subtypes") {
    respond(msg.id, [{name:"UserService",kind:5,uri:file("src/UserService.java"),
      range:range(1,0),selectionRange:range(1,13)}]); return;
  }
  if (msg.method === "mock/flatSymbols") { flatSymbols = true; respond(msg.id,true); return; }
  if (msg.method === "mock/emptySymbols") { emptySymbols = true; respond(msg.id,true); return; }
  if (msg.method === "mock/failReferences") { failRefs = true; respond(msg.id,true); return; }
  if (msg.method === "mock/stats") { respond(msg.id, { pid:process.pid,
    opens:events.filter(e=>e.method==="textDocument/didOpen").length,
    changes:events.filter(e=>e.method==="textDocument/didChange").length,
    initializes:events.filter(e=>e.method==="initialize").length,
    initialization_folders:events.find(e=>e.method==="initialize")?.params?.initializationOptions?.workspaceFolders ?? [] }); return; }
  respond(msg.id, null);
}
process.stdin.on("data", chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const split = pending.indexOf("\r\n\r\n");
    if (split < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(pending.subarray(0,split).toString("ascii"));
    if (!match) process.exit(3);
    const end = split + 4 + Number(match[1]);
    if (pending.length < end) return;
    const msg = JSON.parse(pending.subarray(split+4,end).toString("utf8"));
    pending = pending.subarray(end);
    handle(msg);
  }
});
