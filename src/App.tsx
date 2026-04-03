import { useState } from 'react';
import Map from './components/Map';
import FloodSlider from './components/FloodSlider';

export default function App() {
  const [floodLevel, setFloodLevel] = useState(0);

  return (
    <div className="w-screen h-screen relative">
      <Map floodLevel={floodLevel} />
      <FloodSlider value={floodLevel} onChange={setFloodLevel} />
    </div>
  );
}
