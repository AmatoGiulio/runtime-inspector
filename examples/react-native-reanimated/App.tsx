import { useEffect, useRef, type MutableRefObject } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from "react-native-reanimated";
import {
  bezier,
  bindValue,
  bindTrigger,
  definePanel,
  group,
  slider,
  spring,
  trigger
} from "@runtime-inspector/react-native";

type SpringConfig = {
  damping: number;
  stiffness: number;
  mass?: number;
};

type CubicBezier = [number, number, number, number];

export default function App() {
  const moveX = useSharedValue(0);
  const rotate = useSharedValue(0);
  const scale = useSharedValue(1);
  const glow = useSharedValue(10);
  const opacity = useSharedValue(1);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const targetRef = useRef({
    moveX: 0,
    rotate: 0,
    scale: 1,
    glow: 10,
    opacity: 1
  });
  const springConfigRef = useRef<SpringConfig>({
    damping: 14,
    stiffness: 180,
    mass: 1
  });
  const easingRef = useRef<CubicBezier>([0.22, 1, 0.36, 1]);

  useEffect(() => {
    const replayTransition = () => {
      const easing = Easing.bezier(...easingRef.current);
      moveX.value = withTiming(-110, { duration: 260, easing });
      rotate.value = withTiming(-14, { duration: 260, easing });
      scale.value = withTiming(0.82, { duration: 260, easing });
      opacity.value = withTiming(0.62, { duration: 260, easing });
      glow.value = withTiming(36, { duration: 260, easing });

      setTimeout(() => {
        moveX.value = withSpring(targetRef.current.moveX, springConfigRef.current);
        rotate.value = withSpring(targetRef.current.rotate, springConfigRef.current);
        scale.value = withSpring(targetRef.current.scale, springConfigRef.current);
        opacity.value = withSpring(targetRef.current.opacity, springConfigRef.current);
        glow.value = withSpring(targetRef.current.glow, springConfigRef.current);
      }, 220);
    };

    bindValue("card.moveX", (value) => {
      targetRef.current.moveX = value as number;
      moveX.value = value as number;
    });
    bindValue("card.rotate", (value) => {
      targetRef.current.rotate = value as number;
      rotate.value = value as number;
    });
    bindValue("card.scale", (value) => {
      targetRef.current.scale = value as number;
      scale.value = value as number;
    });
    bindValue("card.glow", (value) => {
      targetRef.current.glow = value as number;
      glow.value = value as number;
    });
    bindValue("card.opacity", (value) => {
      targetRef.current.opacity = value as number;
      opacity.value = value as number;
    });
    bindValue("card.spring", (value) => {
      springConfigRef.current = value as SpringConfig;

      schedulePreview(replayTransition, previewTimerRef);
    });
    bindValue("card.easing", (value) => {
      easingRef.current = value as CubicBezier;
      schedulePreview(replayTransition, previewTimerRef);
    });
    bindTrigger("card.replay", replayTransition);

    const brokerUrl = getBrokerUrl();

    const panel = definePanel(
      {
        id: "card-transition",
        title: "Card Transition",
        version: "0.1.0",
        groups: [
          group({
            id: "direct-controls",
            label: "Live card controls",
            controls: [
              slider({
                id: "moveX",
                label: "Move X",
                min: -120,
                max: 120,
                step: 1,
                defaultValue: 0,
                unit: "px",
                binding: "card.moveX"
              }),
              slider({
                id: "rotate",
                label: "Rotate",
                min: -18,
                max: 18,
                step: 1,
                defaultValue: 0,
                unit: "deg",
                binding: "card.rotate"
              }),
              slider({
                id: "scale",
                label: "Scale",
                min: 0.7,
                max: 1.35,
                step: 0.01,
                defaultValue: 1,
                binding: "card.scale"
              }),
              slider({
                id: "glow",
                label: "Glow",
                min: 0,
                max: 48,
                step: 1,
                defaultValue: 10,
                unit: "px",
                binding: "card.glow"
              }),
              slider({
                id: "opacity",
                label: "Opacity",
                min: 0,
                max: 1,
                step: 0.01,
                defaultValue: 1,
                binding: "card.opacity"
              })
            ]
          }),
          group({
            id: "replay-tuning",
            label: "Replay tuning",
            description: "These controls change how the replay animation feels.",
            controls: [
              spring({
                id: "spring",
                label: "Replay return spring",
                description: "Changing these values automatically replays the return motion.",
                defaultValue: springConfigRef.current,
                ranges: {
                  damping: [4, 32],
                  stiffness: [60, 320],
                  mass: [0.4, 2.5]
                },
                binding: "card.spring"
              }),
              bezier({
                id: "easing",
                label: "Replay out easing",
                description: "Changing this curve automatically replays the opening motion.",
                defaultValue: easingRef.current,
                presets: [
                  { label: "Ease out", value: [0.22, 1, 0.36, 1] },
                  { label: "Standard", value: [0.4, 0, 0.2, 1] }
                ],
                binding: "card.easing"
              }),
              trigger({
                id: "replay",
                label: "Replay transition",
                description: "Run the demo transition from the panel.",
                binding: "card.replay"
              })
            ]
          })
        ]
      },
      { brokerUrl }
    );

    panel.connect();
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
      panel.disconnect();
    };
  }, [glow, moveX, opacity, rotate, scale]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: moveX.value },
      { rotate: `${rotate.value}deg` },
      { scale: scale.value }
    ]
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: Math.min(0.9, glow.value / 48),
    transform: [
      { translateX: moveX.value },
      { rotate: `${rotate.value}deg` },
      { scale: 1 + glow.value / 160 }
    ]
  }));

  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>Runtime Inspector</Text>
      <View style={styles.cardStage}>
        <Animated.View pointerEvents="none" style={[styles.glowLayer, glowStyle]} />
        <Animated.View style={[styles.card, cardStyle]}>
          <Text style={styles.liveBadge}>LIVE</Text>
          <Text style={styles.title}>Obvious Card</Text>
          <Text style={styles.body}>
            Move X and Rotate should be instantly visible from the panel.
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    backgroundColor: "#16181d",
    flex: 1,
    justifyContent: "center",
    padding: 24
  },
  eyebrow: {
    color: "#8f98a8",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 16,
    textTransform: "uppercase"
  },
  cardStage: {
    position: "relative",
    width: "100%"
  },
  glowLayer: {
    backgroundColor: "rgba(69, 179, 127, 0.42)",
    borderRadius: 34,
    bottom: -12,
    left: 10,
    position: "absolute",
    right: 10,
    top: -12
  },
  card: {
    backgroundColor: "#f5f7fb",
    borderRadius: 28,
    minHeight: 220,
    overflow: "hidden",
    padding: 28,
    width: "100%"
  },
  liveBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#111318",
    borderRadius: 999,
    color: "#f5f7fb",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 16,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  title: {
    color: "#111318",
    fontSize: 32,
    fontWeight: "800"
  },
  body: {
    color: "#4b5563",
    fontSize: 16,
    lineHeight: 23,
    marginTop: 12
  }
});

function getBrokerUrl() {
  if (process.env.EXPO_PUBLIC_RI_BROKER_URL) {
    return process.env.EXPO_PUBLIC_RI_BROKER_URL;
  }

  return Platform.OS === "android" ? "ws://10.0.2.2:4577" : "ws://127.0.0.1:4577";
}

function schedulePreview(
  replayTransition: () => void,
  previewTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | undefined>
) {
  if (previewTimerRef.current) {
    clearTimeout(previewTimerRef.current);
  }

  previewTimerRef.current = setTimeout(replayTransition, 120);
}
