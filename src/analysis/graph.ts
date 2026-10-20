import type { ExtractedFile } from "./extract.js";
import type { AnalysisRelationship, InventoryFile } from "./types.js";

/**
 * V100(20261019) yijiakang 【可靠性修复】传播依赖关系预算截断状态并保留原有数组接口，任务号:20260509145520000648
 */
const verNum = "V100(20261019)";

export function buildRelationshipsWithCoverage(
  extractedFiles: ExtractedFile[],
  inventoryFiles: InventoryFile[],
  maxRelationships: number
): { relationships: AnalysisRelationship[]; truncated: boolean } {
  const roles = new Map(inventoryFiles.map((file) => [file.path, file.role]));
  const relationships: AnalysisRelationship[] = [];
  for (const file of extractedFiles) {
    for (const target of file.imports) {
      // 仅在确实丢弃下一条关系时标记部分覆盖，避免恰好等于预算上限时误报。
      if (relationships.length >= maxRelationships) return { relationships, truncated: true };
      relationships.push({
        from: file.path,
        to: target,
        kind: roles.get(file.path) === "test" ? "tests" : "imports",
        confidence: "strong",
        source: "built-in import extraction"
      });
    }
  }
  return { relationships, truncated: false };
}

export function buildRelationships(extractedFiles: ExtractedFile[], inventoryFiles: InventoryFile[], maxRelationships: number): AnalysisRelationship[] {
  // 旧调用方继续接收数组；分析入口使用带覆盖率状态的接口。
  return buildRelationshipsWithCoverage(extractedFiles, inventoryFiles, maxRelationships).relationships;
}

export function reverseDependencies(relationships: AnalysisRelationship[], targetPath: string): AnalysisRelationship[] {
  return relationships.filter((relationship) => relationship.to === targetPath);
}
