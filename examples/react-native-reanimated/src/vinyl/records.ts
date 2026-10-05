import type { ComponentType } from "react";
import {
  AfterhoursArt,
  HalftoneArt,
  MarbleArt,
  MosaicArt,
  OrbitDiscArt,
  PollenDiscArt,
  SevenArt,
  SwimmerDiscArt,
  type ArtProps
} from "./art";

export interface VinylRecord {
  id: string;
  title: string;
  artist: string;
  year: number;
  tracks: [string, string, string, string];
  /** "sleeve" tiles show the square cover; "disc" tiles show the bare record. */
  tile: "disc" | "sleeve";
  art: ComponentType<ArtProps>;
  /** Centre label of the record (and the printed sleeve of bare discs). */
  labelColor: string;
  /** Dominant colour of the artwork, used as the opaque backing that casts the shadow. */
  baseColor: string;
}

/** Fictional catalogue. Grid order alternates discs diagonally across the four rows. */
export const RECORDS: readonly VinylRecord[] = [
  {
    id: "soft-machinery",
    title: "Soft Machinery",
    artist: "Lumen Coast",
    year: 2021,
    tracks: ["Pastel Engine", "Coolant", "Glass Harbour", "Overtone Garden"],
    tile: "sleeve",
    art: MarbleArt,
    labelColor: "#ff5fa2",
    baseColor: "#eadcff"
  },
  {
    id: "night-swimmer",
    title: "Night Swimmer",
    artist: "Odessa Vale",
    year: 2019,
    tracks: ["Lane Four", "Chlorine Moon", "Undertow", "Last Length"],
    tile: "disc",
    art: SwimmerDiscArt,
    labelColor: "#e9e4d8",
    baseColor: "#0e0e10"
  },
  {
    id: "orbitals",
    title: "Orbitals",
    artist: "Halden Ives",
    year: 2023,
    tracks: ["Perihelion", "Slow Moon", "Tidal Lock", "Escape Velocity"],
    tile: "disc",
    art: OrbitDiscArt,
    labelColor: "#141414",
    baseColor: "#f3f1ec"
  },
  {
    id: "seven",
    title: "Seven",
    artist: "The Marrow Ensemble",
    year: 2018,
    tracks: ["Overture in Red", "Seven Doors", "Small Hours", "Coda for Strings"],
    tile: "sleeve",
    art: SevenArt,
    labelColor: "#c8141d",
    baseColor: "#a50f18"
  },
  {
    id: "static-bloom",
    title: "Static Bloom",
    artist: "Kites & Kin",
    year: 2022,
    tracks: ["Dot Matrix", "Sunprint", "Paper Weather", "Bloom Cycle"],
    tile: "sleeve",
    art: HalftoneArt,
    labelColor: "#f3c74a",
    baseColor: "#f3c74a"
  },
  {
    id: "pollen",
    title: "Pollen",
    artist: "Mira Solenne",
    year: 2020,
    tracks: ["Spore", "Magenta Field", "Drift Season", "Hive Mind"],
    tile: "disc",
    art: PollenDiscArt,
    labelColor: "#e5177e",
    baseColor: "#dcdcdf"
  },
  {
    id: "warm-grid",
    title: "Warm Grid",
    artist: "Tessellate",
    year: 2024,
    tracks: ["Terracotta", "Eight by Eight", "Kiln", "Afterglow Tiles"],
    tile: "sleeve",
    art: MosaicArt,
    labelColor: "#ff6b35",
    baseColor: "#d65108"
  },
  {
    id: "afterhours",
    title: "Afterhours",
    artist: "Quiet Atlas",
    year: 2017,
    tracks: ["Neon Margin", "Taxi Rank", "3 A.M. Signal", "Lights Down"],
    tile: "sleeve",
    art: AfterhoursArt,
    labelColor: "#7a5cff",
    baseColor: "#16161b"
  }
];
