import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { SceneEntry, SceneOpenState } from "@runtime-inspector/panel-core";

const UNREACHABLE_TITLE = "No link or open() — open this screen in the app first";

export interface ScenesPanelProps {
  scenes: SceneEntry[];
  sceneStatus: Record<string, SceneOpenState>;
  /** The selected row (`currentSceneId`). */
  selectedSceneId?: string;
  thumbnails: Record<string, string>;
  /** The scenes schema is stale: the app is not connected. */
  stale: boolean;
  /** Moves the selection without opening. */
  onSelect(sceneId: string): void;
  /** Selects and opens the scene. */
  onOpen(scene: SceneEntry): void;
}

/** The Scenes navigator (RFC 0006 decision 7): groups, state, thumbnails, keyboard, copy link. */
export function ScenesPanel({
  scenes,
  sceneStatus,
  selectedSceneId,
  thumbnails,
  stale,
  onSelect,
  onOpen
}: ScenesPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedSceneId) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-scene-id="${CSS.escape(selectedSceneId)}"]`
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedSceneId]);

  if (scenes.length === 0) {
    return <div className="empty">No scenes published yet.</div>;
  }

  const groups: Array<{ label: string; scenes: SceneEntry[] }> = [];
  for (const scene of scenes) {
    const last = groups.at(-1);
    if (last && last.label === scene.group) {
      last.scenes.push(scene);
    } else {
      groups.push({ label: scene.group, scenes: [scene] });
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = scenes.findIndex((scene) => scene.id === selectedSceneId);
      const next =
        index === -1
          ? event.key === "ArrowDown"
            ? 0
            : scenes.length - 1
          : Math.min(
              scenes.length - 1,
              Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))
            );
      const scene = scenes[next];
      if (scene) onSelect(scene.id);
      return;
    }
    if (event.key === "Enter") {
      const scene = scenes.find((candidate) => candidate.id === selectedSceneId);
      if (!scene) return;
      event.preventDefault();
      onOpen(scene);
    }
  }

  return (
    <div className="scenes">
      {stale ? <div className="scenes-note">App disconnected</div> : null}
      <div
        ref={listRef}
        className="scenes-list"
        role="listbox"
        aria-label="Scenes"
        tabIndex={0}
        aria-activedescendant={selectedSceneId ? sceneOptionId(selectedSceneId) : undefined}
        onKeyDown={handleKeyDown}
      >
        {groups.map((group, groupIndex) => (
          <div className="scenes-group" role="group" aria-label={group.label} key={`${groupIndex}:${group.label}`}>
            <div className="scenes-group-label" aria-hidden="true">
              {group.label}
            </div>
            {group.scenes.map((scene) => (
              <SceneRow
                key={scene.id}
                scene={scene}
                status={sceneStatus[scene.id]}
                selected={scene.id === selectedSceneId}
                thumbnail={thumbnails[scene.id]}
                onOpen={onOpen}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SceneRow({
  scene,
  status,
  selected,
  thumbnail,
  onOpen
}: {
  scene: SceneEntry;
  status: SceneOpenState | undefined;
  selected: boolean;
  thumbnail: string | undefined;
  onOpen(scene: SceneEntry): void;
}) {
  const opening = status?.phase === "requested" || status?.phase === "navigating";
  const failed = status?.phase === "failed";
  const failureReason = failed ? status?.reason ?? "The scene could not be opened." : undefined;
  const dimmed = !scene.active && !scene.reachable;

  function copyLink(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!scene.url) return;
    try {
      void navigator.clipboard.writeText(scene.url).catch(() => {
        // Clipboard access can be denied; the url stays visible in the button's title.
      });
    } catch {
      // No clipboard API.
    }
  }

  return (
    <div
      id={sceneOptionId(scene.id)}
      data-scene-id={scene.id}
      className={`scene-row${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}`}
      role="option"
      aria-selected={selected}
      title={dimmed ? UNREACHABLE_TITLE : undefined}
      onClick={() => onOpen(scene)}
    >
      <div className="scene-row-main">
        {thumbnail ? (
          <img className="scene-thumb" src={thumbnail} alt="" />
        ) : (
          <span className="scene-thumb placeholder" aria-hidden="true">
            {scene.title.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="scene-copy">
          <span className="scene-title">{scene.title}</span>
          {scene.description ? (
            <span className="scene-description">{scene.description}</span>
          ) : null}
        </span>
        {scene.url ? (
          <button
            type="button"
            className="wb-button toggle scene-copy-link"
            aria-label="Copy link"
            title={scene.url}
            tabIndex={-1}
            onClick={copyLink}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
        <span className="scene-state">
          {opening ? (
            <span className="scene-opening">Opening…</span>
          ) : (
            <>
              {scene.active ? (
                <span className="scene-onscreen" title="On screen" aria-label="On screen" />
              ) : null}
              {failed ? (
                <span className="scene-failed" title={failureReason} aria-label={failureReason}>
                  ⚠
                </span>
              ) : null}
            </>
          )}
        </span>
      </div>
      {selected && failureReason ? <div className="scene-reason">{failureReason}</div> : null}
    </div>
  );
}

function sceneOptionId(sceneId: string): string {
  return `scene-option-${sceneId}`;
}
