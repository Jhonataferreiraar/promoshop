import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const blockedAddresses = new net.BlockList();

for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2001:2::', 48, 'ipv6'],
  ['2001:10::', 28, 'ipv6'],
  ['2001:20::', 28, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6']
]) blockedAddresses.addSubnet(address, prefix, family);

function normalizeMappedIpv4(address) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hexadecimal) return address;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isPublicRemoteAddress(value) {
  const address = normalizeMappedIpv4(String(value || '').trim());
  const version = net.isIP(address);
  if (!version) return false;
  return !blockedAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

export function validateRemoteHttpsUrl(value) {
  let parsed;
  try {
    parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value || ''));
  } catch {
    throw new Error('O endereço remoto é inválido.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('O endereço remoto precisa usar HTTPS.');
  }
  if (parsed.port && parsed.port !== '443') throw new Error('A porta do endereço remoto não é permitida.');
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('O endereço remoto não é público.');
  }
  return parsed;
}

async function resolvePublicAddress(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicRemoteAddress(hostname)) throw new Error('O endereço remoto não é público.');
    return { address: normalizeMappedIpv4(hostname), family: net.isIP(normalizeMappedIpv4(hostname)) };
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.filter((entry) => isPublicRemoteAddress(entry.address));
  if (!addresses.length || publicAddresses.length !== addresses.length) {
    throw new Error('O domínio remoto aponta para uma rede não permitida.');
  }
  return publicAddresses[0];
}

export function createPinnedLookup(resolved) {
  return (_hostname, options, callback) => options?.all
    ? callback(null, [{ address: resolved.address, family: resolved.family }])
    : callback(null, resolved.address, resolved.family);
}

function requestBuffer(url, { maximumBytes, timeoutMs, headers }) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      const target = validateRemoteHttpsUrl(url);
      const resolved = await resolvePublicAddress(target.hostname);
      const request = https.request(target, {
        method: 'GET',
        headers,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        // Node 22+ pode pedir todos os endereços para o autoSelectFamily. Nesse
        // modo, a callback precisa receber uma lista; devolver o formato antigo
        // faz o HTTPS tentar usar `undefined` como IP.
        lookup: createPinnedLookup(resolved)
      }, (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > maximumBytes) {
            request.destroy(new Error(`O arquivo remoto excede o limite de ${Math.ceil(maximumBytes / 1024 / 1024)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(resolve, {
          status: Number(response.statusCode || 0),
          headers: response.headers,
          buffer: Buffer.concat(chunks)
        }));
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('O serviço remoto demorou demais para responder.')));
      request.on('error', (error) => finish(reject, error));
      request.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function downloadRemoteBuffer(value, {
  maximumBytes = 12 * 1024 * 1024,
  timeoutMs = 20_000,
  maximumRedirects = 3,
  acceptedContentTypes = ['image/'],
  headers = {}
} = {}) {
  let current = validateRemoteHttpsUrl(value);
  const visited = new Set();
  for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
    if (visited.has(current.toString())) throw new Error('O endereço remoto entrou em um ciclo de redirecionamento.');
    visited.add(current.toString());
    const result = await requestBuffer(current, { maximumBytes, timeoutMs, headers });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = String(result.headers.location || '').trim();
      if (!location || redirectCount >= maximumRedirects) throw new Error('O endereço remoto redirecionou vezes demais.');
      current = validateRemoteHttpsUrl(new URL(location, current));
      continue;
    }
    if (result.status < 200 || result.status >= 300) throw new Error(`O serviço remoto respondeu ${result.status}.`);
    const declaredSize = Number(result.headers['content-length'] || 0);
    if (declaredSize > maximumBytes || result.buffer.length > maximumBytes) {
      throw new Error(`O arquivo remoto excede o limite de ${Math.ceil(maximumBytes / 1024 / 1024)} MB.`);
    }
    const contentType = String(result.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && !acceptedContentTypes.some((prefix) => contentType.startsWith(prefix))) {
      throw new Error('O endereço remoto não retornou o tipo de arquivo esperado.');
    }
    return { buffer: result.buffer, contentType, finalUrl: current };
  }
  throw new Error('O endereço remoto não pôde ser carregado.');
}
