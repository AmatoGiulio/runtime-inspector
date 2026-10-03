import { Pressable, StyleSheet, Text, View } from "react-native";
import { CardTransitionLab } from "./src/CardTransitionLab";
import { CheckoutSheetDemo } from "./src/CheckoutSheetDemo";
import { HomeScreen } from "./src/HomeScreen";
import { LikeBurstDemo } from "./src/LikeBurstDemo";
import { ProductRevealDemo } from "./src/ProductRevealDemo";
import { navigate, useRoute, type Route } from "./src/router";
import { WelcomeDemo } from "./src/WelcomeDemo";

function renderScreen(route: Route) {
  switch (route) {
    case "product":
      return <ProductRevealDemo />;
    case "like":
      return <LikeBurstDemo />;
    case "sheet":
      return <CheckoutSheetDemo />;
    case "welcome":
      return <WelcomeDemo />;
    case "lab":
      return <CardTransitionLab />;
    default:
      return <HomeScreen />;
  }
}

export default function App() {
  const route = useRoute();

  return (
    <View style={styles.root}>
      {renderScreen(route)}
      {route !== "home" ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => navigate("home")}
          style={styles.back}
        >
          <Text style={styles.backLabel}>‹ Scenes</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: "#0e0f13",
    flex: 1
  },
  back: {
    backgroundColor: "#1b1d24",
    borderColor: "#2a2d38",
    borderRadius: 999,
    borderWidth: 1,
    left: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    position: "absolute",
    top: 56
  },
  backLabel: {
    color: "#c5cbd8",
    fontSize: 13,
    fontWeight: "600"
  }
});
