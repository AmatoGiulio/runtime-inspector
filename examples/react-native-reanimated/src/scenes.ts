import { defineScenes } from "@runtime-inspector/react-native";
import { navigate } from "./router";

defineScenes({
  "product-reveal": {
    title: "Product reveal",
    group: "Store",
    description: "Staggered album entrance",
    open: () => navigate("product"),
    link: "/product"
  },
  "like-burst": {
    title: "Like",
    group: "Store",
    description: "Heart pop with ring and counter",
    open: () => navigate("like"),
    link: "/like"
  },
  "checkout-sheet": {
    title: "Checkout sheet",
    group: "Store",
    description: "Bottom sheet springs open",
    open: () => navigate("sheet"),
    link: "/sheet"
  },
  welcome: {
    title: "Welcome",
    group: "Onboarding",
    description: "Logo, headline and feature rows",
    open: () => navigate("welcome"),
    link: "/welcome"
  },
  "card-transition": {
    title: "Card transition",
    group: "Lab",
    description: "Timing out, spring back",
    open: () => navigate("lab"),
    link: "/lab"
  }
});
