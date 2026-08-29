const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function readTextLimited(response, maximumBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const limit = Math.max(1_024, Number(maximumBytes) || DEFAULT_MAX_RESPONSE_BYTES);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('O serviço externo devolveu uma resposta maior que o limite permitido.');
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error('O serviço externo devolveu uma resposta maior que o limite permitido.');
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('O serviço externo devolveu uma resposta maior que o limite permitido.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
