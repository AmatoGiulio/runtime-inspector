import { Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming
} from "react-native-reanimated";
import { useScene } from "@runtime-inspector/react-native";

export function LikeBurstDemo() {
  const heartScale = useSharedValue(0.6);
  const ringScale = useSharedValue(0.6);
  const ringOpacity = useSharedValue(0);
  const countY = useSharedValue(16);
  const countOpacity = useSharedValue(0);

  const play = useScene("like-burst", () => {
    // Reset to the starting pose (plain assignments, not animations).
    heartScale.value = 0.6;
    ringScale.value = 0.6;
    ringOpacity.value = 0.8;
    countY.value = 16;
    countOpacity.value = 0;

    heartScale.value = withSpring(1, { damping: 8, stiffness: 260 });
    ringScale.value = withTiming(1.6, { duration: 420 });
    ringOpacity.value = withDelay(120, withTiming(0, { duration: 300 }));
    countY.value = withDelay(80, withSpring(0, { damping: 14, stiffness: 200 }));
    countOpacity.value = withTiming(1, { duration: 200 });
  });

  const heartStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }]
  }));

  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacity.value,
    transform: [{ scale: ringScale.value }]
  }));

  const countStyle = useAnimatedStyle(() => ({
    opacity: countOpacity.value,
    transform: [{ translateY: countY.value }]
  }));

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={styles.center}>
        <Animated.Text style={[styles.count, countStyle]}>+1</Animated.Text>
        <Pressable accessibilityRole="button" onPress={play} style={styles.heartWrap}>
          <Animated.View style={[styles.ring, ringStyle]} />
          <Animated.View style={[styles.heart, heartStyle]}>
            <Text style={styles.heartGlyph}>♥</Text>
          </Animated.View>
        </Pressable>
        <Text style={styles.caption}>Tap the heart to replay</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#0e0f13",
    flex: 1,
    paddingBottom: 36,
    paddingHorizontal: 24,
    paddingTop: 64
  },
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center"
  },
  count: {
    color: "#ff5c8a",
    fontSize: 22,
    fontWeight: "800",
    marginBottom: 20
  },
  heartWrap: {
    alignItems: "center",
    height: 140,
    justifyContent: "center",
    width: 140
  },
  ring: {
    borderColor: "#ff5c8a",
    borderRadius: 70,
    borderWidth: 3,
    height: 140,
    position: "absolute",
    width: 140
  },
  heart: {
    alignItems: "center",
    backgroundColor: "#1b1d24",
    borderColor: "#2a2d38",
    borderRadius: 48,
    borderWidth: 1,
    height: 96,
    justifyContent: "center",
    width: 96
  },
  heartGlyph: {
    color: "#ff5c8a",
    fontSize: 48,
    lineHeight: 56
  },
  caption: {
    color: "#5c6373",
    fontSize: 11,
    marginTop: 28
  }
});
