import { useEffect } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
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
      scale.value = 0.92;
      opacity.value = 0.72;
      blur.value = 20;

      setTimeout(() => {
        scale.value = 1;
        opacity.value = 1;
        blur.value = 0;
      }, 180);
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

  const blurStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, blur.value / 32)
  }));

  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>Runtime Inspector</Text>
      <Animated.View style={[styles.card, cardStyle]}>
        <Animated.View pointerEvents="none" style={[styles.blurLayer, blurStyle]} />
        <Text style={styles.title}>Card Transition</Text>
        <Text style={styles.body}>
          Move the panel sliders to update Reanimated SharedValues live.
        </Text>
      </Animated.View>
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
  card: {
    backgroundColor: "#f5f7fb",
    borderRadius: 28,
    minHeight: 220,
    overflow: "hidden",
    padding: 28,
    width: "100%"
  },
  blurLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(69, 179, 127, 0.28)"
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
