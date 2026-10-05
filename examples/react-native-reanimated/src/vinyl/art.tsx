/**
 * Original procedural record artwork. Every piece draws in a 100×100 viewBox so the
 * same component renders identically as a grid tile and as the enlarged hero.
 */
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText
} from "react-native-svg";

export interface ArtProps {
  size: number;
}

/** The colour the spindle hole shows through to. */
const HOLE = "#141414";

/** Deterministic pseudo-random sequence, so the art never changes between renders. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const GROOVE_RADII: number[] = [];
for (let radius = 19; radius <= 48.5; radius += 1.45) {
  GROOVE_RADII.push(radius);
}

/** Thin concentric grooves, plus slightly stronger gaps between tracks and a rim. */
function Grooves({ tone }: { tone: "light" | "dark" }) {
  const groove = tone === "light" ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.07)";
  const gap = tone === "light" ? "rgba(255,255,255,0.11)" : "rgba(0,0,0,0.12)";
  return (
    <G fill="none">
      {GROOVE_RADII.map((radius) => (
        <Circle key={radius} cx={50} cy={50} r={radius} stroke={groove} strokeWidth={0.28} />
      ))}
      <Circle cx={50} cy={50} r={27.5} stroke={gap} strokeWidth={0.7} />
      <Circle cx={50} cy={50} r={35.2} stroke={gap} strokeWidth={0.7} />
      <Circle cx={50} cy={50} r={42.4} stroke={gap} strokeWidth={0.7} />
      <Circle cx={50} cy={50} r={49.5} stroke={gap} strokeWidth={0.9} />
    </G>
  );
}

/**
 * A static light reflection. It sits outside the spinning layer: light on a turning
 * record stays put while the grooves move underneath it.
 */
export function DiscSheen({ size }: ArtProps) {
  return (
    <Svg
      height={size}
      pointerEvents="none"
      style={{ left: 0, position: "absolute", top: 0 }}
      viewBox="0 0 100 100"
      width={size}
    >
      <Defs>
        <LinearGradient id="sheen" x1="0" x2="1" y1="0" y2="1">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
          <Stop offset="0.38" stopColor="#ffffff" stopOpacity={0} />
          <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.13} />
          <Stop offset="0.62" stopColor="#ffffff" stopOpacity={0} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Circle cx={50} cy={50} fill="url(#sheen)" r={50} />
    </Svg>
  );
}

/** The black record inside every sleeve, with a label in the record's colour. */
export function GenericVinyl({ size, labelColor }: ArtProps & { labelColor: string }) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Circle cx={50} cy={50} fill="#0c0c0d" r={50} />
      <Grooves tone="light" />
      <Circle cx={50} cy={50} fill={labelColor} r={16.5} />
      {/* Darker lower half and printed lines make the spin readable. */}
      <Path d="M33.5 50 A16.5 16.5 0 0 0 66.5 50 Z" fill="rgba(0,0,0,0.16)" />
      <Rect fill="#ffffff" height={1.4} opacity={0.85} rx={0.7} width={12} x={44} y={39} />
      <Rect fill="#ffffff" height={1} opacity={0.55} rx={0.5} width={7} x={46.5} y={42.4} />
      <Circle cx={50} cy={50} fill="none" r={15.2} stroke="rgba(255,255,255,0.25)" strokeWidth={0.35} />
      <Circle cx={50} cy={50} fill={HOLE} r={1.5} />
    </Svg>
  );
}

function isLight(hex: string): boolean {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

/** A plain printed sleeve that slides out from behind the records sold as bare discs. */
export function PlainSleeve({
  size,
  color,
  title,
  artist
}: ArtProps & { color: string; title: string; artist: string }) {
  const ink = isLight(color) ? "#161616" : "#f5f2ec";
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Defs>
        <LinearGradient id="plain" x1="0" x2="0.4" y1="0" y2="1">
          <Stop offset="0" stopColor={color} />
          <Stop offset="1" stopColor={color} stopOpacity={0.82} />
        </LinearGradient>
      </Defs>
      <Rect fill="#000000" height={100} width={100} />
      <Rect fill="url(#plain)" height={100} width={100} />
      <Circle cx={50} cy={46} fill="none" r={30} stroke={ink} strokeOpacity={0.14} strokeWidth={0.6} />
      <SvgText fill={ink} fontSize={3.4} fontWeight="700" letterSpacing={1.2} x={7} y={86}>
        {title.toUpperCase()}
      </SvgText>
      <SvgText fill={ink} fontSize={3} letterSpacing={1.2} opacity={0.65} x={7} y={91.5}>
        {artist.toUpperCase()}
      </SvgText>
    </Svg>
  );
}

// ---------------------------------------------------------------------------------------
// Sleeves
// ---------------------------------------------------------------------------------------

/** Marbled pink and cyan blobs on lilac, two drawn currents across. */
export function MarbleArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Defs>
        <RadialGradient cx="50%" cy="50%" id="pink" r="50%">
          <Stop offset="0" stopColor="#ff4f9a" stopOpacity={1} />
          <Stop offset="0.55" stopColor="#ff6fb0" stopOpacity={0.75} />
          <Stop offset="1" stopColor="#ff8fc4" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient cx="50%" cy="50%" id="cyan" r="50%">
          <Stop offset="0" stopColor="#22d8e0" stopOpacity={1} />
          <Stop offset="0.6" stopColor="#5fe6ea" stopOpacity={0.7} />
          <Stop offset="1" stopColor="#9ff2f2" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient cx="50%" cy="50%" id="violet" r="50%">
          <Stop offset="0" stopColor="#7b5cff" stopOpacity={0.95} />
          <Stop offset="1" stopColor="#7b5cff" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient cx="50%" cy="50%" id="sun" r="50%">
          <Stop offset="0" stopColor="#ffe28a" stopOpacity={1} />
          <Stop offset="1" stopColor="#ffe28a" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect fill="#eadcff" height={100} width={100} />
      <Circle cx={74} cy={68} fill="url(#cyan)" r={48} />
      <Circle cx={26} cy={32} fill="url(#pink)" r={46} />
      <Circle cx={70} cy={14} fill="url(#violet)" r={28} />
      <Circle cx={14} cy={90} fill="url(#sun)" r={26} />
      <Path
        d="M-6 60 C 18 38, 40 82, 60 56 S 94 28, 108 48"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.55}
        strokeWidth={1.3}
      />
      <Path
        d="M-6 69 C 20 49, 42 90, 62 65 S 96 38, 108 58"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.3}
        strokeWidth={0.8}
      />
      <SvgText fill="#2b1840" fontSize={3.6} fontWeight="700" letterSpacing={1} x={6} y={94}>
        LUMEN COAST
      </SvgText>
    </Svg>
  );
}

/** Deep red sleeve: a huge number and small-caps credits. */
export function SevenArt({ size }: ArtProps) {
  const cream = "#f4e6d8";
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Defs>
        <LinearGradient id="red" x1="0" x2="0.3" y1="0" y2="1">
          <Stop offset="0" stopColor="#c8141d" />
          <Stop offset="1" stopColor="#7a0911" />
        </LinearGradient>
      </Defs>
      <Rect fill="url(#red)" height={100} width={100} />
      <SvgText fill={cream} fontSize={3.4} fontWeight="700" letterSpacing={1.2} x={6} y={10}>
        THE MARROW ENSEMBLE
      </SvgText>
      <SvgText fill={cream} fontSize={2.9} letterSpacing={1.2} opacity={0.7} x={6} y={15}>
        STUDIO RECORDINGS · SIDE A/B
      </SvgText>
      <SvgText
        fill={cream}
        fontSize={3.4}
        fontWeight="700"
        letterSpacing={1.2}
        textAnchor="end"
        x={94}
        y={10}
      >
        LP
      </SvgText>
      <Line stroke={cream} strokeOpacity={0.35} strokeWidth={0.4} x1={6} x2={94} y1={19} y2={19} />
      <SvgText fill={cream} fontSize={74} fontWeight="900" letterSpacing={-5} x={1} y={97}>
        07
      </SvgText>
    </Svg>
  );
}

const HALFTONE: { x: number; y: number; r: number }[] = [];
for (let row = 0; row < 11; row += 1) {
  for (let column = 0; column < 11; column += 1) {
    const t = Math.min(1, (row + column) / 19);
    HALFTONE.push({ x: 4.5 + column * 9.1, y: 4.5 + row * 8, r: 0.35 + 3.7 * Math.pow(t, 1.4) });
  }
}

/** Halftone dots on warm yellow, a white sun knocked out and a checker band. */
export function HalftoneArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Rect fill="#f3c74a" height={100} width={100} />
      <G fill="#151515">
        {HALFTONE.map((dot) => (
          <Circle cx={dot.x} cy={dot.y} key={`${dot.x}-${dot.y}`} r={dot.r} />
        ))}
      </G>
      <Circle cx={64} cy={34} fill="#fbf6e9" r={19} />
      <Rect fill="#f3c74a" height={24} width={100} x={0} y={76} />
      <G fill="#151515">
        {Array.from({ length: 20 }, (_, index) => (
          <Rect
            height={7}
            key={index}
            width={5}
            x={(index % 10) * 10 + (index < 10 ? 0 : 5)}
            y={index < 10 ? 86 : 93}
          />
        ))}
      </G>
      <SvgText fill="#151515" fontSize={3.6} fontWeight="800" letterSpacing={1.1} x={6} y={82.5}>
        STATIC BLOOM
      </SvgText>
    </Svg>
  );
}

const MOSAIC_PALETTE = ["#ff6b35", "#f7c59f", "#efa00b", "#d65108", "#591f0a", "#ffd166", "#e85d75"];
const MOSAIC: { x: number; y: number; color: string }[] = [];
{
  const random = seeded(7);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      MOSAIC.push({
        x: column * 12.5,
        y: row * 12.5,
        color: MOSAIC_PALETTE[Math.floor(random() * MOSAIC_PALETTE.length)]
      });
    }
  }
}

/** Pixel mosaic in a warm palette with a white title block. */
export function MosaicArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      {MOSAIC.map((cell) => (
        <Rect
          fill={cell.color}
          height={12.6}
          key={`${cell.x}-${cell.y}`}
          width={12.6}
          x={cell.x}
          y={cell.y}
        />
      ))}
      <Rect fill="#fffaf2" height={12.5} width={37.5} x={12.5} y={62.5} />
      <SvgText fill="#2a0f05" fontSize={3.6} fontWeight="800" letterSpacing={0.9} x={15.5} y={70.4}>
        WARM GRID
      </SvgText>
    </Svg>
  );
}

/** A dark sleeve with a small die-cut-style label in the middle. */
export function AfterhoursArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Defs>
        <LinearGradient id="night" x1="0" x2="0" y1="0" y2="1">
          <Stop offset="0" stopColor="#16161b" />
          <Stop offset="1" stopColor="#26233a" />
        </LinearGradient>
        <RadialGradient cx="50%" cy="40%" id="glow" r="50%">
          <Stop offset="0" stopColor="#9a82ff" />
          <Stop offset="1" stopColor="#6345f0" />
        </RadialGradient>
      </Defs>
      <Rect fill="url(#night)" height={100} width={100} />
      <Circle cx={50} cy={50} fill="none" r={33} stroke="#ffffff" strokeOpacity={0.06} strokeWidth={0.6} />
      <Circle cx={50} cy={50} fill="none" r={25} stroke="#ffffff" strokeOpacity={0.08} strokeWidth={0.6} />
      <Circle cx={50} cy={50} fill="url(#glow)" r={13} />
      <Circle cx={50} cy={50} fill="none" r={11.6} stroke="#ffffff" strokeOpacity={0.35} strokeWidth={0.3} />
      <Circle cx={50} cy={50} fill="#16161b" r={1.4} />
      <SvgText
        fill="#ffffff"
        fillOpacity={0.72}
        fontSize={3.2}
        fontWeight="700"
        letterSpacing={1.6}
        textAnchor="middle"
        x={50}
        y={13}
      >
        QUIET ATLAS
      </SvgText>
      <SvgText
        fill="#ffffff"
        fillOpacity={0.45}
        fontSize={2.8}
        letterSpacing={1.6}
        textAnchor="middle"
        x={50}
        y={91}
      >
        AFTERHOURS
      </SvgText>
    </Svg>
  );
}

// ---------------------------------------------------------------------------------------
// Bare discs
// ---------------------------------------------------------------------------------------

/** Black disc, white centre label with a tiny swimmer mark. */
export function SwimmerDiscArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Circle cx={50} cy={50} fill="#0e0e10" r={50} />
      <Grooves tone="light" />
      <Circle cx={50} cy={50} fill="#f1ede4" r={17} />
      <Circle cx={56.5} cy={42} fill="#0e0e10" r={1.3} />
      <Path
        d="M43 45.5 q3.5 -2.6 7 0 t7 0"
        fill="none"
        stroke="#0e0e10"
        strokeLinecap="round"
        strokeWidth={0.8}
      />
      <SvgText
        fill="#0e0e10"
        fontSize={2.3}
        fontWeight="700"
        letterSpacing={0.7}
        textAnchor="middle"
        x={50}
        y={58.5}
      >
        NIGHT SWIMMER
      </SvgText>
      <Circle cx={50} cy={50} fill={HOLE} r={1.4} />
    </Svg>
  );
}

const ORBIT_ANGLE = (-40 * Math.PI) / 180;

/** White vinyl with bold black concentric rings and one orbiting body. */
export function OrbitDiscArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Circle cx={50} cy={50} fill="#f3f1ec" r={50} />
      <Grooves tone="dark" />
      <G fill="none" stroke="#121212">
        <Circle cx={50} cy={50} r={46} strokeWidth={2.6} />
        <Circle cx={50} cy={50} r={39} strokeWidth={1.7} />
        <Circle cx={50} cy={50} r={32} strokeWidth={1.1} />
        <Circle cx={50} cy={50} r={25.5} strokeWidth={0.6} />
      </G>
      <Circle
        cx={50 + 39 * Math.cos(ORBIT_ANGLE)}
        cy={50 + 39 * Math.sin(ORBIT_ANGLE)}
        fill="#121212"
        r={3.2}
      />
      <Circle cx={50} cy={50} fill="#121212" r={12} />
      <Circle cx={50} cy={50} fill="none" r={10.6} stroke="#f3f1ec" strokeOpacity={0.4} strokeWidth={0.3} />
      <Circle cx={50} cy={50} fill={HOLE} r={1.4} />
    </Svg>
  );
}

const SPECKLES: { x: number; y: number; r: number }[] = [];
{
  const random = seeded(23);
  while (SPECKLES.length < 72) {
    const angle = random() * Math.PI * 2;
    const distance = 9 + random() * 39;
    SPECKLES.push({
      x: 50 + Math.cos(angle) * distance,
      y: 50 + Math.sin(angle) * distance,
      r: 0.35 + random() * 0.95
    });
  }
}

/** Pale grey disc, magenta speckles and big letters. */
export function PollenDiscArt({ size }: ArtProps) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Circle cx={50} cy={50} fill="#dcdcdf" r={50} />
      <Grooves tone="dark" />
      <G fill="#e5177e">
        {SPECKLES.map((speckle, index) => (
          <Circle cx={speckle.x} cy={speckle.y} key={index} r={speckle.r} />
        ))}
      </G>
      <SvgText
        fill="#161616"
        fontSize={25}
        fontWeight="900"
        letterSpacing={-0.8}
        textAnchor="middle"
        x={50}
        y={40}
      >
        POL
      </SvgText>
      <SvgText
        fill="#161616"
        fontSize={25}
        fontWeight="900"
        letterSpacing={-0.8}
        textAnchor="middle"
        x={50}
        y={78}
      >
        LEN
      </SvgText>
      <Circle cx={50} cy={50} fill="#e5177e" r={7} />
      <Circle cx={50} cy={50} fill={HOLE} r={1.4} />
    </Svg>
  );
}
