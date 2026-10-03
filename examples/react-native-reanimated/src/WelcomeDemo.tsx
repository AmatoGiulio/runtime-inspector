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

export function WelcomeDemo() {
  const logoScale = useSharedValue(0.7);
  const logoOpacity = useSharedValue(0);
  const titleY = useSharedValue(20);
  const titleOpacity = useSharedValue(0);
  const row1X = useSharedValue(-40);
  const row1Opacity = useSharedValue(0);
  const row2X = useSharedValue(-40);
  const row2Opacity = useSharedValue(0);
  const row3X = useSharedValue(-40);
  const row3Opacity = useSharedValue(0);

  const play = useScene("welcome", () => {
    // Reset to the starting pose (plain assignments, not animations).
    logoScale.value = 0.7;
    logoOpacity.value = 0;
    titleY.value = 20;
    titleOpacity.value = 0;
    row1X.value = -40;
    row1Opacity.value = 0;
    row2X.value = -40;
    row2Opacity.value = 0;
    row3X.value = -40;
    row3Opacity.value = 0;

    logoScale.value = withSpring(1, { damping: 12, stiffness: 180 });
    logoOpacity.value = withTiming(1, { duration: 260 });
    titleY.value = withDelay(120, withTiming(0, { duration: 360 }));
    titleOpacity.value = withDelay(120, withTiming(1, { duration: 300 }));
    row1X.value = withDelay(240, withTiming(0, { duration: 360 }));
    row1Opacity.value = withDelay(240, withTiming(1, { duration: 300 }));
    row2X.value = withDelay(320, withTiming(0, { duration: 360 }));
    row2Opacity.value = withDelay(320, withTiming(1, { duration: 300 }));
    row3X.value = withDelay(400, withTiming(0, { duration: 360 }));
    row3Opacity.value = withDelay(400, withTiming(1, { duration: 300 }));
  });

  useEffect(() => {
    play();
    // Run the entrance once on mount; `play` only touches stable shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }]
  }));

  const titleStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
    transform: [{ translateY: titleY.value }]
  }));

  const row1Style = useAnimatedStyle(() => ({
    opacity: row1Opacity.value,
    transform: [{ translateX: row1X.value }]
  }));

  const row2Style = useAnimatedStyle(() => ({
    opacity: row2Opacity.value,
    transform: [{ translateX: row2X.value }]
  }));

  const row3Style = useAnimatedStyle(() => ({
    opacity: row3Opacity.value,
    transform: [{ translateX: row3X.value }]
  }));

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <Animated.View style={[styles.logo, logoStyle]}>
        <Text style={styles.logoGlyph}>♪</Text>
      </Animated.View>

      <Animated.View style={[styles.titleBlock, titleStyle]}>
        <Text style={styles.title}>Welcome to Bloom</Text>
        <Text style={styles.subtitle}>Music that moves with you</Text>
      </Animated.View>

      <View style={styles.rows}>
        <Animated.View style={[styles.row, row1Style]}>
          <View style={[styles.dot, styles.dotPink]} />
          <Text style={styles.rowLabel}>Discover new releases</Text>
        </Animated.View>
        <Animated.View style={[styles.row, row2Style]}>
          <View style={[styles.dot, styles.dotYellow]} />
          <Text style={styles.rowLabel}>Listen in Hi-Res</Text>
        </Animated.View>
        <Animated.View style={[styles.row, row3Style]}>
          <View style={[styles.dot, styles.dotViolet]} />
          <Text style={styles.rowLabel}>Save albums offline</Text>
        </Animated.View>
      </View>

      <View style={styles.spacer} />
      <Pressable accessibilityRole="button" onPress={play} style={styles.button}>
        <Text style={styles.buttonLabel}>Replay</Text>
      </Pressable>
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
    paddingTop: 96
  },
  logo: {
    alignItems: "center",
    backgroundColor: "#6d4aff",
    borderRadius: 28,
    height: 96,
    justifyContent: "center",
    width: 96
  },
  logoGlyph: {
    color: "#ffffff",
    fontSize: 44
  },
  titleBlock: {
    alignItems: "center",
    marginTop: 28
  },
  title: {
    color: "#f4f5f8",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.5,
    textAlign: "center"
  },
  subtitle: {
    color: "#9aa3b5",
    fontSize: 15,
    marginTop: 6,
    textAlign: "center"
  },
  rows: {
    gap: 10,
    marginTop: 36,
    maxWidth: 320,
    width: "100%"
  },
  row: {
    alignItems: "center",
    backgroundColor: "#1b1d24",
    borderColor: "#2a2d38",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 14
  },
  dot: {
    borderRadius: 6,
    height: 12,
    marginRight: 12,
    width: 12
  },
  dotPink: {
    backgroundColor: "#ff5c8a"
  },
  dotYellow: {
    backgroundColor: "#ffd166"
  },
  dotViolet: {
    backgroundColor: "#6d4aff"
  },
  rowLabel: {
    color: "#c5cbd8",
    fontSize: 15,
    fontWeight: "600"
  },
  spacer: {
    flex: 1,
    minHeight: 16
  },
  button: {
    alignItems: "center",
    backgroundColor: "#f4f5f8",
    borderRadius: 27,
    height: 54,
    justifyContent: "center",
    maxWidth: 300,
    width: "100%"
  },
  buttonLabel: {
    color: "#0e0f13",
    fontSize: 16,
    fontWeight: "700"
  }
});
