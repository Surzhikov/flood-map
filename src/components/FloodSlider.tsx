interface FloodSliderProps {
  value: number;
  onChange: (level: number) => void;
}

export default function FloodSlider({ value, onChange }: FloodSliderProps) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-10 w-[90vw] max-w-md px-8 py-5 rounded-2xl bg-black/60 backdrop-blur-md text-white">
      <label className="block text-center text-sm font-medium mb-2">
        🌊 Sea level +{value}m
      </label>
      <input
        type="range"
        min={0}
        max={1500}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-white/30 accent-blue-500 [&::-webkit-slider-thumb]:h-[48px] [&::-webkit-slider-thumb]:w-6"
      />
    </div>
  );
}
