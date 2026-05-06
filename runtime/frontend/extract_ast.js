import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_DIR = path.resolve(__dirname, "src");

function getFiles(dir, filesList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getFiles(filePath, filesList);
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      filesList.push(filePath);
    }
  }
  return filesList;
}

const allFiles = getFiles(SRC_DIR);

const program = ts.createProgram(allFiles, {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.React,
});

const checker = program.getTypeChecker();

const results = {};

function visit(node, sourceFile, fileData) {
  // Capture imports
  if (ts.isImportDeclaration(node)) {
    const importPath = node.moduleSpecifier.text;
    fileData.imports.push(importPath);
  }

  // Capture variables/functions that might be components or hooks
  if (ts.isFunctionDeclaration(node) && node.name) {
    fileData.declarations.push({
      type: "Function",
      name: node.name.text
    });
  }

  if (ts.isVariableStatement(node)) {
    node.declarationList.declarations.forEach(decl => {
      if (decl.name && decl.name.text) {
        fileData.declarations.push({
          type: "Variable",
          name: decl.name.text
        });
      }
    });
  }

  // Basic hook usage detection (call expressions starting with "use")
  if (ts.isCallExpression(node)) {
    if (node.expression && ts.isIdentifier(node.expression)) {
      const funcName = node.expression.text;
      if (funcName.startsWith("use")) {
        fileData.hooks.push(funcName);
      }
    }
  }

  ts.forEachChild(node, child => visit(child, sourceFile, fileData));
}

for (const sourceFile of program.getSourceFiles()) {
  const normalizedFileName = sourceFile.fileName.replace(/\\/g, '/');
  const normalizedSrcDir = SRC_DIR.replace(/\\/g, '/');
  if (!sourceFile.isDeclarationFile && normalizedFileName.startsWith(normalizedSrcDir)) {
    const fileData = {
      path: path.relative(SRC_DIR, sourceFile.fileName),
      lines: sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1,
      imports: [],
      declarations: [],
      hooks: []
    };
    
    // Visit all nodes
    ts.forEachChild(sourceFile, node => visit(node, sourceFile, fileData));
    
    // Deduplicate hooks
    fileData.hooks = [...new Set(fileData.hooks)];
    
    results[fileData.path] = fileData;
  }
}

fs.writeFileSync(path.resolve(__dirname, "ast_facts.json"), JSON.stringify(results, null, 2));
console.log("AST facts extracted to ast_facts.json");
