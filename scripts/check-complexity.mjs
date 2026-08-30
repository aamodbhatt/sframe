import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import ts from 'typescript';

const roots = ['apps', 'packages', 'examples'];
const maximum = 20;
// Candidate U's audited channel/state-machine functions predate this guardrail.
// Their measured ceilings are frozen: increases fail, and refactors may only lower them.
const frozenBaseline = new Map([
  ['apps/api/src/do-room.ts:routeRequest', 22],
  ['apps/api/src/do-room.ts:initializeForPhase0', 23],
  ['apps/controller/src/main.ts:onMessage', 24],
  ['apps/controller/src/main.ts:onPortMessage', 146],
  ['apps/renderer/src/renderer.ts:visit', 36],
  ['apps/renderer/src/renderer.ts:applyProps', 35],
  ['apps/renderer/src/renderer.ts:<anonymous>', 60],
  ['apps/renderer/src/renderer.ts:onPortMessage', 25],
  ['apps/renderer/src/renderer.ts:receiveInit', 28],
  ['packages/protocol/src/runtime-config.ts:readExactOrigin', 21]
]);
const files = [];
const walk = (path) => {
  for (const entry of readdirSync(path)) {
    const target = join(path, entry);
    const stat = statSync(target);
    if (stat.isDirectory()) walk(target);
    else if (/\.(?:ts|tsx)$/u.test(entry) && !entry.endsWith('.d.ts')) files.push(target);
  }
};
for (const root of roots) walk(root);

const functionName = (node) => {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) return parent.name?.getText() ?? '<anonymous>';
  return '<anonymous>';
};

const branchWeight = (node) => {
  if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCatchClause(node) || ts.isConditionalExpression(node)) return 1;
  if (ts.isCaseClause(node)) return 1;
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return 1;
  return 0;
};

const findings = [];
for (const file of files.sort()) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const collect = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      let complexity = 1;
      const score = (child) => {
        if (child !== node && ts.isFunctionLike(child)) return;
        complexity += branchWeight(child);
        ts.forEachChild(child, score);
      };
      score(node.body);
      const name = functionName(node);
      const baseline = frozenBaseline.get(`${relative(process.cwd(), file)}:${name}`);
      if (complexity > (baseline ?? maximum)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({file: relative(process.cwd(), file), line: position.line + 1, name, complexity, maximum: baseline ?? maximum});
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.name} cyclomatic=${finding.complexity} (max ${finding.maximum})`);
  process.exit(1);
}
console.log(`Cyclomatic complexity: ${files.length} TypeScript files checked; new functions max ${maximum}; audited Phase 0 baselines may not increase.`);
