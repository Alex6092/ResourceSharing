import { createSHA256 } from 'hash-wasm';

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data, hash = await createSHA256();
    hash.init();
    for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
      hash.update(new Uint8Array(await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (offset + 8 * 1024 * 1024) / file.size) });
    }
    self.postMessage({ sha256: hash.digest('hex') });
  } catch { self.postMessage({ error: 'Impossible de calculer l’empreinte du fichier.' }); }
};
