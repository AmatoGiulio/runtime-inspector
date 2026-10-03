import { Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { navigate, type Route } from "./router";

interface SceneRow {
  title: string;
  description: string;
  route: Route;
}

const SECTIONS: { group: string; rows: SceneRow[] }[] = [
  {
    group: "Store",
    rows: [
      { title: "Product reveal", description: "Staggered album entrance", route: "product" },
      { title: "Like", description: "Heart pop with ring and counter", route: "like" },
      { title: "Checkout sheet", description: "Bottom sheet springs open", route: "sheet" }
    ]
  },
  {
    group: "Onboarding",
    rows: [{ title: "Welcome", description: "Logo, headline and feature rows", route: "welcome" }]
  },
  {
    group: "Lab",
    rows: [{ title: "Card transition", description: "Timing out, spring back", route: "lab" }]
  }
];

export function HomeScreen() {
  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Motion scenes</Text>
        {SECTIONS.map((section) => (
          <View key={section.group} style={styles.section}>
            <Text style={styles.groupHeader}>{section.group.toUpperCase()}</Text>
            {section.rows.map((row) => (
              <Pressable
                key={row.route}
                accessibilityRole="button"
                onPress={() => navigate(row.route)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Text style={styles.rowTitle}>{row.title}</Text>
                <Text style={styles.rowDescription}>{row.description}</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#0e0f13",
    flex: 1
  },
  content: {
    paddingBottom: 36,
    paddingHorizontal: 24,
    paddingTop: 64
  },
  title: {
    color: "#f4f5f8",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginBottom: 12
  },
  section: {
    marginTop: 20
  },
  groupHeader: {
    color: "#7d8597",
    fontSize: 11,
    letterSpacing: 2,
    marginBottom: 10
  },
  row: {
    backgroundColor: "#1b1d24",
    borderColor: "#2a2d38",
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 14
  },
  rowPressed: {
    opacity: 0.7
  },
  rowTitle: {
    color: "#f4f5f8",
    fontSize: 16,
    fontWeight: "700"
  },
  rowDescription: {
    color: "#9aa3b5",
    fontSize: 13,
    marginTop: 3
  }
});
