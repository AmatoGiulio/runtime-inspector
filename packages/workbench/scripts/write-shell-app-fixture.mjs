import fs from "node:fs/promises";
import path from "node:path";
import { generateShellFiles } from "../electron/shell-export.mjs";

// Fixture consumed by the SDK-55 Metro bundle smoke test in CI.
const project = {
  name: "Shell Studio Smoke",
  screens: [
    { id: "home", title: "Home", kind: "tab", icon: "house", header: "large", action: "add", linkTo: "detail" },
    { id: "search", title: "Search", kind: "tab", icon: "magnifyingglass", header: "inline", action: "search", linkTo: "sheet" },
    { id: "detail", title: "Detail", kind: "page", icon: "square", header: "inline", action: "more", linkTo: "sheet" },
    { id: "sheet", title: "Sheet", kind: "modal", icon: "plus", header: "inline", action: "none" }
  ]
};
const root = path.join(process.env.RUNNER_TEMP || "/tmp", "ri-shell-studio-smoke");
for (const [relative, content] of Object.entries(generateShellFiles(project))) {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}
