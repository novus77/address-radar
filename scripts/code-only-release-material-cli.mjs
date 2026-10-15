import { produceCodeOnlyReleaseMaterial } from './produce-code-only-release-material.mjs';

try {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 ** 2) throw new Error('input_budget');
    chunks.push(chunk);
  }
  const output = JSON.stringify(produceCodeOnlyReleaseMaterial(Buffer.concat(chunks).toString('utf8')));
  if (Buffer.byteLength(output) > 2 * 1024 ** 2) throw new Error('output_budget');
  process.stdout.write(output + '\n');
} catch {
  process.stderr.write('code_only_material_refused\n');
  process.exitCode = 1;
}
