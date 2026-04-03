const cache = new Map<string, ImageData>();
const inflight = new Map<string, Promise<ImageData>>();

export function getCachedTile(tileId: string): ImageData | undefined {
  return cache.get(tileId);
}

export async function fetchTile(
  tileId: string,
  url: string,
  signal: AbortSignal,
): Promise<ImageData> {
  const cached = cache.get(tileId);
  if (cached) return cached;

  const existing = inflight.get(tileId);
  if (existing) return existing;

  const promise = (async () => {
    const res = await fetch(url, { signal });
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    cache.set(tileId, imageData);
    inflight.delete(tileId);
    return imageData;
  })();

  inflight.set(tileId, promise);
  return promise;
}

export function clearCache(): void {
  cache.clear();
  inflight.clear();
}
