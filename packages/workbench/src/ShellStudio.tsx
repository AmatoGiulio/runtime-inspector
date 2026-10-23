import { useEffect, useState } from "react";
import "./shell-studio.css";

export type ShellKind = "tab" | "page" | "modal";
export type ShellHeader = "large" | "inline" | "hidden";
export type ShellAction = "none" | "add" | "search" | "more";

export interface ShellScreen {
  id: string;
  title: string;
  kind: ShellKind;
  icon: string;
  header: ShellHeader;
  action: ShellAction;
  linkTo?: string;
}

export interface ShellProject {
  name: string;
  screens: ShellScreen[];
}

const STORAGE_KEY = "ri.shell-studio.project.v0";
const DEFAULT_PROJECT: ShellProject = {
  name: "Untitled iOS App",
  screens: [
    { id: "home", title: "Home", kind: "tab", icon: "house", header: "large", action: "add", linkTo: "details" },
    { id: "explore", title: "Explore", kind: "tab", icon: "safari", header: "inline", action: "search" },
    { id: "profile", title: "Profile", kind: "tab", icon: "person.crop.circle", header: "inline", action: "more" },
    { id: "details", title: "Details", kind: "page", icon: "square", header: "inline", action: "none" },
    { id: "compose", title: "Compose", kind: "modal", icon: "plus", header: "inline", action: "none" }
  ]
};

const SYMBOLS = [
  ["house", "Home"],
  ["safari", "Explore"],
  ["magnifyingglass", "Search"],
  ["heart", "Favorites"],
  ["bookmark", "Saved"],
  ["person.crop.circle", "Profile"],
  ["square.grid.2x2", "Grid"],
  ["tray", "Inbox"],
  ["gearshape", "Settings"],
  ["music.note", "Music"],
  ["plus", "Add"],
  ["square", "Generic"]
];

const titleForKind: Record<ShellKind, string> = {
  tab: "Tab",
  page: "Page",
  modal: "Sheet"
};

function restoreProject(): ShellProject {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PROJECT;
    const parsed: unknown = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed === "object" &&
      "name" in parsed &&
      typeof parsed.name === "string" &&
      "screens" in parsed &&
      Array.isArray(parsed.screens) &&
      parsed.screens.length > 0
    ) return parsed as ShellProject;
  } catch {
    // Storage may be blocked in a browser preview.
  }
  return DEFAULT_PROJECT;
}

function uniqueId(project: ShellProject, kind: ShellKind): string {
  const ids = new Set(project.screens.map((screen) => screen.id));
  const base = kind === "tab" ? "tab" : kind === "modal" ? "sheet" : "page";
  let number = 1;
  while (ids.has(base + "-" + number)) number += 1;
  return base + "-" + number;
}

export function useShellStudioState() {
  const [project, setProject] = useState<ShellProject>(restoreProject);
  const [selectedId, setSelectedId] = useState("home");
  const [notice, setNotice] = useState("Export a project, then run pnpm ios to see it in the live simulator.");
  const [exporting, setExporting] = useState(false);
  const [previewDirectory, setPreviewDirectory] = useState<string>();
  const [syncError, setSyncError] = useState<string>();
  const selected = project.screens.find((screen) => screen.id === selectedId) ?? project.screens[0];

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch {
      // The editor remains usable without persistence.
    }
  }, [project]);

  useEffect(() => {
    if (!window.runtimeDesktop?.syncShellProject) return;
    const desktop = window.runtimeDesktop;
    let disposed = false;
    const timer = setTimeout(() => {
      void desktop.syncShellProject(project).then((result) => {
        if (disposed) return;
        setPreviewDirectory(result.directory);
        setSyncError(undefined);
      }).catch((error: unknown) => {
        if (!disposed) setSyncError(error instanceof Error ? error.message : "Preview sync failed.");
      });
    }, 650);
    return () => { disposed = true; clearTimeout(timer); };
  }, [project]);

  function updateScreen(id: string, patch: Partial<ShellScreen>) {
    setProject((current) => ({
      ...current,
      screens: current.screens.map((screen) => screen.id === id ? { ...screen, ...patch } : screen)
    }));
  }

  function addScreen(kind: ShellKind) {
    const tabs = project.screens.filter((screen) => screen.kind === "tab").length;
    if (project.screens.length >= 16 || (kind === "tab" && tabs >= 5)) {
      setNotice("Limit: 16 screens overall, maximum 5 native tabs.");
      return;
    }
    const id = uniqueId(project, kind);
    const screen: ShellScreen = {
      id,
      title: titleForKind[kind] + " " + (project.screens.length + 1),
      kind,
      header: "inline",
      action: "none",
      icon: kind === "tab" ? "square.grid.2x2" : "square"
    };
    setProject((current) => ({ ...current, screens: [...current.screens, screen] }));
    setSelectedId(id);
    setNotice("Added " + screen.title + ".");
  }

  function removeScreen(id: string) {
    const target = project.screens.find((screen) => screen.id === id);
    if (!target) return;
    if (target.kind === "tab" && project.screens.filter((screen) => screen.kind === "tab").length === 1) {
      setNotice("Keep at least one native tab.");
      return;
    }
    const remaining = project.screens
      .filter((screen) => screen.id !== id)
      .map((screen) => screen.linkTo === id ? { ...screen, linkTo: undefined } : screen);
    setProject((current) => ({ ...current, screens: remaining }));
    if (selectedId === id) setSelectedId(remaining[0].id);
  }

  function moveTab(id: string, delta: number) {
    setProject((current) => {
      const source = current.screens.findIndex((screen) => screen.id === id);
      if (source < 0) return current;
      const tabs = current.screens.filter((screen) => screen.kind === "tab");
      const oldTabIndex = tabs.findIndex((screen) => screen.id === id);
      const newTabIndex = oldTabIndex + delta;
      if (newTabIndex < 0 || newTabIndex >= tabs.length) return current;
      const [item] = tabs.splice(oldTabIndex, 1);
      tabs.splice(newTabIndex, 0, item);
      let n = 0;
      return {
        ...current,
        screens: current.screens.map((screen) => screen.kind === "tab" ? tabs[n++] : screen)
      };
    });
  }

  async function exportProject() {
    const desktop = window.runtimeDesktop;
    if (!desktop?.exportShellProject) {
      setNotice("Export is available in the macOS Electron Workbench.");
      return;
    }
    setExporting(true);
    try {
      const result = await desktop.exportShellProject(project);
      if (result) setNotice("Exported " + result.fileCount + " files to " + result.directory);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not export the project.");
    } finally {
      setExporting(false);
    }
  }

  async function repairExportedProject() {
    const desktop = window.runtimeDesktop;
    if (!desktop?.repairShellProject) return;
    try {
      const repaired = await desktop.repairShellProject();
      if (!repaired) return;
      const repairStatus = repaired.repaired ? "Updated native tabs import." : "Native tabs import already correct.";
      const depsStatus = repaired.installedRouter
        ? "Installed expo-router: " + repaired.installedRouter + "."
        : "No local Expo Router install found: run pnpm install in that app.";
      const importStatus = repaired.installedRouter && !repaired.nativeTabsAvailable
        ? " The installed package does not expose the expected native-tabs file. Reinstall compatible dependencies in that app."
        : "";
      setNotice(repairStatus + " " + depsStatus + importStatus + " Folder: " + repaired.directory);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not repair the exported app.");
    }
  }

  function copyPreviewCommand() {
    if (!previewDirectory) return;
    const command = "cd " + JSON.stringify(previewDirectory) + " && pnpm install && pnpm exec expo install --fix && pnpm ios";
    void navigator.clipboard.writeText(command).then(() => setNotice("Terminal launch command copied. Run it once; subsequent edits sync into the project.")).catch(() => setNotice(command));
  }

  return { project, setProject, selected, selectedId, setSelectedId, notice, exporting, previewDirectory, syncError, copyPreviewCommand, repairExportedProject,
    addScreen, updateScreen, removeScreen, moveTab, exportProject };
}

export type ShellStudioState = ReturnType<typeof useShellStudioState>;

export function ShellStudioSidebar({ studio }: { studio: ShellStudioState }) {
  const tabs = studio.project.screens.filter((screen) => screen.kind === "tab");
  const screens = studio.project.screens.filter((screen) => screen.kind !== "tab");
  return (
    <div className="studio-sidebar">
      <div className="studio-sidebar-head">
        <strong>Structure</strong>
        <small>{studio.project.screens.length} screens</small>
      </div>
      <div className="studio-pages">
        <div className="studio-group-head">
          <span>Native Tabs</span>
          <button title="Add native tab" onClick={() => studio.addScreen("tab")}>+</button>
        </div>
        {tabs.map((screen, index) => (
          <div key={screen.id} className={"studio-page" + (studio.selectedId === screen.id ? " active" : "")}>
            <button className="studio-page-title" onClick={() => studio.setSelectedId(screen.id)}>
              <span className="studio-page-glyph">▦</span><span>{screen.title}</span>
            </button>
            <button className="studio-mini" title="Move up" disabled={index === 0} onClick={() => studio.moveTab(screen.id, -1)}>↑</button>
            <button className="studio-mini" title="Move down" disabled={index === tabs.length - 1} onClick={() => studio.moveTab(screen.id, 1)}>↓</button>
          </div>
        ))}
        <div className="studio-group-head">
          <span>Stack & Sheets</span>
          <span className="studio-group-add">
            <button title="Add stack page" onClick={() => studio.addScreen("page")}>+ Page</button>
            <button title="Add modal sheet" onClick={() => studio.addScreen("modal")}>+ Sheet</button>
          </span>
        </div>
        {screens.map((screen) => (
          <div key={screen.id} className={"studio-page" + (studio.selectedId === screen.id ? " active" : "")}>
            <button className="studio-page-title" onClick={() => studio.setSelectedId(screen.id)}>
              <span className="studio-page-glyph">{screen.kind === "modal" ? "▢" : "↳"}</span>
              <span>{screen.title}</span>
            </button>
            <span className="studio-kind">{screen.kind === "modal" ? "sheet" : "push"}</span>
          </div>
        ))}
      </div>
      <div className="studio-sidebar-bottom">
        <button className="wb-button primary studio-export" disabled={studio.exporting} onClick={studio.exportProject}>
          {studio.exporting ? "Exporting…" : "Export Expo project…"}
        </button>
        {studio.previewDirectory ? (
          <>
            <div className="studio-preview-path" title={studio.previewDirectory}>Live preview · {studio.previewDirectory}</div>
            <button className="wb-button secondary studio-preview-command" title={studio.previewDirectory} onClick={studio.copyPreviewCommand}>Copy preview launch command</button>
          </>
        ) : null}
        <button className="wb-button secondary studio-preview-command" onClick={studio.repairExportedProject}>Repair exported Shell Studio app…</button>
        {studio.syncError ? <p className="studio-notice studio-error" role="alert">{studio.syncError}</p> : null}
        <p className="studio-notice" role="status">{studio.notice}</p>
      </div>
    </div>
  );
}

export function ShellStudioInspector({ studio }: { studio: ShellStudioState }) {
  const selected = studio.selected;
  if (!selected) return <div className="panel-title">Shell Inspector</div>;
  const screens = studio.project.screens;
  return (
    <div className="studio-inspector">
      <div className="panel-title">Shell Inspector</div>
      <div className="studio-fields">
        <div className="studio-section-title">Project</div>
        <label>App name
          <input value={studio.project.name} maxLength={60} onChange={(event) =>
            studio.setProject((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <div className="studio-section-title">Selected screen</div>
        <label>Title
          <input value={selected.title} maxLength={80} onChange={(event) =>
            studio.updateScreen(selected.id, { title: event.target.value })} />
        </label>
        <div className="studio-field-readonly">Route <code>{selected.kind === "tab" ? "/(tabs)/" : "/"}{selected.id}</code></div>
        <div className="studio-field-readonly">Presentation <strong>{selected.kind === "modal" ? "Native sheet" : selected.kind === "tab" ? "Native tab" : "Stack push"}</strong></div>
        <label>Navigation bar
          <select value={selected.header} onChange={(event) =>
            studio.updateScreen(selected.id, { header: event.target.value as ShellHeader })}>
            <option value="large">Large title</option>
            <option value="inline">Inline title</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
        <label>Trailing toolbar button
          <select value={selected.action} onChange={(event) =>
            studio.updateScreen(selected.id, { action: event.target.value as ShellAction })}>
            <option value="none">None</option>
            <option value="add">Add (+)</option>
            <option value="search">Search</option>
            <option value="more">More (…)</option>
          </select>
        </label>
        {selected.kind === "tab" ? (
          <label>SF Symbol
            <select value={selected.icon} onChange={(event) =>
              studio.updateScreen(selected.id, { icon: event.target.value })}>
              {SYMBOLS.map(([symbol, name]) =>
                <option key={symbol} value={symbol}>{name} · {symbol}</option>)}
            </select>
          </label>
        ) : null}
        <div className="studio-section-title">Navigation</div>
        <label>Open screen when tapped
          <select value={selected.linkTo ?? ""} onChange={(event) =>
            studio.updateScreen(selected.id, { linkTo: event.target.value || undefined })}>
            <option value="">Not connected</option>
            {screens.filter((screen) => screen.id !== selected.id).map((screen) =>
              <option key={screen.id} value={screen.id}>{screen.title} ({screen.kind})</option>)}
          </select>
        </label>
        <button className="wb-button secondary studio-delete" onClick={() => studio.removeScreen(selected.id)}>
          Delete screen
        </button>
      </div>
      <div className="studio-inspector-note">
        The center viewport shows the real iOS Simulator, not an HTML mockup. Export and launch the generated app to preview it.
      </div>
    </div>
  );
}
