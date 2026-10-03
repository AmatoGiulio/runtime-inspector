import { useEffect } from "react";
import { Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming
} from "react-native-reanimated";
import { useScene } from "@runtime-inspector/react-native";

export function ProductRevealDemo() {
  const coverOpacity = useSharedValue(0);
  const coverScale = useSharedValue(0.86);
  const titleOpacity = useSharedValue(0);
  const titleY = useSharedValue(24);
  const detailsOpacity = useSharedValue(0);
  const detailsY = useSharedValue(24);
  const buttonOpacity = useSharedValue(0);
  const buttonScale = useSharedValue(0.9);

  const play = useScene("product-reveal", () => {
    // Reset to the starting pose (plain assignments, not animations).
    coverOpacity.value = 0;
    coverScale.value = 0.86;
    titleOpacity.value = 0;
    titleY.value = 24;
    detailsOpacity.value = 0;
    detailsY.value = 24;
    buttonOpacity.value = 0;
    buttonScale.value = 0.9;

    coverOpacity.value = withTiming(1, { duration: 320 });
    coverScale.value = withSpring(1, { damping: 14, stiffness: 160 });
    titleOpacity.value = withDelay(140, withTiming(1, { duration: 300 }));
    titleY.value = withDelay(140, withTiming(0, { duration: 380 }));
    detailsOpacity.value = withDelay(240, withTiming(1, { duration: 300 }));
    detailsY.value = withDelay(240, withTiming(0, { duration: 380 }));
    buttonOpacity.value = withDelay(380, withTiming(1, { duration: 240 }));
    buttonScale.value = withDelay(380, withSpring(1, { damping: 12, stiffness: 220 }));
  });

  useEffect(() => {
    play();
    // Run the entrance once on mount; `play` only touches stable shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coverStyle = useAnimatedStyle(() => ({
    opacity: coverOpacity.value,
    transform: [{ scale: coverScale.value }]
  }));

  const titleStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
    transform: [{ translateY: titleY.value }]
  }));

  const detailsStyle = useAnimatedStyle(() => ({
    opacity: detailsOpacity.value,
    transform: [{ translateY: detailsY.value }]
  }));

  const buttonStyle = useAnimatedStyle(() => ({
    opacity: buttonOpacity.value,
    transform: [{ scale: buttonScale.value }]
  }));

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.eyebrow}>NEW RELEASE</Text>

      <Animated.View style={[styles.cover, coverStyle]}>
        <View style={styles.coverArt}>
          <View style={styles.coverCircleLarge} />
          <View style={styles.coverCircleSmall} />
          <View style={styles.coverRing} />
        </View>
      </Animated.View>

      <Animated.View style={[styles.titleBlock, titleStyle]}>
        <Text style={styles.title}>Midnight Bloom</Text>
        <Text style={styles.artist}>Aurora Lane</Text>
      </Animated.View>

      <Animated.View style={[styles.details, detailsStyle]}>
        <View style={styles.pill}>
          <Text style={styles.pillText}>12 tracks</Text>
        </View>
        <View style={styles.pill}>
          <Text style={styles.pillText}>48 min</Text>
        </View>
        <View style={styles.pill}>
          <Text style={styles.pillText}>Hi-Res</Text>
        </View>
      </Animated.View>

      <Animated.View style={[styles.buttonWrap, buttonStyle]}>
        <Pressable accessibilityRole="button" onPress={play} style={styles.button}>
          <Text style={styles.buttonLabel}>Play album</Text>
        </Pressable>
      </Animated.View>

      <View style={styles.spacer} />
      <Text style={styles.caption}>Tap “Play album” to replay</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    backgroundColor: "#0e0f13",
    flex: 1,
    paddingBottom: 36,
    paddingHorizontal: 24,
    paddingTop: 72
  },
  eyebrow: {
    color: "#7d8597",
    fontSize: 11,
    letterSpacing: 2,
    marginBottom: 28
  },
  // Outer cover carries the shadow; the inner view clips the artwork
  // (on iOS `overflow: "hidden"` on the same view would clip the shadow too).
  cover: {
    backgroundColor: "#6d4aff",
    borderRadius: 36,
    elevation: 16,
    height: 260,
    shadowColor: "#6d4aff",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.45,
    shadowRadius: 28,
    width: 260
  },
  coverArt: {
    backgroundColor: "#6d4aff",
    borderRadius: 36,
    height: 260,
    overflow: "hidden",
    width: 260
  },
  coverCircleLarge: {
    backgroundColor: "#ff5c8a",
    borderRadius: 110,
    bottom: -64,
    height: 220,
    position: "absolute",
    right: -56,
    width: 220
  },
  coverCircleSmall: {
    backgroundColor: "#ffd166",
    borderRadius: 48,
    height: 96,
    left: 28,
    position: "absolute",
    top: 28,
    width: 96
  },
  coverRing: {
    borderColor: "#ffffff",
    borderRadius: 70,
    borderWidth: 1.5,
    height: 140,
    opacity: 0.3,
    position: "absolute",
    right: 24,
    top: 40,
    width: 140
  },
  titleBlock: {
    alignItems: "center",
    marginTop: 32
  },
  title: {
    color: "#f4f5f8",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.5,
    textAlign: "center"
  },
  artist: {
    color: "#9aa3b5",
    fontSize: 15,
    marginTop: 6,
    textAlign: "center"
  },
  details: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: 18
  },
  pill: {
    backgroundColor: "#1b1d24",
    borderColor: "#2a2d38",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  pillText: {
    color: "#c5cbd8",
    fontSize: 12,
    fontWeight: "600"
  },
  buttonWrap: {
    marginTop: 28,
    maxWidth: 300,
    width: "100%"
  },
  button: {
    alignItems: "center",
    backgroundColor: "#f4f5f8",
    borderRadius: 27,
    height: 54,
    justifyContent: "center"
  },
  buttonLabel: {
    color: "#0e0f13",
    fontSize: 16,
    fontWeight: "700"
  },
  spacer: {
    flex: 1,
    minHeight: 16
  },
  caption: {
    color: "#5c6373",
    fontSize: 11
  }
});
