import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useFloodLayer } from '../hooks/useFloodLayer';

interface MapProps {
  floodLevel: number;
}

export default function Map({ floodLevel }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

    const m = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/outdoors-v12',
      center: [0, 20],
      zoom: 2,
      projection: 'mercator',
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    });

    m.on('load', () => {
      setMap(m);
    });

    return () => {
      m.remove();
    };
  }, []);

  useFloodLayer(map, floodLevel);

  return <div ref={containerRef} className="w-full h-full" />;
}
