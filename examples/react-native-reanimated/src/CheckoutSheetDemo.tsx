import { useEffect } from "react";
import { Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming
} from "react-native-reanimated";

export function CheckoutSheetDemo() {
  const backdropOpacity = useSharedValue(0);
  const sheetY = useSharedValue(420);
  const contentOpacity = useSharedValue(0);
  const payScale = useSharedValue(0.9);

  // @scene "Checkout sheet" group="Store"
  function play() {
    // Reset closed (plain assignments, not animations).
    backdropOpacity.value = 0;
    sheetY.value = 420;
    contentOpacity.value = 0;
    payScale.value = 0.9;

    backdropOpacity.value = withTiming(0.6, { duration: 240 });
    sheetY.value = withSpring(0, { damping: 18, stiffness: 180 });
    contentOpacity.value = withDelay(140, withTiming(1, { duration: 220 }));
    payScale.value = withDelay(220, withSpring(1, { damping: 12, stiffness: 240 }));
  }

  useEffect(() => {
    play();
    // Run the entrance once on mount; `play` only touches stable shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetY.value }]
  }));

  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value
  }));

  const payStyle = useAnimatedStyle(() => ({
    transform: [{ scale: payScale.value }]
  }));

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={styles.product}>
        <Text style={styles.eyebrow}>YOUR CART</Text>
        <View style={styles.productCard}>
          <View style={styles.productArt} />
          <View style={styles.productInfo}>
            <Text style={styles.productTitle}>Midnight Bloom</Text>
            <Text style={styles.productMeta}>Aurora Lane · Vinyl</Text>
          </View>
          <Text style={styles.productPrice}>$28.00</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={play}>
          <Text style={styles.reopen}>Reopen</Text>
        </Pressable>
      </View>

      <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />

      <Animated.View style={[styles.sheet, sheetStyle]}>
        <View style={styles.handle} />
        <Animated.View style={contentStyle}>
          <Text style={styles.sheetTitle}>Order summary</Text>
          <View style={styles.line}>
            <Text style={styles.lineLabel}>Midnight Bloom</Text>
            <Text style={styles.lineValue}>$28.00</Text>
          </View>
          <View style={styles.line}>
            <Text style={styles.lineLabel}>Shipping</Text>
            <Text style={styles.lineValue}>$4.00</Text>
          </View>
          <View style={styles.line}>
            <Text style={styles.total}>Total</Text>
            <Text style={styles.total}>$32.00</Text>
          </View>
        </Animated.View>
        <Animated.View style={payStyle}>
          <Pressable accessibilityRole="button" style={styles.pay}>
            <Text style={styles.payLabel}>Pay</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#0e0f13",
    flex: 1,
    overflow: "hidden"
  },
  product: {
    paddingHorizontal: 24,
    paddingTop: 64
  },
  eyebrow: {
    color: "#7d8597",
    fontSize: 11,
    letterSpacing: 2,
    marginBottom: 20,
    marginTop: 40
  },
  productCard: {
    alignItems: "center",
    backgroundColor: "#1b1d24",
    borderColor: "#2a2d38",
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row",
    padding: 14
  },
  productArt: {
    backgroundColor: "#6d4aff",
    borderRadius: 14,
    height: 56,
    width: 56
  },
  productInfo: {
    flex: 1,
    marginLeft: 14
  },
  productTitle: {
    color: "#f4f5f8",
    fontSize: 16,
    fontWeight: "700"
  },
  productMeta: {
    color: "#9aa3b5",
    fontSize: 13,
    marginTop: 3
  },
  productPrice: {
    color: "#f4f5f8",
    fontSize: 16,
    fontWeight: "700"
  },
  reopen: {
    color: "#9aa3b5",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 20,
    textAlign: "center"
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000000"
  },
  sheet: {
    backgroundColor: "#1b1d24",
    borderTopColor: "#2a2d38",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingBottom: 44,
    paddingHorizontal: 24,
    paddingTop: 12,
    position: "absolute",
    right: 0
  },
  handle: {
    alignSelf: "center",
    backgroundColor: "#3a3e4c",
    borderRadius: 3,
    height: 5,
    marginBottom: 18,
    width: 40
  },
  sheetTitle: {
    color: "#f4f5f8",
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 14
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8
  },
  lineLabel: {
    color: "#9aa3b5",
    fontSize: 15
  },
  lineValue: {
    color: "#c5cbd8",
    fontSize: 15
  },
  total: {
    color: "#f4f5f8",
    fontSize: 16,
    fontWeight: "700"
  },
  pay: {
    alignItems: "center",
    backgroundColor: "#f4f5f8",
    borderRadius: 27,
    height: 54,
    justifyContent: "center",
    marginTop: 20
  },
  payLabel: {
    color: "#0e0f13",
    fontSize: 16,
    fontWeight: "700"
  }
});
