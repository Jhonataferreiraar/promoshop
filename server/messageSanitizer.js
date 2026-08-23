export function stripAffiliateDisclosure(message) {
  return String(message || '')
    .split('\n')
    .filter((line) => !/afiliad|venda\s+direta/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
