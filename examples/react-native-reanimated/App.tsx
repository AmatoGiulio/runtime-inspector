import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming
} from "react-native-reanimated";
import { useInspector } from "@runtime-inspector/react-native";

export default function App() {
  const glow = useSharedValue(10);
  // @inspect min=8 max=48
  const cardRadius = useSharedValue(28);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function schedulePreview() {
    if (previewTimer.current) {
      clearTimeout(previewTimer.current);
    }
    previewTimer.current = setTimeout(() => replayTransition(), 120);
  }

  const backdrop = useInspector(
    "backdrop",
    {
      scale: { value: 1, min: 0.5, max: 3, step: 0.01, label: "Pattern scale" },
      opacity: { value: 0.15, min: 0, max: 1, step: 0.01, label: "Backdrop opacity" },
      color: "#2a2f3a",
      replay: () => {
        const current = backdrop.scale.value;
        backdrop.scale.value = withSequence(
          withTiming(current * 1.25, { duration: 160 }),
          withSpring(current, { damping: 10, stiffness: 140 })
        );
      }
    },
    { title: "Backdrop" }
  );

  const card = useInspector("card-transition", {
    moveX: { value: 0, min: -120, max: 120, step: 1, unit: "px", label: "Move X" },
    rotate: { value: 0, min: -18, max: 18, step: 1, unit: "deg", label: "Rotate" },
    scale: { value: 1, min: 0.7, max: 1.35, step: 0.01, label: "Scale" },
    opacity: { value: 1, min: 0, max: 1, step: 0.01, label: "Opacity" },
    color: "#f5f7fb",
    spring: {
      damping: 14,
      stiffness: 180,
      mass: 1,
      label: "Replay return spring",
      onChange: () => schedulePreview()
    },
    easing: {
      value: [0.22, 1, 0.36, 1],
      onChange: () => schedulePreview()
    },
    replay: () => replayTransition()
  });

  function replayTransition() {
    const easing = Easing.bezier(...card.easing.value);
    card.moveX.value = withTiming(-110, { duration: 260, easing });
    card.rotate.value = withTiming(-14, { duration: 260, easing });
    card.scale.value = withTiming(0.82, { duration: 260, easing });
    card.opacity.value = withTiming(0.62, { duration: 260, easing });

    setTimeout(() => {
      const targets = card.$targets;
      const spring = card.spring.value;
      card.moveX.value = withSpring(targets.moveX, spring);
      card.rotate.value = withSpring(targets.rotate, spring);
      card.scale.value = withSpring(targets.scale, spring);
      card.opacity.value = withSpring(targets.opacity, spring);
      card.color.value = targets.color;
    }, 220);
  }

  useEffect(() => {
    return () => {
      if (previewTimer.current) {
        clearTimeout(previewTimer.current);
      }
    };
  }, []);

  const cardStyle = useAnimatedStyle(() => ({
    backgroundColor: card.color.value,
    opacity: card.opacity.value,
    borderRadius: cardRadius.value,
    transform: [
      { translateX: card.moveX.value },
      { rotate: `${card.rotate.value}deg` },
      { scale: card.scale.value }
    ]
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: Math.min(0.9, glow.value / 48),
    transform: [
      { translateX: card.moveX.value },
      { rotate: `${card.rotate.value}deg` },
      { scale: 1 + glow.value / 160 }
    ]
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    backgroundColor: backdrop.color.value,
    opacity: backdrop.opacity.value,
    transform: [{ rotate: "45deg" }, { scale: backdrop.scale.value }]
  }));

  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.backdrop, backdropStyle]} />
      <Text style={styles.eyebrow}>Runtime Inspector</Text>
      <View style={styles.cardStage}>
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
  backdrop: {
    alignSelf: "center",
    backgroundColor: "#2a2f3a",
    borderRadius: 40,
    height: 260,
    position: "absolute",
    width: 260
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
