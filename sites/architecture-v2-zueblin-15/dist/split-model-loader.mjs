/** Ordered, abortable model transport. No model bytes are retained in a global cache. */
const manifestURL = new URL('./model-parts.json', import.meta.url);
let manifestPromise;
async function manifest() {
  if (!manifestPromise) manifestPromise = fetch(manifestURL).then(async r => {
    if (!r.ok) throw new Error(`模型分段清單下載失敗（${r.status}）`);
    return r.json();
  }).catch(e => { manifestPromise = null; throw e; });
  return manifestPromise;
}
export async function assembleParts(entry, baseURL, {signal, onProgress, fetchImpl = fetch} = {}) {
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || !entry.parts?.length)
    throw new Error('模型分段清單格式錯誤');
  const result = new Uint8Array(entry.size);
  let offset = 0;
  for (const part of entry.parts) {
    signal?.throwIfAborted();
    const response = await fetchImpl(new URL(part, baseURL), {signal});
    if (!response.ok) throw new Error(`模型分段下載失敗（${response.status}）`);
    const append = bytes => {
      if (offset + bytes.byteLength > result.length) throw new Error('模型分段大小超過清單記錄');
      result.set(bytes, offset); offset += bytes.byteLength;
      onProgress?.(Math.min(84, offset / entry.size * 84), offset);
    };
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          signal?.throwIfAborted();
          const {done, value} = await reader.read();
          if (done) break;
          append(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    } else append(new Uint8Array(await response.arrayBuffer()));
  }
  if (offset !== entry.size) throw new Error('模型分段不完整，請重試');
  signal?.throwIfAborted();
  if (!globalThis.crypto?.subtle) throw new Error('模型驗證需要 HTTPS 或 localhost 安全連線');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== entry.sha256) throw new Error('模型完整性驗證失敗，請重試');
  signal?.throwIfAborted();
  return result.buffer;
}
export async function fetchModelBuffer(modelURL, {signal, onProgress} = {}) {
  const absolute = new URL(modelURL, globalThis.location?.href || manifestURL);
  const entries = await manifest();
  signal?.throwIfAborted();
  const entry = entries.find(x => new URL(x.path, manifestURL).href === absolute.href);
  if (entry) return assembleParts(entry, manifestURL, {signal, onProgress});
  const response = await fetch(absolute, {signal});
  if (!response.ok) throw new Error(`模型下載失敗（${response.status}）`);
  const total = +(response.headers.get('content-length') || 0);
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader(), chunks = []; let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read(); if (done) break;
      chunks.push(value); received += value.length;
      onProgress?.(total ? Math.min(84, received / total * 84) : null, received);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const arr = new Uint8Array(received); let offset = 0;
  for (const chunk of chunks) { arr.set(chunk, offset); offset += chunk.length; }
  return arr.buffer;
}

/** Adapter preserving the viewer's existing loading-progress callback. */
export async function loadSplitGLTF(loader,url,onProgress) {
  const buffer=await fetchModelBuffer(url,{onProgress:(_percent,loaded)=>onProgress?.({loaded,total:0})});
  return loader.parseAsync(buffer,new URL('.',new URL(url,location.href)).href);
}
