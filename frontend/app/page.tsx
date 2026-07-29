"use client";

import {
  type ChangeEvent,
  FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Avatar, type AvatarHandle } from "@/components/Avatar";
import { AvatarCustomizer } from "@/components/AvatarCustomizer";
import { ChatLog, type ChatMessage } from "@/components/ChatLog";
import { MicButton } from "@/components/MicButton";
import {
  ChatWebSocketClient,
  type ConnectionState,
  type ServerMessage,
  type TimedViseme,
} from "@/lib/wsClient";
import {
  DEFAULT_VOICE_ID,
  isVoiceId,
  type VoiceId,
} from "@/lib/voices";
import { validateAvatarGlb } from "@/lib/avatarValidation";

type AvatarState = "idle" | "listening" | "thinking" | "speaking";

interface AvatarChoice {
  custom: boolean;
  name: string;
  url: string | null;
}

interface VoicePreviewResponse {
  audio?: string;
  error?: string;
  text?: string;
  visemes?: TimedViseme[];
}

const MAX_AVATAR_BYTES = 50 * 1024 * 1024;
const VOICE_STORAGE_KEY = "pitb-avatar-voice";
const CHAT_HEIGHT_STORAGE_KEY = "pitb-avatar-chat-height";
const CHAT_PANEL_MIN_HEIGHT = 360;
const CHAT_PANEL_DEFAULT_HEIGHT = 430;
const CHAT_PANEL_MAX_HEIGHT = 680;

function clampChatPanelHeight(height: number): number {
  return Math.min(
    CHAT_PANEL_MAX_HEIGHT,
    Math.max(CHAT_PANEL_MIN_HEIGHT, height),
  );
}

function websocketUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (configuredUrl) return configuredUrl;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws`;
}

const stateCopy: Record<AvatarState, string> = {
  idle: "Ready to chat",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export default function HomePage() {
  const avatarRef = useRef<AvatarHandle>(null);
  const clientRef = useRef<ChatWebSocketClient | null>(null);
  const activeResponseIdRef = useRef<string | null>(null);
  const streamOperationsRef = useRef<Promise<void>>(Promise.resolve());
  const cancelledResponseIdsRef = useRef(new Set<string>());
  const customAvatarUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef<AbortController | null>(null);
  const chatResizeStartRef = useRef({ height: CHAT_PANEL_DEFAULT_HEIGHT, y: 0 });
  const resizingChatRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [documents, setDocuments] = useState<string[]>([]);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [documentStatus, setDocumentStatus] = useState("");
  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [avatarReady, setAvatarReady] = useState(false);
  const [validatingAvatar, setValidatingAvatar] = useState(false);
  const [avatarChoice, setAvatarChoice] = useState<AvatarChoice>({
    custom: false,
    name: "No avatar selected",
    url: null,
  });
  const [avatarStatus, setAvatarStatus] = useState("Upload a compatible GLB avatar to begin.");
  const [selectedVoice, setSelectedVoice] = useState<VoiceId>(DEFAULT_VOICE_ID);
  const [previewingVoice, setPreviewingVoice] = useState<VoiceId | null>(null);
  const [chatPanelHeight, setChatPanelHeight] = useState(CHAT_PANEL_DEFAULT_HEIGHT);
  const [resizingChat, setResizingChat] = useState(false);

  const addMessage = (role: ChatMessage["role"], content: string) => {
    setMessages((current) => [...current, { id: crypto.randomUUID(), role, content }]);
  };

  useEffect(() => {
    const handleMessage = (message: ServerMessage) => {
      if (
        "response_id" in message
        && cancelledResponseIdsRef.current.has(message.response_id)
      ) return;
      if (message.type === "transcription") {
        addMessage("user", message.text);
        return;
      }
      if (message.type === "error") {
        avatarRef.current?.cancelStream();
        streamOperationsRef.current = Promise.resolve();
        const activeResponseId = activeResponseIdRef.current;
        if (activeResponseId) {
          setMessages((current) => current.filter(
            (item) => item.id !== activeResponseId || item.content.length > 0,
          ));
          activeResponseIdRef.current = null;
        }
        addMessage("system", message.message);
        setAvatarState("idle");
        return;
      }
      if (message.type === "response_start") {
        activeResponseIdRef.current = message.response_id;
        setMessages((current) => [
          ...current,
          { id: message.response_id, role: "assistant", content: "" },
        ]);
        streamOperationsRef.current = Promise.resolve(
          avatarRef.current?.startStream(message.sample_rate),
        ).then(() => undefined);
        return;
      }
      if (message.type === "response_delta") {
        setMessages((current) => current.map((item) => (
          item.id === message.response_id
            ? { ...item, content: item.content + message.text }
            : item
        )));
        return;
      }
      if (message.type === "response_audio") {
        streamOperationsRef.current = streamOperationsRef.current.then(
          () => avatarRef.current?.pushStreamAudio(message.audio, message.text),
        ).then(() => undefined);
        return;
      }
      if (message.type === "response_viseme") {
        streamOperationsRef.current = streamOperationsRef.current.then(
          () => avatarRef.current?.pushStreamViseme(message.viseme),
        ).then(() => undefined);
        return;
      }
      if (message.type === "response_end") {
        setMessages((current) => current.map((item) => (
          item.id === message.response_id ? { ...item, content: message.text } : item
        )));
        activeResponseIdRef.current = null;
        if (message.has_audio) {
          streamOperationsRef.current = streamOperationsRef.current.then(
            () => avatarRef.current?.endStream(),
          ).then(() => undefined);
        } else {
          avatarRef.current?.cancelStream();
          setAvatarState("idle");
        }
        return;
      }
      // Compatibility with the original single-message backend protocol.
      addMessage("assistant", message.text);
      if (!message.audio) {
        setAvatarState("idle");
        return;
      }
      setAvatarState("speaking");
      void avatarRef.current?.speak(message).then((started) => {
        if (!started) setAvatarState("idle");
      });
    };
    const client = new ChatWebSocketClient(websocketUrl(), { onMessage: handleMessage, onStateChange: setConnection });
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedVoice = window.localStorage.getItem(VOICE_STORAGE_KEY);
      if (isVoiceId(savedVoice)) setSelectedVoice(savedVoice);
      const savedChatHeight = Number(
        window.localStorage.getItem(CHAT_HEIGHT_STORAGE_KEY),
      );
      if (Number.isFinite(savedChatHeight) && savedChatHeight > 0) {
        setChatPanelHeight(clampChatPanelHeight(savedChatHeight));
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      previewRequestRef.current?.abort();
      if (customAvatarUrlRef.current) URL.revokeObjectURL(customAvatarUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const storageKey = "pitb-avatar-workspace-id";
    const timer = window.setTimeout(() => {
      const existing = window.localStorage.getItem(storageKey);
      const next = existing || crypto.randomUUID();
      if (!existing) window.localStorage.setItem(storageKey, next);
      setWorkspaceId(next);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    if (connection === "connected") {
      clientRef.current?.setSessionConfig(systemPrompt, workspaceId, selectedVoice);
    }
    void fetch(`/api/documents?workspace_id=${encodeURIComponent(workspaceId)}`)
      .then(async (response) => response.ok ? response.json() as Promise<{ documents?: string[] }> : null)
      .then((payload) => { if (payload?.documents) setDocuments(payload.documents); })
      .catch(() => undefined);
  }, [connection, selectedVoice, systemPrompt, workspaceId]);

  const uploadDocument = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !workspaceId) return;
    setUploadingDocument(true);
    setDocumentStatus("Indexing document...");
    try {
      const form = new FormData();
      form.append("workspace_id", workspaceId);
      form.append("file", file);
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const payload = await response.json() as { document?: string; chunks?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || "Document upload failed.");
      setDocuments((current) => [...new Set([...current, payload.document || file.name])].sort());
      setDocumentStatus(`${payload.document || file.name} is ready for questions.`);
    } catch (error) {
      setDocumentStatus(error instanceof Error ? error.message : "Document upload failed.");
    } finally {
      setUploadingDocument(false);
    }
  };

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".glb")) {
      setAvatarStatus("Please choose a .glb avatar file.");
      addMessage("system", "That avatar was not loaded. Please choose a .glb file.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarStatus("This file is larger than the 50 MB limit.");
      addMessage("system", "That avatar is too large. Please use a GLB file under 50 MB.");
      return;
    }

    setValidatingAvatar(true);
    setAvatarStatus("Checking avatar compatibility...");
    const validation = await validateAvatarGlb(file);
    setValidatingAvatar(false);
    if (!validation.valid) {
      const message = validation.error || "This GLB is not compatible with the talking-avatar engine.";
      setAvatarStatus(message);
      addMessage("system", message);
      return;
    }

    previewRequestRef.current?.abort();
    avatarRef.current?.cancelStream();
    const previousUrl = customAvatarUrlRef.current;
    const url = URL.createObjectURL(file);
    customAvatarUrlRef.current = url;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setAvatarReady(false);
    setAvatarState("idle");
    setPreviewingVoice(null);
    setAvatarStatus("Loading your 3D avatar…");
    setAvatarChoice({ custom: true, name: file.name, url });
  };

  const resetAvatar = () => {
    previewRequestRef.current?.abort();
    avatarRef.current?.cancelStream();
    const previousUrl = customAvatarUrlRef.current;
    customAvatarUrlRef.current = null;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setAvatarReady(false);
    setAvatarState("idle");
    setPreviewingVoice(null);
    setAvatarStatus("Upload a compatible GLB avatar to begin.");
    setAvatarChoice({
      custom: false,
      name: "No avatar selected",
      url: null,
    });
  };

  const selectVoice = (voiceId: VoiceId) => {
    setSelectedVoice(voiceId);
    window.localStorage.setItem(VOICE_STORAGE_KEY, voiceId);
    if (workspaceId) {
      clientRef.current?.setSessionConfig(systemPrompt, workspaceId, voiceId);
    }
  };

  const previewVoice = async (voiceId: VoiceId) => {
    previewRequestRef.current?.abort();
    avatarRef.current?.cancelStream();
    void avatarRef.current?.unlockAudio();
    const controller = new AbortController();
    previewRequestRef.current = controller;
    setPreviewingVoice(voiceId);
    try {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId }),
        signal: controller.signal,
      });
      const payload = await response.json() as VoicePreviewResponse;
      if (!response.ok || !payload.audio || !payload.text || !payload.visemes) {
        throw new Error(payload.error || "The voice preview could not be played.");
      }
      setAvatarState("speaking");
      const started = await avatarRef.current?.speak({
        type: "response",
        text: payload.text,
        audio: payload.audio,
        visemes: payload.visemes,
      });
      if (!started) {
        setAvatarState("idle");
        setPreviewingVoice(null);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setAvatarState("idle");
      setPreviewingVoice(null);
      addMessage(
        "system",
        error instanceof Error ? error.message : "The voice preview could not be played.",
      );
    } finally {
      if (previewRequestRef.current === controller) previewRequestRef.current = null;
    }
  };

  const sendText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || avatarState !== "idle") return;
    // TalkingHead creates its 24 kHz AudioContext inside streamStart. Starting
    // it from this click keeps Chrome's autoplay permission attached to the
    // context that will actually play the streamed PCM.
    void avatarRef.current?.startStream(24_000);
    clientRef.current?.setSessionConfig(systemPrompt, workspaceId, selectedVoice);
    if (!clientRef.current?.sendText(text)) {
      addMessage("system", "Connecting to the avatar server. Please try again in a moment.");
      return;
    }
    addMessage("user", text);
    setDraft("");
    setAvatarState("thinking");
  };

  const handleAudioReady = (audio: Blob) => {
    clientRef.current?.setSessionConfig(systemPrompt, workspaceId, selectedVoice);
    if (!clientRef.current?.sendAudio(audio)) {
      addMessage("system", "Connecting to the avatar server. Please try again in a moment.");
      setAvatarState("idle");
      return;
    }
    setAvatarState("thinking");
  };

  const interruptForUserSpeech = () => {
    const activeResponseId = activeResponseIdRef.current;
    if (activeResponseId) {
      cancelledResponseIdsRef.current.add(activeResponseId);
      setMessages((current) => current.filter((item) => item.id !== activeResponseId));
      activeResponseIdRef.current = null;
    }
    clientRef.current?.cancelTurn();
    avatarRef.current?.cancelStream();
    streamOperationsRef.current = Promise.resolve();
    setAvatarState("listening");
  };

  const setAndStoreChatPanelHeight = (height: number) => {
    const nextHeight = clampChatPanelHeight(height);
    setChatPanelHeight(nextHeight);
    window.localStorage.setItem(CHAT_HEIGHT_STORAGE_KEY, String(nextHeight));
  };

  const startChatResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    chatResizeStartRef.current = {
      height: chatPanelHeight,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    resizingChatRef.current = true;
    setResizingChat(true);
  };

  const moveChatResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingChatRef.current) return;
    const nextHeight = chatResizeStartRef.current.height
      + event.clientY
      - chatResizeStartRef.current.y;
    setChatPanelHeight(clampChatPanelHeight(nextHeight));
  };

  const finishChatResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingChatRef.current) return;
    const nextHeight = clampChatPanelHeight(
      chatResizeStartRef.current.height
        + event.clientY
        - chatResizeStartRef.current.y,
    );
    resizingChatRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setChatPanelHeight(nextHeight);
    setResizingChat(false);
    window.localStorage.setItem(CHAT_HEIGHT_STORAGE_KEY, String(nextHeight));
  };

  const resizeChatWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextHeight: number | null = null;
    if (event.key === "ArrowDown") nextHeight = chatPanelHeight + 32;
    if (event.key === "ArrowUp") nextHeight = chatPanelHeight - 32;
    if (event.key === "Home") nextHeight = CHAT_PANEL_MIN_HEIGHT;
    if (event.key === "End") nextHeight = CHAT_PANEL_MAX_HEIGHT;
    if (nextHeight === null) return;
    event.preventDefault();
    setAndStoreChatPanelHeight(nextHeight);
  };

  const busy = avatarState === "thinking" || avatarState === "speaking";
  const setupPanelHeight = CHAT_PANEL_MAX_HEIGHT - chatPanelHeight;
  const showSetupPanels = setupPanelHeight >= 72;

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl items-center p-4 sm:p-8">
      <section className="grid w-full gap-6 rounded-[2rem] border border-slate-700/70 bg-slate-900/70 p-4 shadow-2xl backdrop-blur sm:p-6 lg:grid-cols-[1.04fr_.96fr]">
        <div>
          <div className="relative">
            <Avatar
              avatarUrl={avatarChoice.url}
              onError={(message) => {
                setAvatarReady(false);
                setAvatarStatus("Avatar loading failed.");
                addMessage("system", message);
              }}
              onReady={() => {
                setAvatarReady(true);
                setAvatarStatus("Your avatar is loaded and ready");
              }}
              onSpeechStart={() => setAvatarState("speaking")}
              onSpeechEnd={() => {
                setAvatarState("idle");
                setPreviewingVoice(null);
              }}
              ref={avatarRef}
            />
            <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full bg-slate-950/75 px-3 py-1.5 text-xs font-medium backdrop-blur">
              <span className={`h-2 w-2 rounded-full ${avatarState === "listening" ? "bg-rose-400" : avatarState === "speaking" ? "bg-cyan-300" : "bg-emerald-400"}`} />
              {stateCopy[avatarState]}
            </div>
          </div>
          <AvatarCustomizer
            avatarName={avatarChoice.name}
            avatarStatus={avatarStatus}
            avatarDisabled={
              busy
              || previewingVoice !== null
              || validatingAvatar
              || (avatarChoice.url !== null && !avatarReady)
            }
            customAvatar={avatarChoice.custom}
            onAvatarUpload={uploadAvatar}
            onPreviewVoice={(voiceId) => { void previewVoice(voiceId); }}
            onResetAvatar={resetAvatar}
            onSelectVoice={selectVoice}
            previewingVoice={previewingVoice}
            selectedVoice={selectedVoice}
            voiceDisabled={!avatarReady || busy || previewingVoice !== null || validatingAvatar}
          />
        </div>

        <div className="flex min-h-[680px] min-w-0 flex-col rounded-3xl bg-slate-950/50 p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">PITB Avatar</p>
              <h1 className="mt-1 text-2xl font-semibold text-white">Your personal AI avatar</h1>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs ${connection === "connected" ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200"}`}>
              {connection}
            </span>
          </div>

          <div
            aria-hidden={!showSetupPanels}
            className={`order-3 min-h-0 overflow-y-auto transition-[max-height,opacity] duration-200 ${
              showSetupPanels ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            style={{ maxHeight: setupPanelHeight }}
          >
            {showSetupPanels && (
              <div className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
            <button
              className="flex w-full items-center justify-between text-left text-sm font-semibold text-cyan-200"
              onClick={() => setShowInstructions((visible) => !visible)}
              type="button"
            >
              <span>Avatar instructions</span>
              <span className="text-xs text-slate-400">{showInstructions ? "Hide" : "Set role"}</span>
            </button>
            {showInstructions && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-slate-400">Set the avatar&apos;s role for this conversation. For example: “You are a professional science teacher. Explain concepts simply.”</p>
                <textarea
                  aria-label="System prompt"
                  className="min-h-24 w-full resize-y rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-cyan-400"
                  maxLength={4_000}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  placeholder="You are a helpful professional..."
                  value={systemPrompt}
                />
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-cyan-200">Knowledge documents</p>
                <p className="mt-1 text-xs text-slate-400">Upload PDF, TXT, Markdown, CSV, JSON, or HTML files for grounded answers.</p>
              </div>
              <label className="shrink-0 cursor-pointer rounded-xl bg-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-600">
                {uploadingDocument ? "Indexing..." : "Upload"}
                <input
                  accept=".pdf,.txt,.md,.csv,.json,.html,text/plain,text/markdown,application/pdf"
                  className="sr-only"
                  disabled={uploadingDocument}
                  onChange={uploadDocument}
                  type="file"
                />
              </label>
            </div>
            {documents.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {documents.map((document) => (
                  <span className="rounded-full bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-200" key={document}>{document}</span>
                ))}
              </div>
            )}
            {documentStatus && <p className="mt-2 text-xs text-slate-400">{documentStatus}</p>}
          </div>
              </div>
            )}
          </div>

          <div
            className="order-1 flex shrink-0 flex-col rounded-2xl border border-slate-800 bg-slate-950/30 p-3 sm:p-4"
            style={{ height: chatPanelHeight }}
          >
            <ChatLog messages={messages} />

          <form className="mt-4 flex gap-2 border-t border-slate-800 pt-4" onSubmit={sendText}>
            <input
              aria-label="Message"
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-cyan-400"
              disabled={busy || !avatarReady}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={avatarReady ? "Type a message…" : "Upload an avatar first…"}
              value={draft}
            />
            <MicButton
              disabled={!avatarReady}
              onInteract={() => {
                void avatarRef.current?.unlockAudio().then(() => avatarRef.current?.startStream(24_000));
              }}
              onAudioReady={handleAudioReady}
              onError={(message) => addMessage("system", message)}
              onRecordingChange={(recording) => setAvatarState((current) => (
                recording ? "listening" : current === "listening" ? "idle" : current
              ))}
              onSpeechDetected={() => {
                if (avatarState === "speaking" || avatarState === "thinking") interruptForUserSpeech();
              }}
            />
            <button
              className="rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!draft.trim() || busy || !avatarReady}
              type="submit"
            >
              Send
            </button>
            </form>
          </div>

          <div
            aria-label="Resize conversation panel"
            aria-orientation="horizontal"
            aria-valuemax={CHAT_PANEL_MAX_HEIGHT}
            aria-valuemin={CHAT_PANEL_MIN_HEIGHT}
            aria-valuenow={Math.round(chatPanelHeight)}
            className={`group relative order-2 flex h-8 shrink-0 touch-none cursor-row-resize items-center justify-center outline-none ${
              resizingChat ? "text-cyan-200" : "text-slate-500"
            } focus-visible:ring-2 focus-visible:ring-cyan-400/70`}
            onDoubleClick={() => setAndStoreChatPanelHeight(CHAT_PANEL_DEFAULT_HEIGHT)}
            onKeyDown={resizeChatWithKeyboard}
            onLostPointerCapture={() => {
              resizingChatRef.current = false;
              setResizingChat(false);
            }}
            onPointerCancel={finishChatResize}
            onPointerDown={startChatResize}
            onPointerMove={moveChatResize}
            onPointerUp={finishChatResize}
            role="separator"
            tabIndex={0}
            title="Drag to resize the conversation panel. Double-click to reset."
          >
            <span className="h-1.5 w-20 rounded-full bg-slate-700 transition group-hover:bg-cyan-400 group-focus-visible:bg-cyan-400" />
            <span className="sr-only">Use the up and down arrow keys to resize the conversation panel.</span>
          </div>
        </div>
      </section>
    </main>
  );
}
