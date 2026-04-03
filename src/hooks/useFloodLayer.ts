import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, CustomLayerInterface } from 'mapbox-gl';
import { decodeElevation } from '../utils/terrainRgb';
import { fetchTile, getCachedTile, clearCache } from '../utils/tileCache';

const VERT = `
  attribute vec2 a_pos;
  attribute vec2 a_texCoord;
  uniform mat4 u_matrix;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;

const FRAG = `
  precision mediump float;
  uniform sampler2D u_texture;
  varying vec2 v_texCoord;
  void main() {
    vec4 c = texture2D(u_texture, v_texCoord);
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`;

function createShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, createShader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, createShader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  return p;
}

/** Build RGBA flood overlay from terrain ImageData at the given flood level. */
function buildFloodTexture(imgData: ImageData, level: number): Uint8Array {
  const { width, height, data } = imgData;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const elev = decodeElevation(data[i], data[i + 1], data[i + 2]);
    if (elev < level) {
      out[i] = 0;
      out[i + 1] = 80;
      out[i + 2] = 200;
      out[i + 3] = 255;
    }
  }
  return out;
}

export function useFloodLayer(
  map: MapboxMap | null,
  floodLevel: number,
) {
  const floodLevelRef = useRef(floodLevel);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    floodLevelRef.current = floodLevel;
    if (map) map.triggerRepaint();
  }, [floodLevel, map]);

  useEffect(() => {
    if (!map) return;

    const abort = new AbortController();
    abortRef.current = abort;
    const token = import.meta.env.VITE_MAPBOX_TOKEN as string;

    let program: WebGLProgram | null = null;
    let aPos: number;
    let aTexCoord: number;
    let uMatrix: WebGLUniformLocation | null;
    let uTexture: WebGLUniformLocation | null;
    let posBuf: WebGLBuffer | null;
    let texBuf: WebGLBuffer | null;

    // GL texture cache: tileId → { texture, level }
    const texCache = new Map<string, { tex: WebGLTexture; level: number; w: number; h: number }>();

    function getVisibleTiles(): Array<{ z: number; x: number; y: number }> {
      const zoom = Math.floor(map!.getZoom());
      const z = Math.min(Math.max(zoom, 2), 14);
      const bounds = map!.getBounds()!;
      const n = Math.pow(2, z);

      const xMin = Math.max(0, Math.floor(((bounds!.getWest() + 180) / 360) * n));
      const xMax = Math.min(n - 1, Math.floor(((bounds!.getEast() + 180) / 360) * n));

      function lat2tile(lat: number) {
        const rad = (lat * Math.PI) / 180;
        return Math.floor(
          ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
        );
      }

      const yMin = Math.max(0, lat2tile(Math.min(bounds!.getNorth(), 85.05)));
      const yMax = Math.min(n - 1, lat2tile(Math.max(bounds!.getSouth(), -85.05)));

      const tiles: Array<{ z: number; x: number; y: number }> = [];
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          tiles.push({ z, x, y });
        }
      }
      return tiles;
    }

    /** Tile bounds in MercatorCoordinate space [0, 1]. */
    function tileMercBounds(z: number, x: number, y: number) {
      const n = Math.pow(2, z);
      return {
        x0: x / n,
        x1: (x + 1) / n,
        y0: y / n,
        y1: (y + 1) / n,
      };
    }

    function tileUrl(z: number, x: number, y: number): string {
      return `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${token}`;
    }

    function tileId(z: number, x: number, y: number): string {
      return `${z}/${x}/${y}`;
    }

    const floodLayer: CustomLayerInterface = {
      id: 'flood-overlay',
      type: 'custom',
      renderingMode: '2d',

      onAdd(_map: MapboxMap, gl: WebGLRenderingContext) {
        program = createProgram(gl);
        aPos = gl.getAttribLocation(program, 'a_pos');
        aTexCoord = gl.getAttribLocation(program, 'a_texCoord');
        uMatrix = gl.getUniformLocation(program, 'u_matrix');
        uTexture = gl.getUniformLocation(program, 'u_texture');
        posBuf = gl.createBuffer();
        texBuf = gl.createBuffer();

        // Static tex coords for a quad
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          0, 0, 1, 0, 0, 1,
          0, 1, 1, 0, 1, 1,
        ]), gl.STATIC_DRAW);
      },

      render(gl: WebGLRenderingContext, matrix: number[]) {
        const level = floodLevelRef.current;
        if (level <= 0 || !program) return;

        const tiles = getVisibleTiles();

        gl.useProgram(program);
        gl.uniformMatrix4fv(uMatrix, false, matrix);
        gl.uniform1i(uTexture, 0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Tex coords (shared across tiles)
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
        gl.enableVertexAttribArray(aTexCoord);
        gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

        for (const { z, x, y } of tiles) {
          const id = tileId(z, x, y);
          const cached = getCachedTile(id);

          if (!cached) {
            fetchTile(id, tileUrl(z, x, y), abort.signal)
              .then(() => {
                if (!abort.signal.aborted) map!.triggerRepaint();
              })
              .catch(() => { /* aborted or failed */ });
            continue;
          }

          // Get or create GL texture for this tile at current level
          let entry = texCache.get(id);
          if (!entry || entry.level !== level) {
            const rgba = buildFloodTexture(cached, level);
            const tex = entry?.tex ?? gl.createTexture()!;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(
              gl.TEXTURE_2D, 0, gl.RGBA,
              cached.width, cached.height, 0,
              gl.RGBA, gl.UNSIGNED_BYTE, rgba,
            );
            entry = { tex, level, w: cached.width, h: cached.height };
            texCache.set(id, entry);
          }

          // Tile quad in Mercator [0,1] coords
          const b = tileMercBounds(z, x, y);
          gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            b.x0, b.y0, b.x1, b.y0, b.x0, b.y1,
            b.x0, b.y1, b.x1, b.y0, b.x1, b.y1,
          ]), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, entry.tex);

          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      },

      onRemove(_map: MapboxMap, gl: WebGLRenderingContext) {
        if (program) gl.deleteProgram(program);
        if (posBuf) gl.deleteBuffer(posBuf);
        if (texBuf) gl.deleteBuffer(texBuf);
        for (const { tex } of texCache.values()) {
          gl.deleteTexture(tex);
        }
        texCache.clear();
      },
    };

    function addLayer() {
      if (map!.getLayer('flood-overlay')) return;

      const layers = map!.getStyle().layers;
      let beforeId: string | undefined;
      if (layers) {
        for (const l of layers) {
          if (l.id.includes('road') && l.id.includes('label')) {
            beforeId = l.id;
            break;
          }
        }
      }

      map!.addLayer(floodLayer, beforeId);
    }

    if (map.isStyleLoaded()) {
      addLayer();
    } else {
      map.on('style.load', addLayer);
    }

    return () => {
      abort.abort();
      if (map!.getLayer('flood-overlay')) {
        map!.removeLayer('flood-overlay');
      }
      clearCache();
    };
  }, [map]);
}
