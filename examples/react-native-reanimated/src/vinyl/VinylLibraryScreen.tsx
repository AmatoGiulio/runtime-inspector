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
  cancelAnimation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue
} from "react-native-reanimated";
import Svg, { Path, Rect, SvgXml } from "react-native-svg";
import { DiscSheen, GenericVinyl, PlainSleeve } from "./art";
import { LOGO_XML } from "./logo";
import { RECORDS, type VinylRecord } from "./records";

const BACKGROUND = "#1f1f1f";
const SIDE_PADDING = 20;
const GUTTER = 18;
const TILE_RADIUS = 6;
/** The open record sits left of centre, so the record can peek out to the right. */
const HERO_LEFT = 20;
/** The open sleeve's width as a share of the screen (270 pt on a 393 pt iPhone). */
const HERO_RATIO = 0.688;
/** The record is a little smaller than its sleeve, so it hides fully inside. */
const DISC_RATIO = 0.96;
/** How much of the record shows beside its sleeve once open (× record diameter). */
const DISC_PEEK = 0.18;

/** The floating pill at the bottom; the same element becomes the Play button. */
const PILL_HEIGHT = 52;
const PILL_PADDING = 10;
/** Concentric with the pill: inner radius 16 = pill radius 26 − padding 10. */
const THUMB_SIZE = PILL_HEIGHT - PILL_PADDING * 2;
const PLAY_HEIGHT = 56;
const PILL_COLOR = "#2a2a2a";
const PLAY_COLOR = "#ffffff";
/** Gap between the pill and the home indicator. */
const PILL_BOTTOM_GAP = 8;

/** 33⅓ rpm: one turn every 1.8 s. */
const TURN_MS = 1800;
const DEG_PER_MS = 360 / TURN_MS;
/** A quadratic spin-up reaches full speed after SPIN_UP_MS having turned ω·T/2. */
const SPIN_UP_MS = 400;
const SPIN_DOWN_MS = 900;
/** Close stops the record within the close morph. */
const SPIN_DOWN_ON_CLOSE_MS = 380;
/** Not a literal on purpose: the decorative spin stays out of the timeline. */
const UPRIGHT = 0;

/** Strong ease-out (press feedback and other worklet-side motion). */
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

function useRiseStyle(progress: SharedValue<number>, distance: number) {
  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * distance }]
  }));
}

/** Tactile press: in quickly, out a little slower. Not a scene. */
function usePressStyle(pressed: SharedValue<number>) {
  return useAnimatedStyle(() => ({
    transform: [
      {
        scale:
          pressed.value === 1
            ? withTiming(0.97, { duration: 100, easing: EASE_OUT })
            : withTiming(1, { duration: 160, easing: EASE_OUT })
      }
    ]
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
  const [bottomInset, setBottomInset] = useState(Platform.OS === "ios" ? 34 : 0);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** The record the closed pill shows; none until a record has been opened. */
  const [pillRecord, setPillRecord] = useState<number | null>(null);

  const tileSize = (width - SIDE_PADDING * 2 - GUTTER) / 2;
  const heroSize = Math.min(width - HERO_LEFT * 2, Math.round(width * HERO_RATIO));
  const discSize = heroSize * DISC_RATIO;
  /** How far the record travels right so DISC_PEEK of it shows past the sleeve's edge. */
  const discTravel = DISC_PEEK * discSize + (heroSize - discSize) / 2;
  const heroTop = topInset + 52;
  const heroRadius = (TILE_RADIUS * heroSize) / tileSize;
  const record = RECORDS[selected];
  const isDisc = record.tile === "disc";
  /** The element that morphs from the grid: the sleeve, or the bare disc. */
  const liftedSize = isDisc ? discSize : heroSize;
  const heroCenterX = HERO_LEFT + heroSize / 2;
  const heroCenterY = heroTop + heroSize / 2;
  const infoTop = heroTop + heroSize + 28;
  const playWidth = width - HERO_LEFT * 2;

  // Library entrance: one 0→1 progress per row.
  const headerFade = useSharedValue(0);
  const row1Reveal = useSharedValue(0);
  const row2Reveal = useSharedValue(0);
  const row3Reveal = useSharedValue(0);
  const row4Reveal = useSharedValue(0);

  // Open / close record. Each is a 0→1 progress.
  const coverMorph = useSharedValue(0);
  const gridRecede = useSharedValue(0);
  const pillMorph = useSharedValue(0);
  const pillLabel = useSharedValue(0);
  const discPeek = useSharedValue(0);
  const detailsReveal = useSharedValue(0);

  // Decorative turntable rotation in degrees, plus the angle each record was left at.
  const discSpin = useSharedValue(UPRIGHT);
  const restAngles = useSharedValue<number[]>(RECORDS.map(() => UPRIGHT));

  // Where the morphing cover starts from, in window coordinates (plain assignments only).
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const originSize = useSharedValue(0);
  const activeIndex = useSharedValue(-1);
  /** Natural width of the closed pill's content, measured. */
  const pillRestWidth = useSharedValue(160);
  const pillPressed = useSharedValue(0);

  const recordIndex = useRef(0);
  const pendingOpen = useRef(false);
  const pressedOnce = useRef(false);
  const scrollY = useRef(0);
  const restRect = useRef<RestRect>({ x: SIDE_PADDING, y: 0, size: 0, scroll: 0 });
  const firstRowY = useRef<number | undefined>(undefined);
  const firstTileLayout = useRef<LayoutRectangle | undefined>(undefined);
  const tileNodes = useRef<(View | null)[]>([]);
  const frameHeight = useRef(0);
  const safeFrame = useRef<LayoutRectangle | undefined>(undefined);

  // @scene "Library" group="Vinyl"
  function revealLibrary() {
    headerFade.value = 0;
    row1Reveal.value = 0;
    row2Reveal.value = 0;
    row3Reveal.value = 0;
    row4Reveal.value = 0;

    headerFade.value = withTiming(1, { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    row1Reveal.value = withTiming(1, { duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    row2Reveal.value = withDelay(40, withTiming(1, { duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    row3Reveal.value = withDelay(80, withTiming(1, { duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    row4Reveal.value = withDelay(120, withTiming(1, { duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
  }

  /**
   * Points the hero at the selected tile's last known rect, corrected for scrolling since.
   * When the record changes, the previous one keeps the angle it stopped at.
   */
  function syncOrigin() {
    const next = recordIndex.current;
    const previous = activeIndex.value;
    if (previous !== next) {
      const angles = restAngles.value.slice();
      if (previous >= 0) angles[previous] = discSpin.value % 360;
      restAngles.value = angles;
      discSpin.value = angles[next];
    }
    const rect = restRect.current;
    originX.value = rect.x;
    originY.value = rect.y + rect.scroll - scrollY.current;
    originSize.value = rect.size > 0 ? rect.size : tileSize;
    activeIndex.value = next;
  }

  // @scene "Open record" group="Vinyl"
  function openRecord() {
    cancelAnimation(discSpin);
    syncOrigin();
    setOpen(true);
    setPlaying(false);

    coverMorph.value = 0;
    gridRecede.value = 0;
    pillMorph.value = 0;
    pillLabel.value = 0;
    discPeek.value = 0;
    detailsReveal.value = 0;

    coverMorph.value = withTiming(1, { duration: 300, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    gridRecede.value = withTiming(1, { duration: 140, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    pillMorph.value = withTiming(1, { duration: 300, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    pillLabel.value = withTiming(1, { duration: 240, easing: Easing.linear });
    discPeek.value = withDelay(80, withTiming(1, { duration: 300, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    detailsReveal.value = withDelay(60, withTiming(1, { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
  }

  // @scene "Close record" group="Vinyl"
  function closeRecord() {
    syncOrigin();
    setOpen(false);
    setPillRecord(recordIndex.current);
    if (playing) stopSpin(SPIN_DOWN_ON_CLOSE_MS);

    coverMorph.value = 1;
    gridRecede.value = 1;
    pillMorph.value = 1;
    pillLabel.value = 1;
    discPeek.value = 1;
    detailsReveal.value = 1;

    detailsReveal.value = withTiming(0, { duration: 120, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    discPeek.value = withTiming(0, { duration: 240, easing: Easing.bezier(0.32, 0.72, 0, 1) });
    coverMorph.value = withDelay(60, withTiming(0, { duration: 380, easing: Easing.bezier(0.32, 0.72, 0, 1) }));
    pillMorph.value = withTiming(0, { duration: 380, easing: Easing.bezier(0.32, 0.72, 0, 1) });
    pillLabel.value = withTiming(0, { duration: 300, easing: Easing.linear });
    gridRecede.value = withDelay(60, withTiming(0, { duration: 300, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
  }

  /** Spins up to 33⅓ rpm over SPIN_UP_MS, then turns linearly until stopped. */
  function startSpin() {
    const from = discSpin.value % 360;
    // Ends at the playing speed: a quadratic ease-in covers ω·T/2 in T.
    const spinUp = (DEG_PER_MS * SPIN_UP_MS) / 2;
    discSpin.value = from;
    discSpin.value = withSequence(
      withTiming(from + spinUp, { duration: SPIN_UP_MS, easing: Easing.in(Easing.quad) }),
      withRepeat(
        withTiming(from + spinUp + 360, { duration: TURN_MS, easing: Easing.linear }),
        -1,
        false
      )
    );
  }

  // @scene off
  function stopSpin(duration: number) {
    // Starts at the playing speed: a quadratic ease-out covers ω·T/2 in T.
    const spinDown = (DEG_PER_MS * duration) / 2;
    discSpin.value = withTiming(discSpin.value + spinDown, { duration, easing: Easing.out(Easing.quad) });
  }

  function togglePlay() {
    if (playing) {
      stopSpin(SPIN_DOWN_MS);
      setPlaying(false);
      return;
    }
    startSpin();
    setPlaying(true);
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

  function handlePillPress() {
    if (open) {
      togglePlay();
      return;
    }
    if (pillRecord !== null) handleTilePress(pillRecord);
  }

  /** Before any press, a replayed "Open record" morphs record 0 from its laid-out rect. */
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

  /** The safe area, read from SafeAreaView's padding (no extra dependency). */
  function applySafeArea() {
    const frame = safeFrame.current;
    if (Platform.OS !== "ios" || !frame) return;
    if (frame.y > 0 && frame.y !== topInset) setTopInset(frame.y);
    if (frameHeight.current > 0) {
      const bottom = Math.max(0, frameHeight.current - frame.y - frame.height);
      if (bottom !== bottomInset) setBottomInset(bottom);
    }
  }

  function handleSafeAreaLayout(event: LayoutChangeEvent) {
    safeFrame.current = event.nativeEvent.layout;
    applySafeArea();
  }

  function handleScreenLayout(event: LayoutChangeEvent) {
    frameHeight.current = event.nativeEvent.layout.height;
    applySafeArea();
  }

  const headerStyle = useAnimatedStyle(() => ({ opacity: headerFade.value }));
  const row1Style = useRiseStyle(row1Reveal, 8);
  const row2Style = useRiseStyle(row2Reveal, 8);
  const row3Style = useRiseStyle(row3Reveal, 8);
  const row4Style = useRiseStyle(row4Reveal, 8);
  const rowStyles = [row1Style, row2Style, row3Style, row4Style];

  // The grid recedes as one surface: it fades and settles back a touch.
  const gridStyle = useAnimatedStyle(() => ({
    opacity: 1 - gridRecede.value,
    transform: [{ scale: 1 - 0.02 * gridRecede.value }]
  }));

  const heroStyle = useAnimatedStyle(() => {
    const t = coverMorph.value;
    const visible = t > 0.0001 || gridRecede.value > 0.0001;
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

  // The hero's shadow deepens from the tile's as it grows, so the handoff has no jump.
  const sleeveStyle = useAnimatedStyle(() => ({
    opacity: isDisc ? interpolate(discPeek.value, [0, 0.5], [0, 1], Extrapolation.CLAMP) : 1,
    shadowOpacity: isDisc ? 0.5 : 0.35 + 0.15 * coverMorph.value
  }));

  const discStyle = useAnimatedStyle(() => ({
    shadowOpacity: isDisc ? 0.3 + 0.15 * coverMorph.value : 0.45,
    transform: [{ translateX: discTravel * discPeek.value }]
  }));

  const discSpinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${discSpin.value}deg` }]
  }));

  const detailsStyle = useRiseStyle(detailsReveal, 6);
  const closeStyle = useAnimatedStyle(() => ({ opacity: detailsReveal.value }));

  const pillStyle = useAnimatedStyle(() => {
    const t = pillMorph.value;
    const height = PILL_HEIGHT + (PLAY_HEIGHT - PILL_HEIGHT) * t;
    return {
      backgroundColor: interpolateColor(t, [0, 1], [PILL_COLOR, PLAY_COLOR]),
      borderRadius: height / 2,
      height,
      width: pillRestWidth.value + (playWidth - pillRestWidth.value) * t
    };
  });
  const pillPressStyle = usePressStyle(pillPressed);

  // One driver for the crossfade: old content out by 1/3 (80 ms), the label in from 1/2 (120 ms).
  const pillContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pillLabel.value, [0, 1 / 3], [1, 0], Extrapolation.CLAMP)
  }));
  const playLabelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pillLabel.value, [0.5, 1], [0, 1], Extrapolation.CLAMP)
  }));

  const nowShowing = pillRecord === null ? undefined : RECORDS[pillRecord];

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
        discStyle
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
    <View
      onLayout={handleScreenLayout}
      style={styles.screen}
    >
      <StatusBar barStyle="light-content" />
      <SafeAreaView pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View onLayout={handleSafeAreaLayout} style={styles.fill} />
      </SafeAreaView>

      <Animated.View style={[styles.fill, gridStyle]}>
        <ScrollView
          contentContainerStyle={[
            styles.grid,
            { paddingBottom: bottomInset + PILL_BOTTOM_GAP + PILL_HEIGHT + 28, paddingTop: topInset + 64 }
          ]}
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
                  coverMorph={coverMorph}
                  discSpin={discSpin}
                  gridRecede={gridRecede}
                  index={index}
                  key={RECORDS[index].id}
                  onLayout={index === 0 ? handleFirstTileLayout : undefined}
                  onPress={handleTilePress}
                  record={RECORDS[index]}
                  registerNode={(node) => {
                    tileNodes.current[index] = node;
                  }}
                  restAngles={restAngles}
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

      {/* While a record is open, a tap anywhere outside the controls closes it. */}
      <Pressable
        accessibilityLabel="Close record"
        accessibilityRole="button"
        disabled={!open}
        onPress={closeRecord}
        pointerEvents={open ? "auto" : "none"}
        style={StyleSheet.absoluteFill}
      />

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

      <Animated.View pointerEvents="none" style={[styles.info, { top: infoTop }, detailsStyle]}>
        <Text numberOfLines={1} style={styles.heroTitle}>
          {record.title}
        </Text>
        <Text numberOfLines={1} style={styles.heroMeta}>
          {record.artist} · <Text style={styles.tabular}>{record.year}</Text>
        </Text>
        <View style={styles.tracks}>
          {record.tracks.map((track, index) => (
            <View key={track} style={[styles.trackRow, index > 0 && styles.trackDivider]}>
              <Text style={[styles.trackNumber, styles.tabular]}>{index + 1}</Text>
              <Text numberOfLines={1} style={styles.trackTitle}>
                {track}
              </Text>
            </View>
          ))}
        </View>
      </Animated.View>

      <Animated.View
        pointerEvents={open ? "box-none" : "none"}
        style={[styles.closeWrap, { top: topInset + 2 }, closeStyle]}
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

      <View pointerEvents="box-none" style={[styles.pillDock, { bottom: bottomInset + PILL_BOTTOM_GAP }]}>
        <Pressable
          accessibilityLabel={open ? (playing ? "Pause" : "Play") : nowShowing?.title ?? "Not playing"}
          accessibilityRole="button"
          disabled={!open && pillRecord === null}
          onPress={handlePillPress}
          onPressIn={() => {
            pillPressed.value = 1;
          }}
          onPressOut={() => {
            pillPressed.value = 0;
          }}
        >
          <Animated.View style={[styles.pill, pillStyle, pillPressStyle]}>
            <Animated.View
              onLayout={(event) => {
                pillRestWidth.value = event.nativeEvent.layout.width;
              }}
              style={[styles.pillContent, pillContentStyle]}
            >
              <View style={styles.thumb}>
                {nowShowing ? (
                  <nowShowing.art size={THUMB_SIZE} />
                ) : (
                  <GenericVinyl labelColor="#4a4a4a" size={THUMB_SIZE} />
                )}
                <View pointerEvents="none" style={[styles.outline, styles.thumbOutline]} />
              </View>
              <Text numberOfLines={1} style={[styles.pillTitle, !nowShowing && styles.pillIdle]}>
                {nowShowing ? nowShowing.title : "Not playing"}
              </Text>
            </Animated.View>
            <Animated.View pointerEvents="none" style={[styles.playLabel, playLabelStyle]}>
              <Svg height={14} viewBox="0 0 14 14" width={14}>
                {playing ? (
                  <>
                    <Rect fill="#111111" height={12} rx={1.2} width={3.6} x={2.4} y={1} />
                    <Rect fill="#111111" height={12} rx={1.2} width={3.6} x={8} y={1} />
                  </>
                ) : (
                  // Nudged right: a triangle's visual centre sits left of its box centre.
                  <Path d="M4 1.6 L12.8 7 L4 12.4 Z" fill="#111111" />
                )}
              </Svg>
              <Text style={styles.playText}>{playing ? "Pause" : "Play"}</Text>
            </Animated.View>
          </Animated.View>
        </Pressable>
      </View>
    </View>
  );
}

const ROWS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7]
];

interface RecordTileProps {
  record: VinylRecord;
  index: number;
  size: number;
  activeIndex: SharedValue<number>;
  coverMorph: SharedValue<number>;
  gridRecede: SharedValue<number>;
  discSpin: SharedValue<number>;
  restAngles: SharedValue<number[]>;
  onPress(index: number): void;
  onLayout?: (event: LayoutChangeEvent) => void;
  registerNode(node: View | null): void;
}

function RecordTile({
  record,
  index,
  size,
  activeIndex,
  coverMorph,
  gridRecede,
  discSpin,
  restAngles,
  onPress,
  onLayout,
  registerNode
}: RecordTileProps) {
  const pressed = useSharedValue(0);
  const isDisc = record.tile === "disc";
  const radius = isDisc ? size / 2 : TILE_RADIUS;

  const pressStyle = usePressStyle(pressed);

  // While its record is open, the tile hands its place over to the hero.
  const handoffStyle = useAnimatedStyle(() => ({
    opacity:
      activeIndex.value === index && (coverMorph.value > 0.0001 || gridRecede.value > 0.0001) ? 0 : 1
  }));

  // A bare disc rests at the angle its record stopped turning, so the handoff is seamless.
  const spinStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${activeIndex.value === index ? discSpin.value : restAngles.value[index] ?? 0}deg` }
    ]
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
              {isDisc ? (
                <>
                  <Animated.View style={spinStyle}>
                    <record.art size={size} />
                  </Animated.View>
                  <DiscSheen size={size} />
                </>
              ) : (
                <record.art size={size} />
              )}
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
  hero: {
    position: "absolute"
  },
  heroSleeve: {
    left: 0,
    position: "absolute",
    shadowColor: "#000000",
    shadowOffset: { height: 18, width: 0 },
    shadowRadius: 26,
    top: 0
  },
  heroDisc: {
    position: "absolute",
    shadowColor: "#000000",
    shadowOffset: { height: 12, width: 0 },
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
  },
  pillDock: {
    alignItems: "center",
    left: 0,
    position: "absolute",
    right: 0
  },
  pill: {
    shadowColor: "#000000",
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 16
  },
  pillContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    height: PILL_HEIGHT,
    left: 0,
    paddingLeft: PILL_PADDING,
    paddingRight: 20,
    position: "absolute",
    top: 0
  },
  thumb: {
    borderRadius: THUMB_SIZE / 2,
    height: THUMB_SIZE,
    overflow: "hidden",
    width: THUMB_SIZE
  },
  thumbOutline: {
    borderRadius: THUMB_SIZE / 2
  },
  pillTitle: {
    color: "#f5f5f7",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.2,
    maxWidth: 200
  },
  pillIdle: {
    color: "rgba(235,235,245,0.6)",
    fontWeight: "500"
  },
  playLabel: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center"
  },
  playText: {
    color: "#111111",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.3
  }
});
