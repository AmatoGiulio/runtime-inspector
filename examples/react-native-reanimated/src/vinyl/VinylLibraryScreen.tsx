import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type LayoutRectangle,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue
} from "react-native-reanimated";
import Svg, { Path, SvgXml } from "react-native-svg";
import { DiscSheen, GenericVinyl, PlainSleeve } from "./art";
import { LOGO_XML } from "./logo";
import { RECORDS, type VinylRecord } from "./records";

const BACKGROUND = "#1f1f1f";
const SIDE_PADDING = 20;
const GUTTER = 18;
const TILE_RADIUS = 6;
/** The open record sits left of centre, so the record can slide out to the right. */
const HERO_LEFT = 20;
/** The smallest gap between the slid-out record and the screen's right edge. */
const HERO_EDGE = 12;
/** The record is a little smaller than its sleeve, so it hides fully inside. */
const DISC_RATIO = 0.96;
/** How much of the record shows beside its sleeve once it has slid out (× record diameter). */
const DISC_REVEAL = 0.4;
/** The sleeve gives way to the left by this much (pt) as the record slides out. */
const SLEEVE_NUDGE = 8;
/** Two full turns, so the label comes to rest upright and the return to the grid is seamless. */
const DISC_TURNS = 720;
/** Height of the fade from the dimmed grid into the solid floor under the tracklist. */
const INFO_FADE = 36;

/** Strong ease-out: instant response, soft landing. */
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** A turntable spinning up and settling. */
const EASE_SPIN = Easing.bezier(0.33, 0, 0.2, 1);

const ROWS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7]
];

function usePairStyle(opacity: SharedValue<number>, offsetY: SharedValue<number>) {
  return useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: offsetY.value }]
  }));
}

/** One 0→1 progress drives both the fade and a short rise. */
function useRiseStyle(progress: SharedValue<number>, distance: number) {
  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * distance }]
  }));
}

interface RestRect {
  x: number;
  y: number;
  size: number;
  /** Scroll offset when the rect was taken, so it can be corrected for later scrolling. */
  scroll: number;
}

export function VinylLibraryScreen() {
  const { width } = useWindowDimensions();
  const [topInset, setTopInset] = useState(Platform.OS === "ios" ? 59 : StatusBar.currentHeight ?? 24);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);

  const tileSize = (width - SIDE_PADDING * 2 - GUTTER) / 2;
  // Sized so the slid-out record ends HERO_EDGE from the screen's right edge (on a 393 pt
  // iPhone: a 270 pt sleeve, the record's right edge at 381 pt).
  const heroSize = Math.min(
    width - HERO_LEFT * 2,
    (width - HERO_EDGE - HERO_LEFT + SLEEVE_NUDGE) /
      ((1 - DISC_RATIO) / 2 + DISC_RATIO * (1 + DISC_REVEAL))
  );
  const discSize = heroSize * DISC_RATIO;
  /** How far the record travels right; with the sleeve's nudge left, DISC_REVEAL of it shows. */
  const discTravel = DISC_REVEAL * discSize - SLEEVE_NUDGE;
  const heroTop = topInset + 52;
  const heroRadius = (TILE_RADIUS * heroSize) / tileSize;
  const record = RECORDS[selected];
  const isDisc = record.tile === "disc";
  /** The element that flies from the grid: the sleeve, or the bare disc. */
  const liftedSize = isDisc ? discSize : heroSize;
  const heroCenterX = HERO_LEFT + heroSize / 2;
  const heroCenterY = heroTop + heroSize / 2;
  const infoTop = heroTop + heroSize + 28;

  // Library entrance.
  const headerOpacity = useSharedValue(0);
  const headerY = useSharedValue(-8);
  const row1Opacity = useSharedValue(0);
  const row1Y = useSharedValue(18);
  const row2Opacity = useSharedValue(0);
  const row2Y = useSharedValue(18);
  const row3Opacity = useSharedValue(0);
  const row3Y = useSharedValue(18);
  const row4Opacity = useSharedValue(0);
  const row4Y = useSharedValue(18);

  // Open / close record. Each is a 0→1 progress.
  const backdropFade = useSharedValue(0);
  const coverLift = useSharedValue(0);
  const discSlide = useSharedValue(0);
  const discSpin = useSharedValue(0);
  const titleReveal = useSharedValue(0);
  const metaReveal = useSharedValue(0);
  const tracksRow1 = useSharedValue(0);
  const tracksRow2 = useSharedValue(0);
  const tracksRow3 = useSharedValue(0);
  const tracksRow4 = useSharedValue(0);

  // Where the lifted cover starts from, in window coordinates (plain assignments only).
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const originSize = useSharedValue(0);
  const activeIndex = useSharedValue(-1);

  const recordIndex = useRef(0);
  const pendingOpen = useRef(false);
  const pressedOnce = useRef(false);
  const scrollY = useRef(0);
  const restRect = useRef<RestRect>({ x: SIDE_PADDING, y: 0, size: 0, scroll: 0 });
  const firstRowY = useRef<number | undefined>(undefined);
  const firstTileLayout = useRef<LayoutRectangle | undefined>(undefined);
  const tileNodes = useRef<(View | null)[]>([]);

  // @scene "Library" group="Vinyl"
  function revealLibrary() {
    headerOpacity.value = 0;
    headerY.value = -8;
    row1Opacity.value = 0;
    row1Y.value = 18;
    row2Opacity.value = 0;
    row2Y.value = 18;
    row3Opacity.value = 0;
    row3Y.value = 18;
    row4Opacity.value = 0;
    row4Y.value = 18;

    headerOpacity.value = withTiming(1, { duration: 320, easing: EASE_OUT });
    headerY.value = withTiming(0, { duration: 420, easing: EASE_OUT });
    row1Opacity.value = withDelay(120, withTiming(1, { duration: 300, easing: EASE_OUT }));
    row1Y.value = withDelay(120, withTiming(0, { duration: 420, easing: EASE_OUT }));
    row2Opacity.value = withDelay(180, withTiming(1, { duration: 300, easing: EASE_OUT }));
    row2Y.value = withDelay(180, withTiming(0, { duration: 420, easing: EASE_OUT }));
    row3Opacity.value = withDelay(240, withTiming(1, { duration: 300, easing: EASE_OUT }));
    row3Y.value = withDelay(240, withTiming(0, { duration: 420, easing: EASE_OUT }));
    row4Opacity.value = withDelay(300, withTiming(1, { duration: 300, easing: EASE_OUT }));
    row4Y.value = withDelay(300, withTiming(0, { duration: 420, easing: EASE_OUT }));
  }

  /** Points the hero at the selected tile's last known rect, corrected for scrolling since. */
  function syncOrigin() {
    const rect = restRect.current;
    originX.value = rect.x;
    originY.value = rect.y + rect.scroll - scrollY.current;
    originSize.value = rect.size > 0 ? rect.size : tileSize;
    activeIndex.value = recordIndex.current;
  }

  // @scene "Open record" group="Vinyl"
  function openRecord() {
    syncOrigin();
    setOpen(true);

    backdropFade.value = 0;
    coverLift.value = 0;
    discSlide.value = 0;
    discSpin.value = 0;
    titleReveal.value = 0;
    metaReveal.value = 0;
    tracksRow1.value = 0;
    tracksRow2.value = 0;
    tracksRow3.value = 0;
    tracksRow4.value = 0;

    backdropFade.value = withTiming(1, { duration: 280, easing: EASE_OUT });
    coverLift.value = withSpring(1, {
      damping: 20,
      stiffness: 170,
      mass: 1,
      restDisplacementThreshold: 0.0005,
      restSpeedThreshold: 0.005
    });
    discSlide.value = withDelay(160, withSpring(1, { damping: 16, stiffness: 180, mass: 1 }));
    discSpin.value = withDelay(260, withTiming(1, { duration: 1800, easing: EASE_SPIN }));
    titleReveal.value = withDelay(220, withTiming(1, { duration: 320, easing: EASE_OUT }));
    metaReveal.value = withDelay(260, withTiming(1, { duration: 320, easing: EASE_OUT }));
    tracksRow1.value = withDelay(300, withTiming(1, { duration: 320, easing: EASE_OUT }));
    tracksRow2.value = withDelay(340, withTiming(1, { duration: 320, easing: EASE_OUT }));
    tracksRow3.value = withDelay(380, withTiming(1, { duration: 320, easing: EASE_OUT }));
    tracksRow4.value = withDelay(420, withTiming(1, { duration: 320, easing: EASE_OUT }));
  }

  // @scene "Close record" group="Vinyl"
  function closeRecord() {
    syncOrigin();
    setOpen(false);

    backdropFade.value = 1;
    coverLift.value = 1;
    discSlide.value = 1;
    discSpin.value = 1;
    titleReveal.value = 1;
    metaReveal.value = 1;
    tracksRow1.value = 1;
    tracksRow2.value = 1;
    tracksRow3.value = 1;
    tracksRow4.value = 1;

    titleReveal.value = withTiming(0, { duration: 160, easing: EASE_OUT });
    metaReveal.value = withTiming(0, { duration: 160, easing: EASE_OUT });
    tracksRow1.value = withTiming(0, { duration: 160, easing: EASE_OUT });
    tracksRow2.value = withTiming(0, { duration: 160, easing: EASE_OUT });
    tracksRow3.value = withTiming(0, { duration: 160, easing: EASE_OUT });
    tracksRow4.value = withTiming(0, { duration: 160, easing: EASE_OUT });
    discSlide.value = withSpring(0, { damping: 26, stiffness: 300, mass: 1 });
    coverLift.value = withDelay(
      140,
      withSpring(0, {
        damping: 26,
        stiffness: 180,
        mass: 1,
        restDisplacementThreshold: 0.0005,
        restSpeedThreshold: 0.005
      })
    );
    backdropFade.value = withDelay(120, withTiming(0, { duration: 300, easing: EASE_OUT }));
  }

  useEffect(() => {
    revealLibrary();
    // Runs once on mount; the motion only touches stable shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press on a different record re-renders the hero first, then opens it.
  useLayoutEffect(() => {
    if (!pendingOpen.current) return;
    pendingOpen.current = false;
    openRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function handleTilePress(index: number) {
    const node = tileNodes.current[index];
    if (!node) return;
    node.measureInWindow((x, y, measuredWidth) => {
      pressedOnce.current = true;
      restRect.current = { x, y, size: measuredWidth, scroll: scrollY.current };
      const same = recordIndex.current === index;
      recordIndex.current = index;
      if (same) {
        openRecord();
        return;
      }
      pendingOpen.current = true;
      setSelected(index);
    });
  }

  /** Before any press, a replayed "Open record" lifts record 0 from its laid-out rect. */
  function updateFirstTileRect() {
    const rowY = firstRowY.current;
    const tile = firstTileLayout.current;
    if (pressedOnce.current || rowY === undefined || !tile) return;
    restRect.current = { x: SIDE_PADDING + tile.x, y: rowY + tile.y, size: tile.width, scroll: 0 };
  }

  function handleFirstRowLayout(event: LayoutChangeEvent) {
    firstRowY.current = event.nativeEvent.layout.y;
    updateFirstTileRect();
  }

  function handleFirstTileLayout(event: LayoutChangeEvent) {
    firstTileLayout.current = event.nativeEvent.layout;
    updateFirstTileRect();
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    scrollY.current = event.nativeEvent.contentOffset.y;
  }

  const headerStyle = usePairStyle(headerOpacity, headerY);
  const row1Style = usePairStyle(row1Opacity, row1Y);
  const row2Style = usePairStyle(row2Opacity, row2Y);
  const row3Style = usePairStyle(row3Opacity, row3Y);
  const row4Style = usePairStyle(row4Opacity, row4Y);
  const rowStyles = [row1Style, row2Style, row3Style, row4Style];

  const gridStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.06 * backdropFade.value }]
  }));

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropFade.value }));

  const heroStyle = useAnimatedStyle(() => {
    const t = coverLift.value;
    const visible = t > 0.0001 || backdropFade.value > 0.0001;
    const startScale = originSize.value / liftedSize;
    const startDX = originX.value + originSize.value / 2 - heroCenterX;
    const startDY = originY.value + originSize.value / 2 - heroCenterY;
    return {
      opacity: visible ? 1 : 0,
      transform: [
        { translateX: startDX * (1 - t) },
        { translateY: startDY * (1 - t) },
        { scale: startScale + (1 - startScale) * t }
      ]
    };
  });

  const sleeveStyle = useAnimatedStyle(() => ({
    opacity: isDisc ? interpolate(discSlide.value, [0, 0.45], [0, 1], Extrapolation.CLAMP) : 1,
    transform: [{ translateX: -SLEEVE_NUDGE * discSlide.value }]
  }));

  const discSlideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: discTravel * discSlide.value }]
  }));

  const discSpinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${discSpin.value * DISC_TURNS}deg` }]
  }));

  const titleStyle = useRiseStyle(titleReveal, 10);
  const metaStyle = useRiseStyle(metaReveal, 10);
  const track1Style = useRiseStyle(tracksRow1, 8);
  const track2Style = useRiseStyle(tracksRow2, 8);
  const track3Style = useRiseStyle(tracksRow3, 8);
  const track4Style = useRiseStyle(tracksRow4, 8);
  const trackStyles = [track1Style, track2Style, track3Style, track4Style];

  const sleeveLayer = (
    <Animated.View
      key="sleeve"
      style={[
        styles.heroSleeve,
        {
          backgroundColor: isDisc ? record.labelColor : record.baseColor,
          borderRadius: heroRadius,
          height: heroSize,
          width: heroSize
        },
        sleeveStyle
      ]}
    >
      <View style={[styles.clip, { borderRadius: heroRadius }]}>
        {isDisc ? (
          <PlainSleeve
            artist={record.artist}
            color={record.labelColor}
            size={heroSize}
            title={record.title}
          />
        ) : (
          <record.art size={heroSize} />
        )}
      </View>
      <View pointerEvents="none" style={[styles.outline, { borderRadius: heroRadius }]} />
    </Animated.View>
  );

  const discLayer = (
    <Animated.View
      key="disc"
      style={[
        styles.heroDisc,
        {
          backgroundColor: isDisc ? record.baseColor : "#0c0c0d",
          borderRadius: discSize / 2,
          height: discSize,
          left: (heroSize - discSize) / 2,
          top: (heroSize - discSize) / 2,
          width: discSize
        },
        discSlideStyle
      ]}
    >
      <Animated.View style={discSpinStyle}>
        {isDisc ? (
          <record.art size={discSize} />
        ) : (
          <GenericVinyl labelColor={record.labelColor} size={discSize} />
        )}
      </Animated.View>
      <DiscSheen size={discSize} />
    </Animated.View>
  );

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View
          onLayout={(event) => {
            const inset = event.nativeEvent.layout.y;
            if (Platform.OS === "ios" && inset > 0 && inset !== topInset) setTopInset(inset);
          }}
        />
      </SafeAreaView>

      <Animated.View style={[styles.fill, gridStyle]}>
        <ScrollView
          contentContainerStyle={[styles.grid, { paddingTop: topInset + 64 }]}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        >
          {ROWS.map((pair, rowIndex) => (
            <Animated.View
              key={rowIndex}
              onLayout={rowIndex === 0 ? handleFirstRowLayout : undefined}
              style={[styles.row, rowStyles[rowIndex]]}
            >
              {pair.map((index) => (
                <RecordTile
                  activeIndex={activeIndex}
                  backdropFade={backdropFade}
                  index={index}
                  key={RECORDS[index].id}
                  coverLift={coverLift}
                  onLayout={index === 0 ? handleFirstTileLayout : undefined}
                  onPress={handleTilePress}
                  record={RECORDS[index]}
                  registerNode={(node) => {
                    tileNodes.current[index] = node;
                  }}
                  size={tileSize}
                />
              ))}
            </Animated.View>
          ))}
        </ScrollView>

        <Animated.View pointerEvents="none" style={[styles.header, headerStyle]}>
          <BlurView intensity={24} style={[styles.headerBlur, { height: topInset + 40 }]} tint="dark" />
          <LinearGradient
            colors={["rgba(31,31,31,0.94)", "rgba(31,31,31,0.78)", "rgba(31,31,31,0)"]}
            locations={[0, 0.55, 1]}
            style={{ height: topInset + 76 }}
          />
          <View style={[styles.logo, { top: topInset + 6 }]}>
            <SvgXml height={36} width={22} xml={LOGO_XML} />
          </View>
        </Animated.View>
      </Animated.View>

      <Animated.View
        pointerEvents={open ? "auto" : "none"}
        style={[StyleSheet.absoluteFill, backdropStyle]}
      >
        <BlurView intensity={30} style={StyleSheet.absoluteFill} tint="dark" />
        <View style={styles.dim} />
        {/* A solid floor under the title and tracklist, so the grid never shows through them. */}
        <LinearGradient
          colors={["rgba(10,10,10,0)", "rgba(10,10,10,1)"]}
          style={[styles.infoFade, { top: infoTop - 12 - INFO_FADE }]}
        />
        <View style={[styles.infoFloor, { top: infoTop - 12 }]} />
        <Pressable
          accessibilityLabel="Close record"
          accessibilityRole="button"
          onPress={closeRecord}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[
          styles.hero,
          { height: heroSize, left: HERO_LEFT, top: heroTop, width: heroSize },
          heroStyle
        ]}
      >
        {isDisc ? [sleeveLayer, discLayer] : [discLayer, sleeveLayer]}
      </Animated.View>

      <View pointerEvents="none" style={[styles.info, { top: infoTop }]}>
        <Animated.Text numberOfLines={1} style={[styles.heroTitle, titleStyle]}>
          {record.title}
        </Animated.Text>
        <Animated.Text numberOfLines={1} style={[styles.heroMeta, metaStyle]}>
          {record.artist} · <Text style={styles.tabular}>{record.year}</Text>
        </Animated.Text>
        <View style={styles.tracks}>
          {record.tracks.map((track, index) => (
            <Animated.View
              key={track}
              style={[styles.trackRow, index > 0 && styles.trackDivider, trackStyles[index]]}
            >
              <Text style={[styles.trackNumber, styles.tabular]}>{index + 1}</Text>
              <Text numberOfLines={1} style={styles.trackTitle}>
                {track}
              </Text>
            </Animated.View>
          ))}
        </View>
      </View>

      <Animated.View
        pointerEvents={open ? "box-none" : "none"}
        style={[styles.closeWrap, { top: topInset + 2 }, backdropStyle]}
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={closeRecord}
          style={({ pressed }) => [styles.closeButton, pressed && styles.closePressed]}
        >
          <View style={styles.closeCircle}>
            <Svg height={12} viewBox="0 0 12 12" width={12}>
              <Path
                d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5"
                stroke="#ffffff"
                strokeLinecap="round"
                strokeWidth={1.8}
              />
            </Svg>
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

interface RecordTileProps {
  record: VinylRecord;
  index: number;
  size: number;
  activeIndex: SharedValue<number>;
  coverLift: SharedValue<number>;
  backdropFade: SharedValue<number>;
  onPress(index: number): void;
  onLayout?: (event: LayoutChangeEvent) => void;
  registerNode(node: View | null): void;
}

function RecordTile({
  record,
  index,
  size,
  activeIndex,
  coverLift,
  backdropFade,
  onPress,
  onLayout,
  registerNode
}: RecordTileProps) {
  const pressed = useSharedValue(0);
  const isDisc = record.tile === "disc";
  const radius = isDisc ? size / 2 : TILE_RADIUS;

  // Press feedback lives in the style worklet: tactile, but not a scene.
  const pressStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: withTiming(pressed.value === 1 ? 0.97 : 1, { duration: 140, easing: EASE_OUT }) }
    ]
  }));

  // While its record is lifted, the tile hands its place over to the hero.
  const handoffStyle = useAnimatedStyle(() => ({
    opacity:
      activeIndex.value === index && (coverLift.value > 0.0001 || backdropFade.value > 0.0001) ? 0 : 1
  }));

  return (
    <Pressable
      accessibilityLabel={`${record.title} by ${record.artist}`}
      accessibilityRole="button"
      onPress={() => onPress(index)}
      onPressIn={() => {
        pressed.value = 1;
      }}
      onPressOut={() => {
        pressed.value = 0;
      }}
      style={{ width: size }}
    >
      <View collapsable={false} onLayout={onLayout} ref={registerNode} style={{ height: size, width: size }}>
        <Animated.View style={[pressStyle, handoffStyle]}>
          <View
            style={[
              isDisc ? styles.discShadow : styles.sleeveShadow,
              { backgroundColor: record.baseColor, borderRadius: radius, height: size, width: size }
            ]}
          >
            <View style={[styles.clip, { borderRadius: radius }]}>
              <record.art size={size} />
              {isDisc ? <DiscSheen size={size} /> : null}
            </View>
            <View pointerEvents="none" style={[styles.outline, { borderRadius: radius }]} />
          </View>
        </Animated.View>
      </View>
      <Text numberOfLines={1} style={styles.tileTitle}>
        {record.title}
      </Text>
      <Text numberOfLines={1} style={styles.tileArtist}>
        {record.artist}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: BACKGROUND,
    flex: 1
  },
  fill: {
    flex: 1
  },
  grid: {
    paddingBottom: 48,
    paddingHorizontal: SIDE_PADDING
  },
  row: {
    flexDirection: "row",
    gap: GUTTER,
    marginBottom: 26
  },
  header: {
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  headerBlur: {
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  logo: {
    alignSelf: "center",
    position: "absolute"
  },
  clip: {
    overflow: "hidden"
  },
  outline: {
    ...StyleSheet.absoluteFillObject,
    borderColor: "rgba(255,255,255,0.1)",
    borderWidth: StyleSheet.hairlineWidth
  },
  sleeveShadow: {
    shadowColor: "#000000",
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 12
  },
  discShadow: {
    shadowColor: "#000000",
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 10
  },
  tileTitle: {
    color: "#f5f5f7",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: -0.08,
    marginTop: 9
  },
  tileArtist: {
    color: "rgba(235,235,245,0.55)",
    fontSize: 13,
    letterSpacing: -0.08,
    marginTop: 1
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,10,10,0.88)"
  },
  infoFade: {
    height: INFO_FADE,
    left: 0,
    position: "absolute",
    right: 0
  },
  infoFloor: {
    backgroundColor: "rgb(10,10,10)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0
  },
  hero: {
    position: "absolute"
  },
  heroSleeve: {
    left: 0,
    position: "absolute",
    shadowColor: "#000000",
    shadowOffset: { height: 18, width: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 26,
    top: 0
  },
  heroDisc: {
    position: "absolute",
    shadowColor: "#000000",
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 18
  },
  info: {
    left: HERO_LEFT,
    position: "absolute",
    right: HERO_LEFT
  },
  heroTitle: {
    color: "#ffffff",
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.4
  },
  heroMeta: {
    color: "rgba(235,235,245,0.6)",
    fontSize: 15,
    fontWeight: "500",
    marginTop: 3
  },
  tabular: {
    fontVariant: ["tabular-nums"]
  },
  tracks: {
    marginTop: 18
  },
  trackRow: {
    alignItems: "center",
    flexDirection: "row",
    height: 48
  },
  trackDivider: {
    borderTopColor: "rgba(255,255,255,0.08)",
    borderTopWidth: StyleSheet.hairlineWidth
  },
  trackNumber: {
    color: "rgba(235,235,245,0.45)",
    fontSize: 15,
    width: 26
  },
  trackTitle: {
    color: "#f5f5f7",
    flex: 1,
    fontSize: 16
  },
  closeWrap: {
    position: "absolute",
    right: 10
  },
  closeButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44
  },
  closePressed: {
    transform: [{ scale: 0.96 }]
  },
  closeCircle: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30
  }
});
