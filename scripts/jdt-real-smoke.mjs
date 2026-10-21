import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Runs against an installed Eclipse JDT LS on a disposable Maven fixture, not a user repository.
// This is intentionally separate from the mock-only smoke suite.
const base = path.resolve(import.meta.dirname, "..");
const moduleAt = name => import(pathToFileURL(path.join(base, "dist", name)).href);
const [configApi, guardApi, clientApi, navApi] = await Promise.all([
  moduleAt("config.js"), moduleAt("guard.js"),
  moduleAt("analysis/jdtClient.js"), moduleAt("analysis/jdtNavigation.js")
]);
assert(process.env.CODEXPRO_JDTLS_HOME?.trim(),
  "Set CODEXPRO_JDTLS_HOME before running a real JDT LS acceptance test.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-jdt-real-"));
const write = async (rel, contents) => {
  const absolute = path.join(root, rel);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");
};
const source = "src/main/java/sample/";
try {
  await write("pom.xml", [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    "<modelVersion>4.0.0</modelVersion>",
    "<groupId>sample</groupId><artifactId>jdt-acceptance</artifactId><version>1.0</version>",
    "<properties><maven.compiler.release>17</maven.compiler.release></properties>",
    "</project>"
  ].join("\n"));
  await write(source + "Service.java",
    "package sample;\npublic interface Service { String value(); }\n");
  await write(source + "Implementation.java",
    "package sample;\npublic class Implementation implements Service { public String value() { return \"ok\"; } }\n");
  await write(source + "Caller.java",
    "package sample;\npublic class Caller { String run(Service service) { return service.value(); } }\n");

  const config = configApi.loadConfig(["--root", root, "--allow-root", root, "--bash", "off", "--write", "off"]);
  const guard = new guardApi.PathGuard(config);
  const workspace = new guardApi.WorkspaceManager(config).defaultWorkspace();
  const opts = { symbol: "Service", path: source + "Service.java", maxResults: 20 };
  let result;
  const deadline = Date.now() + 100_000;
  let tries = 0;
  do {
    tries++;
    result = await navApi.jdtSymbol(config, guard, workspace, opts);
    if (result.backend === "jdt-lsp") break;
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 4000));
  } while (Date.now() < deadline && tries < 12);
  console.log("real JDT symbol:", JSON.stringify({
    attempts: tries, backend: result.backend,
    diagnostics: result.jdt_diagnostic, warnings: result.warnings
  }));
  assert.equal(result.backend, "jdt-lsp", "Real JDT must return confirmed document symbols.");

  const hierarchy = await navApi.jdtHierarchy(config, guard, workspace, { ...opts, direction: "subtypes" });
  console.log("real JDT hierarchy:", JSON.stringify({
    status: hierarchy.status, nodes: hierarchy.subtypes?.length ?? 0,
    reason: hierarchy.reason, diagnostics: hierarchy.jdt_diagnostic
  }));
  assert.equal(hierarchy.status, "ok");
  assert(hierarchy.subtypes.some(x => x.path === source + "Implementation.java"));

  const refs = await navApi.jdtReferences(config, guard, workspace, {
    symbol: "Service.value", path: source + "Service.java", maxResults: 20
  });
  console.log("real JDT references:", JSON.stringify({
    backend: refs.backend, count: refs.references?.length ?? 0,
    diagnostics: refs.jdt_diagnostic, warnings: refs.warnings
  }));
  assert.equal(refs.backend, "jdt-lsp");
  assert(refs.references.some(x => x.path === source + "Caller.java"));
  console.log("Real JDT LS Maven fixture passed: symbols, type hierarchy, references.");
} finally {
  await clientApi.shutdownJdtClients();
  await fs.rm(root, { recursive: true, force: true });
}
