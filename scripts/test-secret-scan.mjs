import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const rules = [
  ['chave privada', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['Groq', /gsk_[A-Za-z0-9_-]{20,}/g],
  ['OpenAI', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['GitHub', /gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}/g],
  ['Google', /AIza[A-Za-z0-9_-]{30,}/g],
  ['AWS', /AKIA[0-9A-Z]{16}/g],
  ['PostgreSQL com senha', /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi]
];

function placeholder(value) {
  return /(?:placeholder|example|exemplo|teste|test_|troque|defina|sua[_-]?chave|your[_-]?key|não[_-]?real)/i.test(value);
}

const findings = [];
for (const file of trackedFiles) {
  if (/\.(?:png|jpe?g|gif|webp|ico|woff2?|zip)$/i.test(file)) continue;
  let content;
  try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
  for (const [name, expression] of rules) {
    expression.lastIndex = 0;
    for (const match of content.matchAll(expression)) {
      if (!placeholder(match[0])) findings.push(`${file}: possível segredo ${name}`);
    }
  }
}

assert.deepEqual(findings, [], findings.join('\n'));
console.log(`Segredos: ${trackedFiles.length} arquivo(s) versionado(s) verificado(s), sem credenciais atuais.`);
