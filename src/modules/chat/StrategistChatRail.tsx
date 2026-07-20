// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// UX citation: docs/architecture/ADR-004-chat-rail.md

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type {
  ChannelDefinition,
  ChatProject,
  ChatRunEvent,
  ChatRunPhase,
  ContextBudget,
  ContextMemoryState,
  ConversationMessage,
  ConversationThread,
} from "../../core/contracts";
import { ContextMemoryPanel } from "./ContextMemoryPanel";
import { MessageContent } from "./MessageContent";
import {
  ArchiveIcon,
  BranchIcon,
  CheckIcon,
  CopyIcon,
  DetachIcon,
  EditIcon,
  HideIcon,
  HistoryIcon,
  MicIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SendIcon,
  StatsIcon,
  StopIcon,
  TrashIcon,
} from "./icons";
import type { ComposerAttachment, ThinkingDepth } from "./types";
import type { CompactMemoryPatch } from "./thread-controller";
import { formatBytes } from "./utils";

const modelLabel = (model: string): string => {
  const labels: Record<string, string> = {
    "MiniMax-M3": "MiniMax M3",
    "zai/glm-5.2": "Z.AI GLM 5.2",
    "gpt-5.5": "GPT 5.5",
    "gpt-5.4-mini": "GPT 5.4 Mini",
    "batiai/gemma4-e2b:q4": "Gemma 4 2B (Mac Mini)",
    "Qwen3.6-35B-A3B-Q4_K_M.gguf": "Qwen 3.6 35B (GX10)",
  };
  return labels[model] ?? model;
};

const supportsThinkingDepth = (model: string): boolean => model.startsWith("gpt-5.");

type StrategistChatRailProps = {
  isOpen: boolean;
  showCollapsedToggle?: boolean;
  mode: "strategist" | "emergency";
  title: string;
  eyebrow: string;
  description: string;
  activeThread: ConversationThread | null;
  strategistThreads: ConversationThread[];
  chatProjects: ChatProject[];
  pinnedThreadIds: string[];
  pinnedProjectIds: string[];
  availableAgents: Array<{
    id: string;
    displayName: string;
    shortLabel: string;
  }>;
  activeAgentId: string;
  channels: ChannelDefinition[];
  chatBusy: boolean;
  chatCanStop: boolean;
  chatSupportsAbort: boolean;
  chatRunPhase: ChatRunPhase;
  chatRunEvents: ChatRunEvent[];
  chatNotice: string | null;
  composer: string;
  attachments: ComposerAttachment[];
  dictating: boolean;
  dictationAvailable: boolean;
  activeChatModel: string;
  availableModels: string[];
  thinkingDepth: ThinkingDepth;
  contextUsageLabel: string;
  contextUsageRatio: number;
  contextUsageTitle: string;
  contextBudget: ContextBudget;
  compactState: ContextMemoryState | null;
  historyOpen: boolean;
  activityLabel: string;
  recoveryRuntimeStatus?: {
    activeRouteLabel: string;
    activeModel: string;
    targetModel: string;
    available: boolean;
    installed: boolean;
    running: boolean;
    runningModels: string[];
  } | null;
  chatScrollAnchorRef: RefObject<HTMLDivElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onCreateNewChat: (agentId: string, projectId?: string) => void;
  onCreateProject: (title: string) => void;
  onSetHistoryOpen: (open: boolean) => void;
  onToggleSidebar: () => void;
  onSetActiveThread: (threadId: string) => void;
  onTogglePinnedThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onMoveThreadToProject: (threadId: string, projectId: string | null) => void;
  onDeleteThread: (threadId: string) => void;
  onBranchThread: (threadId: string) => void;
  onTogglePinnedProject: (projectId: string) => void;
  onRenameProject: (projectId: string, title: string) => void;
  onDeleteProject: (projectId: string) => void;
  onBranchProject: (projectId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onStopGeneration: () => void;
  onCompactThread: () => void;
  onUpdateCompactMemory: (patch: CompactMemoryPatch) => void;
  onSaveMessageToArchive: (message: ConversationMessage) => void;
  onBranchFromMessage: (message: ConversationMessage) => void;
  onEditUserMessage: (message: ConversationMessage) => void;
  onDeleteMessage: (message: ConversationMessage) => void;
  onToggleDictation: () => void;
  onModelChange: (value: string) => void;
  onThinkingDepthChange: (value: ThinkingDepth) => void;
  onFileAttach: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachmentId: string) => void;
  onStartResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDetachChat?: () => void;
};

export function StrategistChatRail(props: StrategistChatRailProps) {
  const [openThreadMenuId, setOpenThreadMenuId] = useState<string | null>(null);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const [agentPicker, setAgentPicker] = useState<{ projectId?: string } | null>(null);
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<number | null>(null);
  const [activityNow, setActivityNow] = useState(Date.now());
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.chatBusy) {
      setActiveRunStartedAt(null);
      return;
    }

    setActiveRunStartedAt((current) => current ?? Date.now());
    const timer = window.setInterval(() => setActivityNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.chatBusy]);

  useEffect(() => {
    if (!copiedMessageId) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopiedMessageId((current) => (current === copiedMessageId ? null : current));
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [copiedMessageId]);

  const copyMessage = async (message: ConversationMessage) => {
    if (!navigator.clipboard?.writeText) {
      return;
    }

    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
  };
  const formatElapsed = (startedAt: number | null): string => {
    if (!startedAt) {
      return "just now";
    }
    const totalSeconds = Math.max(0, Math.floor((activityNow - startedAt) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) {
      return `${seconds}s`;
    }
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  };
  const phaseLabel = (phase: ChatRunPhase): string => {
    switch (phase) {
      case "retrieving":
        return "Reading context";
      case "streaming":
        return "Writing response";
      case "tool-running":
        return "Running tools";
      case "thinking":
        return "Thinking";
      case "interrupted":
        return "Interrupted";
      case "failed":
        return "Failed";
      case "completed":
        return "Completed";
      case "idle":
      default:
        return "Standing by";
    }
  };
  const eventPhaseLabel = (event: ChatRunEvent): string => {
    switch (event.phase) {
      case "retrieving":
        return "Read";
      case "streaming":
        return "Write";
      case "tool-running":
        return "Tool";
      case "command":
        return "Command";
      case "search":
        return "Search";
      case "completed":
        return "Done";
      case "failed":
        return "Failed";
      case "interrupted":
        return "Stopped";
      case "thinking":
      default:
        return "Think";
    }
  };
  const threadUpdatedAt = (thread: ConversationThread): number => {
    const lastMessage = thread.messages.at(-1);
    return lastMessage ? Date.parse(lastMessage.createdAt) || 0 : 0;
  };
  const threadAgeLabel = (thread: ConversationThread): string => {
    const updatedAt = threadUpdatedAt(thread);
    if (!updatedAt) {
      return "";
    }
    const elapsedMs = Math.max(0, Date.now() - updatedAt);
    const elapsedDays = Math.floor(elapsedMs / 86_400_000);
    if (elapsedDays > 0) {
      return `${elapsedDays}d`;
    }
    const elapsedHours = Math.floor(elapsedMs / 3_600_000);
    if (elapsedHours > 0) {
      return `${elapsedHours}h`;
    }
    return "now";
  };
  const generationStatsTitle = (message: ConversationMessage): string => {
    const usage = message.providerUsage;
    if (usage?.source !== "local-runtime") {
      return "Generation stats are shown only for local-runtime messages with telemetry.";
    }

    const lines = [`Local runtime: ${usage.model}`];
    if (typeof usage.tokensPerSecond === "number") {
      lines.push(`Completion TPS: ${usage.tokensPerSecond.toFixed(1)}`);
    } else {
      lines.push("Completion TPS: unavailable");
    }
    if (typeof usage.completionTokens === "number") {
      lines.push(`Completion tokens: ${usage.completionTokens.toLocaleString()}`);
    }
    if (typeof usage.promptTokens === "number") {
      lines.push(`Prompt tokens: ${usage.promptTokens.toLocaleString()}`);
    }
    if (typeof usage.totalTokens === "number") {
      lines.push(`Total tokens: ${usage.totalTokens.toLocaleString()}`);
    }
    if (typeof usage.durationMs === "number") {
      lines.push(`Completion duration: ${(usage.durationMs / 1000).toFixed(2)}s`);
    }
    return lines.join("\n");
  };
  const pinnedThreadIds = new Set(props.pinnedThreadIds);
  const pinnedProjectIds = new Set(props.pinnedProjectIds);
  const sortedThreads = [...props.strategistThreads].sort((left, right) => threadUpdatedAt(right) - threadUpdatedAt(left));
  const pinnedThreads = sortedThreads.filter((thread) => pinnedThreadIds.has(thread.id) && !thread.projectId);
  const unprojectedThreads = sortedThreads.filter((thread) => !thread.projectId && !pinnedThreadIds.has(thread.id));
  const sortedProjects = [...props.chatProjects].sort((left, right) => {
    const leftPinned = pinnedProjectIds.has(left.id) || left.pinned;
    const rightPinned = pinnedProjectIds.has(right.id) || right.pinned;
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }
    return (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
  });
  const submitProject = () => {
    const title = projectDraft.trim();
    if (!title) {
      return;
    }
    props.onCreateProject(title);
    setProjectDraft("");
    setProjectComposerOpen(false);
  };
  const openAgentPicker = (projectId?: string) => {
    setAgentPicker({ projectId });
  };
  const createChatForAgent = (agentId: string) => {
    props.onCreateNewChat(agentId, agentPicker?.projectId);
    setAgentPicker(null);
  };
  const renderThreadOptionsMenu = (thread: ConversationThread, isPinned: boolean) => (
    <div className="chat-history-menu" role="menu">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          props.onTogglePinnedThread(thread.id);
          setOpenThreadMenuId(null);
        }}
      >
        <PinIcon />
        {isPinned ? "Unpin" : "Pin"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          const title = window.prompt("Rename chat", thread.title);
          if (title?.trim()) {
            props.onRenameThread(thread.id, title);
          }
          setOpenThreadMenuId(null);
        }}
      >
        <EditIcon />
        Rename
      </button>
      {thread.projectId ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            props.onMoveThreadToProject(thread.id, null);
            setOpenThreadMenuId(null);
          }}
        >
          <HistoryIcon />
          Move to Chats
        </button>
      ) : null}
      {props.chatProjects.map((project) =>
        project.id === thread.projectId ? null : (
          <button
            key={project.id}
            type="button"
            role="menuitem"
            onClick={() => {
              props.onMoveThreadToProject(thread.id, project.id);
              setOpenThreadMenuId(null);
            }}
          >
            <HistoryIcon />
            Move to {project.title}
          </button>
        ),
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          props.onBranchThread(thread.id);
          setOpenThreadMenuId(null);
        }}
      >
        <BranchIcon />
        Branch
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          props.onDeleteThread(thread.id);
          setOpenThreadMenuId(null);
        }}
      >
        <TrashIcon />
        Delete
      </button>
    </div>
  );
  const renderHistoryThread = (thread: ConversationThread) => {
    const channel = props.channels.find((item) => item.id === thread.channelId);
    const isPinned = pinnedThreadIds.has(thread.id);
    const agent = props.availableAgents.find((item) => item.id === thread.owningAgentId);

    return (
      <div key={thread.id} className={`chat-history-row ${props.activeThread?.id === thread.id ? "active" : ""}`}>
        <button type="button" className="chat-history-thread" onClick={() => props.onSetActiveThread(thread.id)}>
          <strong>{thread.title}</strong>
          <span>
            {agent?.displayName ?? channel?.label ?? thread.channelId}
            {threadAgeLabel(thread) ? ` · ${threadAgeLabel(thread)}` : ""}
          </span>
        </button>
        <div className="chat-history-menu-anchor">
          <button
            type="button"
            className="chat-history-menu-trigger"
            aria-label="Chat options"
            title="Chat options"
            onClick={() => setOpenThreadMenuId((current) => (current === thread.id ? null : thread.id))}
          >
            <MoreIcon />
          </button>
          {openThreadMenuId === thread.id && renderThreadOptionsMenu(thread, isPinned)}
        </div>
      </div>
    );
  };
  const renderProject = (project: ChatProject) => {
    const projectThreads = sortedThreads.filter((thread) => thread.projectId === project.id);
    const isPinned = pinnedProjectIds.has(project.id) || project.pinned;

    return (
      <div key={project.id} className={`chat-project-group ${isPinned ? "pinned" : ""}`}>
        <div className="chat-project-head">
          <HistoryIcon />
          <strong>{project.title}</strong>
          <small>{projectThreads.length}</small>
          <button
            type="button"
            className="chat-project-add"
            aria-label={`New chat in ${project.title}`}
            title={`New chat in ${project.title}`}
            onClick={() => openAgentPicker(project.id)}
          >
            <PlusIcon />
          </button>
          <div className="chat-history-menu-anchor">
            <button
              type="button"
              className="chat-history-menu-trigger"
              aria-label="Project options"
              title="Project options"
              onClick={() => setOpenProjectMenuId((current) => (current === project.id ? null : project.id))}
            >
              <MoreIcon />
            </button>
            {openProjectMenuId === project.id && (
              <div className="chat-history-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onTogglePinnedProject(project.id);
                    setOpenProjectMenuId(null);
                  }}
                >
                  <PinIcon />
                  {isPinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const title = window.prompt("Rename project", project.title);
                    if (title?.trim()) {
                      props.onRenameProject(project.id, title);
                    }
                    setOpenProjectMenuId(null);
                  }}
                >
                  <EditIcon />
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onBranchProject(project.id);
                    setOpenProjectMenuId(null);
                  }}
                >
                  <BranchIcon />
                  Branch
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onDeleteProject(project.id);
                    setOpenProjectMenuId(null);
                  }}
                >
                  <TrashIcon />
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="chat-project-thread-list">
          {projectThreads.length > 0 ? projectThreads.map(renderHistoryThread) : <p className="chat-history-empty">No chats yet.</p>}
        </div>
      </div>
    );
  };

  if (!props.isOpen) {
    if (props.showCollapsedToggle === false) {
      return null;
    }
    return (
      <aside className={`chat-sidebar closed ${props.mode === "emergency" ? "emergency" : ""}`}>
        <button type="button" className="chat-collapsed-toggle" onClick={props.onToggleSidebar}>
          Chat
        </button>
      </aside>
    );
  }

  return (
    <aside className={`chat-sidebar open ${props.mode === "emergency" ? "emergency" : ""}`}>
      <div className="chat-resize-handle" role="separator" aria-label="Resize chat rail" onPointerDown={props.onStartResize} />
      <div className="chat-agent-strip" aria-label="Agent selector">
        {props.availableAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`chat-agent-chip ${props.activeAgentId === agent.id ? "active" : ""}`}
            aria-label={`Talk with ${agent.displayName}`}
            title={agent.displayName}
            onClick={() => props.onSelectAgent(agent.id)}
          >
            {agent.shortLabel}
          </button>
        ))}
      </div>
      <div className="chat-sidebar-header">
        <div className="chat-header-actions">
          <button
            type="button"
            className={`chat-icon-button ${props.historyOpen ? "active" : ""}`}
            aria-label={props.historyOpen ? "Hide chat history" : "Show chat history"}
            title={props.historyOpen ? "Hide chat history" : "Show chat history"}
            onClick={() => props.onSetHistoryOpen(!props.historyOpen)}
          >
            <HistoryIcon />
          </button>
          {props.mode !== "emergency" && (
            <button type="button" className="chat-icon-button prominent" aria-label="New chat" title="New chat" onClick={() => openAgentPicker()}>
              <PlusIcon />
            </button>
          )}
          {props.mode !== "emergency" && props.onDetachChat && (
            <button type="button" className="chat-icon-button" aria-label="Detach chat window" title="Detach chat window" onClick={props.onDetachChat}>
              <DetachIcon />
            </button>
          )}
          {props.activeThread && !props.historyOpen && (
            <div className="chat-history-menu-anchor">
              <button
                type="button"
                className="chat-icon-button"
                aria-label="Chat options"
                title="Chat options"
                onClick={() => setOpenThreadMenuId((current) => (current === props.activeThread?.id ? null : props.activeThread?.id ?? null))}
              >
                <MoreIcon />
              </button>
              {openThreadMenuId === props.activeThread.id && renderThreadOptionsMenu(props.activeThread, pinnedThreadIds.has(props.activeThread.id))}
            </div>
          )}
          <button type="button" className="chat-icon-button" aria-label="Hide chat rail" title="Hide chat rail" onClick={props.onToggleSidebar}>
            <HideIcon />
          </button>
        </div>
      </div>

      {props.mode === "emergency" && (
        <>
          <div className="recovery-playbook">
            <div className="recovery-step">
              <strong>Recovery chat</strong>
              <span>Use the center dashboard for route candidates, checklist state, diagnostics, and the recovery log.</span>
            </div>
            <div className="recovery-step">
              <strong>Current route</strong>
              <span>
                {props.recoveryRuntimeStatus
                  ? `${props.recoveryRuntimeStatus.activeModel} via ${props.recoveryRuntimeStatus.activeRouteLabel}`
                  : "Awaiting recovery runtime status"}
              </span>
            </div>
          </div>
        </>
      )}

      {props.chatBusy && (
        <div className="agent-activity-rail live" aria-live="polite">
          <span className="agent-activity-pulse" />
          <div>
            <strong>Working</strong>
            <p>{props.activityLabel}</p>
          </div>
        </div>
      )}

      {agentPicker && (
        <div className="chat-agent-picker" role="dialog" aria-label="Choose agent for new chat">
          <div>
            <strong>New chat</strong>
            <span>{agentPicker.projectId ? "Choose the agent for this project chat." : "Choose the agent for this chat."}</span>
          </div>
          <div className="chat-agent-picker-grid">
            {props.availableAgents.map((agent) => (
              <button key={agent.id} type="button" onClick={() => createChatForAgent(agent.id)}>
                <span>{agent.shortLabel}</span>
                <strong>{agent.displayName}</strong>
              </button>
            ))}
          </div>
          <button type="button" className="chat-agent-picker-close" onClick={() => setAgentPicker(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className={`chat-workspace ${props.historyOpen ? "history-open" : "history-closed"}`}>
        {props.historyOpen && (
          <aside className="chat-history-panel" aria-label="Chat history">
            {props.mode !== "emergency" && (
              <div className="chat-history-actions">
                <button type="button" className="chat-history-new" onClick={() => openAgentPicker()}>
                  <PlusIcon />
                  <span>New chat</span>
                </button>
                <button type="button" className="chat-history-new" onClick={() => setProjectComposerOpen((current) => !current)}>
                  <PlusIcon />
                  <span>New project</span>
                </button>
              </div>
            )}
            {projectComposerOpen && (
              <form
                className="chat-project-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitProject();
                }}
              >
                <input
                  autoFocus
                  value={projectDraft}
                  onChange={(event) => setProjectDraft(event.target.value)}
                  placeholder="Project name"
                />
                <div>
                  <button type="submit">Create</button>
                  <button
                    type="button"
                    onClick={() => {
                      setProjectComposerOpen(false);
                      setProjectDraft("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {pinnedThreads.length > 0 && (
              <section>
                <span>Pinned</span>
                {pinnedThreads.map(renderHistoryThread)}
              </section>
            )}
            <section>
              <span>Chats</span>
              {unprojectedThreads.length > 0 ? unprojectedThreads.map(renderHistoryThread) : <p className="chat-history-empty">No unprojected chats.</p>}
            </section>
            <section>
              <span>Projects</span>
              {sortedProjects.length > 0 ? sortedProjects.map(renderProject) : <p className="chat-history-empty">No projects yet.</p>}
            </section>
          </aside>
        )}

        <div className="chat-conversation">
          <div className="message-stack">
            {props.activeThread?.messages.map((message) => (
              <article
                key={message.id}
                className={`message-bubble ${message.role === "assistant" ? "assistant" : "user"} ${message.status === "interrupted" ? "interrupted" : ""} ${
                  message.status === "failed" ? "failed" : ""
                }`}
              >
            <div className="message-meta">
              <strong>{message.author}</strong>
              <span>
                {message.status === "interrupted" ? "Interrupted · " : ""}
                {message.status === "failed" ? "Failed · " : ""}
                {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <MessageContent content={message.content} />
            {message.archiveCitations?.length ? (
              <div className="archive-citations" aria-label="Living Archive citations">
                <span>Archive memory</span>
                {message.archiveCitations.map((citation) => (
                  <button key={`${message.id}:${citation.path}`} type="button" title={citation.path}>
                    {citation.title}
                    <small>{citation.pageType}</small>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="message-actions" aria-label={`${message.role} message actions`}>
              <button
                type="button"
                className={`message-action-button ${copiedMessageId === message.id ? "copied" : ""}`}
                aria-label={copiedMessageId === message.id ? "Message copied" : "Copy message"}
                title={copiedMessageId === message.id ? "Copied" : "Copy message"}
                onClick={() => void copyMessage(message)}
              >
                {copiedMessageId === message.id ? <CheckIcon /> : <CopyIcon />}
              </button>
              <button type="button" className="message-action-button" aria-label="Branch chat after this message" title="Branch chat after this message" onClick={() => props.onBranchFromMessage(message)}>
                <BranchIcon />
              </button>
              {message.role === "user" ? (
                <button type="button" className="message-action-button" aria-label="Edit message" title="Edit message" onClick={() => props.onEditUserMessage(message)}>
                  <EditIcon />
                </button>
              ) : null}
              {props.mode === "strategist" && message.role === "assistant" ? (
                <>
                  <button
                    type="button"
                    className="message-action-button"
                    aria-label="Save message to Living Archive"
                    title="Save message to Living Archive"
                    onClick={() => props.onSaveMessageToArchive(message)}
                  >
                    <ArchiveIcon />
                  </button>
                  {message.providerUsage?.source === "local-runtime" ? (
                    <button
                      type="button"
                      className="message-action-button"
                      aria-label="Generation stats"
                      title={generationStatsTitle(message)}
                    >
                      <StatsIcon />
                    </button>
                  ) : null}
                </>
              ) : null}
              <button type="button" className="message-action-button danger" aria-label="Delete message" title="Delete message" onClick={() => props.onDeleteMessage(message)}>
                <TrashIcon />
              </button>
            </div>
              </article>
            ))}
            {props.chatBusy && (
              <div className="chat-run-status-card" aria-live="polite">
                <div className="chat-run-status-head">
                  <span className="agent-activity-pulse" />
                  <strong>Working for {formatElapsed(activeRunStartedAt)}</strong>
                  <small>{phaseLabel(props.chatRunPhase)}</small>
                </div>
                <div className="chat-run-events">
                  {(props.chatRunEvents.length
                    ? props.chatRunEvents
                    : [
                        {
                          id: "fallback",
                          runId: "fallback",
                          createdAt: new Date().toISOString(),
                          phase: props.chatRunPhase === "idle" ? "thinking" : props.chatRunPhase,
                          label: props.activityLabel,
                          transient: true,
                        } satisfies ChatRunEvent,
                      ]
                  ).map((event) => (
                    <div key={event.id} className={`chat-run-event phase-${event.phase}`}>
                      <span>{eventPhaseLabel(event)}</span>
                      <div>
                        <strong>{event.label}</strong>
                        {event.detail ? <small>{event.detail}</small> : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="chat-run-status-foot">
                  <small>{formatElapsed(activeRunStartedAt)}</small>
                </div>
              </div>
            )}
            <div ref={props.chatScrollAnchorRef} />
          </div>

          <div className="composer-card">
        {props.chatNotice && <div className="inline-notice warning">{props.chatNotice}</div>}
        {contextPanelOpen && (
          <ContextMemoryPanel
            budget={props.contextBudget}
            compactState={props.compactState}
            usageLabel={props.contextUsageLabel}
            usageRatio={props.contextUsageRatio}
            usageTitle={props.contextUsageTitle}
            onCompactThread={props.onCompactThread}
            onUpdateCompactMemory={props.onUpdateCompactMemory}
          />
        )}
        <textarea
          value={props.composer}
          onChange={(event) => props.onComposerChange(event.target.value)}
          placeholder={`Message ${props.title}`}
          rows={4}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSend();
            }
          }}
        />
        <div className="chat-toolbar">
          <div className="chat-toolbar-main">
            <button
              type="button"
              className="chat-icon-button"
              aria-label="Attach file"
              title="Attach file"
              onClick={() => props.fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className={`context-pill ${props.contextUsageRatio > 0.72 ? "warning" : ""}`}
              title={props.contextUsageTitle}
              aria-label={`Context usage ${props.contextUsageLabel}. Open context memory map.`}
              aria-expanded={contextPanelOpen}
              onClick={() => setContextPanelOpen((current) => !current)}
            >
              <strong>{props.contextUsageLabel}</strong>
            </button>
            <input
              ref={props.fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => void props.onFileAttach(event.target.files)}
            />
          </div>
          <div className="chat-toolbar-selects">
            <div className="chat-control compact">
              <select
                aria-label="Model and reasoning profile"
                title="Model route. Reasoning controls are shown only when model capability metadata exists."
                value={props.activeChatModel}
                onChange={(event) => props.onModelChange(event.target.value)}
              >
                {props.availableModels.map((model) => (
                  <option key={model} value={model}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
            </div>
            {supportsThinkingDepth(props.activeChatModel) && (
              <div className="chat-control compact">
                <select
                  aria-label="Thinking level"
                  title="Reasoning effort for GPT routes"
                  value={props.thinkingDepth}
                  onChange={(event) => props.onThinkingDepthChange(event.target.value as ThinkingDepth)}
                >
                  <option value="minimal">Minimal thinking</option>
                  <option value="medium">Medium thinking</option>
                  <option value="high">High thinking</option>
                </select>
              </div>
            )}
          </div>
          <button
            type="button"
            className={`chat-icon-button ${props.dictating ? "is-live" : ""}`}
            aria-label={props.dictating ? "Stop dictation" : "Start dictation"}
            title={
              props.dictationAvailable
                ? props.dictating
                  ? "Stop dictation"
                  : "Start dictation"
                : "Audio dictate is not available in this browser context."
            }
            onClick={props.onToggleDictation}
            disabled={!props.dictationAvailable}
          >
            <MicIcon />
          </button>
          {props.chatBusy ? (
            <button
              type="button"
              className="chat-stop-button"
              aria-label="Stop response"
              title={
                props.chatSupportsAbort
                  ? "Stop response, request provider cancellation, and keep the interrupted partial message"
                  : "Stop response locally and keep the interrupted partial message"
              }
              onClick={props.onStopGeneration}
              disabled={!props.chatCanStop}
            >
              <StopIcon />
            </button>
          ) : (
            <button type="button" className="chat-send-button" aria-label="Send message" title="Send message" onClick={props.onSend}>
              <SendIcon />
            </button>
          )}
        </div>
        {props.attachments.length > 0 && (
          <div className="attachment-strip">
            {props.attachments.map((attachment) => (
              <div key={attachment.id} className="attachment-chip">
                <div>
                  <strong>{attachment.name}</strong>
                  <span>
                    {formatBytes(attachment.size)} · {attachment.previewState === "embedded" ? "embedded" : "metadata"}
                  </span>
                </div>
                <button type="button" onClick={() => props.onRemoveAttachment(attachment.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
          </div>
        </div>
      </div>
    </aside>
  );
}
