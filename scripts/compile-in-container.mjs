import ts from 'typescript';
import fs from 'fs';
import path from 'path';

const files = [
  { src: '/tmp/compile/src/temporal/activities/index.ts', dst: '/tmp/compile/dist/activities.index.js' },
  { src: '/tmp/compile/src/temporal/workflows/react-workflow.ts', dst: '/tmp/compile/dist/workflows.react-workflow.js' },
  { src: '/tmp/compile/src/temporal/types.ts', dst: '/tmp/compile/dist/types.js' },
  { src: '/tmp/compile/src/temporal/classification.ts', dst: '/tmp/compile/dist/classification.js' },
];

for (const f of files) {
  const dir = path.dirname(f.dst);
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write to symlinked directory: ${dir}`);
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const source = fs.readFileSync(f.src, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
      sourceMap: true,
    }
  });
  fs.writeFileSync(f.dst, result.outputText);
  console.log('OK: ' + f.dst + ' (' + result.outputText.length + ' bytes)');
}

console.log('All files compiled');
