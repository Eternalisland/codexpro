import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromDist = name => import(pathToFileURL(path.join(base,"dist",name)).href);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-jdt-test-"));
const previous = process.env.CODEXPRO_JDTLS_HOME;
const [configApi, guardApi, clientApi, navApi, wsNav, analysisApi] = await Promise.all([
  fromDist("config.js"), fromDist("guard.js"), fromDist("analysis/jdtClient.js"),
  fromDist("analysis/jdtNavigation.js"), fromDist("analysis/symbolNavigation.js"),
  fromDist("analysis/index.js")
]);
const create = async (name, text) => {
  const abs = path.join(fixture, name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
};
try {
  await create("src/UserService.java", [
    "package example;",
    "public class UserService implements Repo {",
    "  public void updateUser(String id) {}",
    "}"
  ].join("\n") + "\n");
  await create("src/Repo.java", "public interface Repo { void updateUser(String id); }\n");
  await create("src/Caller.java", [
    "package example;",
    "public class Caller {",
    "  void run() { new UserService().updateUser(\"Hi\"); }",
    "}"
  ].join("\n") + "\n");
  await create("src/test/UserServiceTest.java", "package example;\nclass UserServiceTest { void test() {} }\n");
  const config = configApi.loadConfig(["--root",fixture,"--allow-root",fixture, "--bash", "off"]);
  const guard = new guardApi.PathGuard(config), ws = new guardApi.WorkspaceManager(config).defaultWorkspace();
  delete process.env.CODEXPRO_JDTLS_HOME;
  const noJdt = await navApi.jdtImplementations(config,guard,ws,{
    path:"src/Repo.java",symbol:"Repo" });
  assert.equal(noJdt.status,"unavailable");
  const heuristic = await wsNav.findWorkspaceReferences(config,guard,ws,{
    path:"src/UserService.java",symbol:"UserService.updateUser" });
  assert.notEqual(heuristic.backend,"jdt-lsp");

  // Inject an actual stdio JSON-RPC child process; no installed JDT LS required.
  process.env.CODEXPRO_JDTLS_HOME = "mock-jdtls-runtime";
  const launch = { command:process.execPath,
    args:[path.join(base,"scripts","jdt-mock-server.mjs")], timeoutMs:5000 };
  const client = await clientApi.getJdtClient(ws, launch);
  const same = await clientApi.getJdtClient(ws);
  assert.equal(same,client,"workspace must reuse the Java language process");
  const symbol = await wsNav.findWorkspaceSymbol(config,guard,ws,{
    path:"src/UserService.java",symbol:"UserService.updateUser" });
  assert.equal(symbol.definitions.length,1);
  assert.equal(symbol.definitions[0].source,"jdt-lsp");
  assert.equal(symbol.definitions[0].confidence,"resolved");

  const refs = await wsNav.findWorkspaceReferences(config,guard,ws,{
    path:"src/UserService.java", symbol:"UserService.updateUser",includeTests:false });
  assert.equal(refs.backend,"jdt-lsp");
  assert(refs.references.some(x=>x.path==="src/Caller.java" && x.source==="jdt-lsp"));
  assert(!refs.references.some(x=>x.path.startsWith("src/test")));
  assert.equal(refs.truncated,true,"out-of-workspace references must mark incomplete coverage");

  const impl = await navApi.jdtImplementations(config,guard,ws,{
    path:"src/Repo.java",symbol:"Repo" });
  assert.equal(impl.status,"ok");
  assert(impl.implementations.some(x=>x.path==="src/UserService.java"));
  const hierarchy = await navApi.jdtHierarchy(config,guard,ws,{
    path:"src/Repo.java",symbol:"Repo",direction:"both" });
  assert.equal(hierarchy.status,"ok");
  assert.equal(hierarchy.subtypes[0].path,"src/UserService.java");
  assert.deepEqual(hierarchy.supertypes,[]);
  const qualifiedType = await navApi.jdtHierarchy(config,guard,ws,{
    path:"src/Repo.java",symbol:"example.Repo",direction:"subtypes" });
  assert.equal(qualifiedType.status,"ok");
  assert.equal(qualifiedType.jdt_diagnostic.selection_source,"jdt-document-symbol");
  const before = await client.request("mock/stats",{});
  assert.equal(before.initializes,1);
  assert.deepEqual(before.initialization_folders,[pathToFileURL(fixture).href]);
  assert.equal(before.opens,2);

  await fs.appendFile(path.join(fixture,"src/UserService.java"),"// changed\n");
  analysisApi.invalidateWorkspaceAnalysis(ws.id);
  await wsNav.findWorkspaceSymbol(config,guard,ws,{
    path:"src/UserService.java",symbol:"UserService.updateUser" });
  const after = await client.request("mock/stats",{});
  assert.equal(after.changes,1,"open files must receive didChange after source updates");
  assert.equal(client.diagnostics().service_status_code,0);
  assert(client.diagnostics().progress_notifications >= 2);
  assert.equal(client.diagnostics().active_progress_tokens,0);
  await client.request("mock/flatSymbols",{});
  const flatHierarchy = await navApi.jdtHierarchy(config,guard,ws,{
    path:"src/Repo.java",symbol:"Repo",direction:"subtypes" });
  assert.equal(flatHierarchy.status,"ok");
  assert.equal(flatHierarchy.jdt_diagnostic.document_symbol_format,"symbol-information");

  // JDT can return no document symbols while importing a Maven workspace.
  // A bounded file-local cursor must still permit LSP hierarchy/references without the global index.
  await client.request("mock/emptySymbols",{});
  const constrained = { ...config, analysisLimits: { ...config.analysisLimits,
    maxInventoryFiles: 1, maxAnalyzedFiles: 1, maxScannedBytes: 1024 } };
  const local = await wsNav.findWorkspaceSymbol(constrained,guard,ws,{
    path:"src/UserService.java",symbol:"UserService.updateUser" });
  assert.equal(local.definitions.length,1);
  assert.equal(local.backend,"java-source-heuristic",
    "An unverified lexical definition must not be presented as resolved by JDT.");
  assert.equal(local.jdt_diagnostic.document_symbol_format,"empty");
  assert.equal(local.jdt_diagnostic.selection_source,"java-file-lexical");
  const noDocRefs = await wsNav.findWorkspaceReferences(constrained,guard,ws,{
    path:"src/UserService.java",symbol:"UserService.updateUser" });
  assert.equal(noDocRefs.backend,"jdt-lsp");
  assert(noDocRefs.references.some(x=>x.path==="src/Caller.java"));
  assert.equal(noDocRefs.jdt_diagnostic.selection_source,"java-file-lexical");
  const noDocHierarchy = await navApi.jdtHierarchy(constrained,guard,ws,{
    path:"src/Repo.java",symbol:"Repo",direction:"both" });
  assert.equal(noDocHierarchy.status,"ok");
  assert.equal(noDocHierarchy.subtypes[0].path,"src/UserService.java");
  const noDocImpl = await navApi.jdtImplementations(constrained,guard,ws,{
    path:"src/Repo.java",symbol:"Repo" });
  assert.equal(noDocImpl.status,"ok");

  await create("src/Overloaded.java", [
    "package example;",
    "public class Overloaded {",
    "  void updateUser(String id) {}",
    "  void updateUser(int id) {}",
    "}"
  ].join("\n"));
  const overload = await wsNav.findWorkspaceReferences(constrained,guard,ws,{
    path:"src/Overloaded.java",symbol:"Overloaded.updateUser" });
  assert.equal(overload.ambiguous,true);
  assert.equal(overload.backend,"java-source-heuristic");
  assert.equal(overload.references.length,0);
  const narrowed = await wsNav.findWorkspaceReferences(constrained,guard,ws,{
    path:"src/Overloaded.java",symbol:"Overloaded.updateUser",parameterTypes:["int"] });
  assert.equal(narrowed.backend,"jdt-lsp");
  assert.equal(narrowed.definitions[0].parameter_types[0],"int");

  await client.request("mock/failReferences",{});
  const failed = await wsNav.findWorkspaceReferences(config,guard,ws,{
    path:"src/UserService.java",symbol:"UserService.updateUser" });
  assert.equal(failed.backend,"java-source-heuristic");
  assert(failed.warnings.some(w=>w.includes("JDT LS unavailable")));
  assert(failed.references.every(x=>x.confidence==="inferred"));
  console.log("JDT LS mock integration passed (reuse, references, implementations, hierarchy, change, failure fallback)");
} finally {
  await clientApi.shutdownJdtClients();
  if (previous === undefined) delete process.env.CODEXPRO_JDTLS_HOME;
  else process.env.CODEXPRO_JDTLS_HOME = previous;
  await fs.rm(fixture, { recursive: true, force: true });
}
