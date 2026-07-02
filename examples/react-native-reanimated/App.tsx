import { useEffect } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from "react-native-reanimated";
import {
  bindTrigger,
  bindSharedValue,
  definePanel,
  group,
  slider,
  trigger
} from "@runtime-inspector/react-native";

export default function App() {
  const scale = useSharedValue(1);
  const blur = useSharedValue(0);
  const opacity = useSharedValue(1);

  useEffect(() => {
    bindSharedValue("card.scale", scale);
    bindSharedValue("card.blur", blur);
    bindSharedValue("card.opacity", opacity);
    bindTrigger("card.replay", () => {
      scale.value = withTiming(0.92, { duration: 160 });
      opacity.value = withTiming(0.72, { duration: 160 });
      blur.value = withTiming(20, { duration: 160 });

      setTimeout(() => {
        scale.value = withTiming(1, { duration: 240 });
        opacity.value = withTiming(1, { duration: 240 });
        blur.value = withTiming(0, { duration: 240 });
      }, 220);
    });

    const brokerUrl =
      Platform.OS === "android" ? "ws://10.0.2.2:4577" : "ws://127.0.0.1:4577";

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
    return panel.disconnect;
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
