import { useEffect, useRef } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from "react-native-reanimated";
import {
  bindValue,
  bindTrigger,
  bindSharedValue,
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

export default function App() {
  const scale = useSharedValue(1);
  const blur = useSharedValue(0);
  const opacity = useSharedValue(1);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const springConfigRef = useRef<SpringConfig>({
    damping: 14,
    stiffness: 180,
    mass: 1
  });

  useEffect(() => {
    const replayTransition = () => {
      scale.value = withTiming(0.92, { duration: 160 });
      opacity.value = withTiming(0.72, { duration: 160 });
      blur.value = withTiming(20, { duration: 160 });

      setTimeout(() => {
        scale.value = withSpring(1, springConfigRef.current);
        opacity.value = withSpring(1, springConfigRef.current);
        blur.value = withSpring(0, springConfigRef.current);
      }, 220);
    };

    bindSharedValue("card.scale", scale);
    bindSharedValue("card.blur", blur);
    bindSharedValue("card.opacity", opacity);
    bindValue("card.spring", (value) => {
      springConfigRef.current = value as SpringConfig;

      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }

      previewTimerRef.current = setTimeout(replayTransition, 120);
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
            id: "motion",
            label: "Motion",
            controls: [
              slider({
                id: "scale",
                label: "Scale",
                min: 0.8,
                max: 1.2,
                step: 0.01,
                defaultValue: 1,
                binding: "card.scale"
              }),
              slider({
                id: "blur",
                label: "Blur",
                min: 0,
                max: 32,
                step: 1,
                defaultValue: 0,
                unit: "px",
                binding: "card.blur"
              }),
              slider({
                id: "opacity",
                label: "Opacity",
                min: 0,
                max: 1,
                step: 0.01,
                defaultValue: 1,
                binding: "card.opacity"
              }),
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
  }, [blur, opacity, scale]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }]
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: Math.min(0.85, blur.value / 38),
    transform: [{ scale: 1 + blur.value / 180 }]
  }));

  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>Runtime Inspector</Text>
      <View style={styles.cardStage}>
        <Animated.View pointerEvents="none" style={[styles.glowLayer, glowStyle]} />
        <Animated.View style={[styles.card, cardStyle]}>
          <Text style={styles.title}>Card Transition</Text>
          <Text style={styles.body}>
            Move the panel sliders to update Reanimated SharedValues live.
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
